import { DurableObject } from 'cloudflare:workers';
import { REST } from '@discordjs/rest';
import { dispatch } from '@flue/runtime';
import haloCreator from './agents/halo-creator.ts';
import {
  addOwnReaction,
  conversationKey,
  createDiscordRest,
  parseGatewayBotResponse,
  parseGatewayFrame,
  parseHelloData,
  parseMessageCreate,
  parseReadyData,
  REACTION,
  removeOwnReaction,
  sendChannelMessage,
  stripMention,
  triggerTyping,
} from './shared/discord.ts';
import { redact } from './shared/redacted.ts';

// GUILD_MESSAGES (1 << 9) | MESSAGE_CONTENT (1 << 15)
const GATEWAY_INTENTS = (1 << 9) | (1 << 15);
const DO_NAME = 'default';
// Drop dedup records well past any Gateway RESUME replay window.
const PROCESSED_MESSAGE_TTL_MS = 60 * 60 * 1000;
// A turn that never posts a reply leaves its 👀 unanswered. After this window
// the gateway treats the message as failed (❌). Set well above a normal turn so
// a slow-but-succeeding reply is never marked failed.
const REACTION_FAILURE_MS = 90 * 1000;

interface Env {
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
  DISCORD_BOT_TOKEN: string;
}

// Maintains a single Discord Gateway WebSocket connection for the Worker.
// Heartbeats run on Durable Object alarms; a Cron Trigger pokes /ensure every
// few minutes so the connection is re-established if the DO was evicted.
// On a MESSAGE_CREATE that mentions the bot, it dispatches the text to the
// halo-creator agent, which replies via its bound post_discord_message tool.
export class DiscordGateway extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private heartbeatInterval = 45000;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botId: string | null = null;
  private heartbeatAcked = true;
  private connecting = false;
  private restClient: REST | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS processed_message (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)',
    );
    // Maps a dispatched submission to the Discord message that triggered it. A
    // successful reply clears the row via `markReplied` (👀 → ✅); the alarm
    // sweep marks anything left unanswered as failed (👀 → ❌).
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS pending_reaction (
         dispatch_id TEXT PRIMARY KEY,
         instance_id TEXT NOT NULL,
         channel_id TEXT NOT NULL,
         message_id TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
  }

  private rest(): REST {
    this.restClient ??= createDiscordRest(redact(this.env.DISCORD_BOT_TOKEN));
    return this.restClient;
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/ensure') {
      // Own the connect for the request lifetime so eviction cannot drop it.
      this.ctx.waitUntil(this.ensureConnected());
      return new Response('ok');
    }
    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    // Connection dropped (or never opened): reconnect.
    if (!this.ws || this.ws.readyState > 1) {
      this.ws = null;
      await this.ensureConnected();
      return;
    }
    // Missed the last ACK: the connection is zombie. Reconnect (resumes if the
    // session is still valid).
    if (!this.heartbeatAcked) {
      console.warn('[discord-gateway] missed heartbeat ACK, reconnecting');
      await this.reconnect();
      return;
    }
    this.heartbeatAcked = false;
    this.send({ op: 1, d: this.seq });
    this.pruneProcessedMessages();
    await this.sweepFailedReactions();
    this.ctx.storage.setAlarm(Date.now() + this.heartbeatInterval);
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return;
    if (this.connecting) return;
    this.connecting = true;
    try {
      await this.connectGateway();
    } catch (err) {
      console.error('[discord-gateway] connect failed', err);
      this.ctx.storage.setAlarm(Date.now() + 5000);
    } finally {
      this.connecting = false;
    }
  }

  private async reconnect(): Promise<void> {
    this.closeExisting();
    try {
      await this.connectGateway();
    } catch (err) {
      console.error('[discord-gateway] reconnect failed', err);
      this.ctx.storage.setAlarm(Date.now() + 5000);
    }
  }

  private async connectGateway(): Promise<void> {
    this.closeExisting();
    const token = this.env.DISCORD_BOT_TOKEN;
    if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');

    const gwRes = await fetch('https://discord.com/api/v10/gateway/bot', {
      headers: { authorization: `Bot ${token}` },
    });
    if (!gwRes.ok) throw new Error(`gateway/bot ${gwRes.status}: ${await gwRes.text()}`);
    const gw = parseGatewayBotResponse(await gwRes.json());
    if (!gw) throw new Error('gateway/bot returned an unexpected body');
    // Cloudflare Workers fetch() with WebSocket upgrade requires https://,
    // not wss://. Discord returns a wss:// URL, so swap the scheme.
    const rawGatewayUrl = (this.resumeGatewayUrl ?? gw.url) + '?v=10&encoding=json';
    const gatewayUrl = rawGatewayUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

    const res = await fetch(gatewayUrl, { headers: { upgrade: 'websocket' } });
    const ws = res.webSocket;
    if (!ws) throw new Error('gateway did not negotiate a websocket');
    ws.accept();
    this.ws = ws;
    this.heartbeatAcked = true;

    ws.addEventListener('message', (e) => {
      void this.onMessage(typeof e.data === 'string' ? e.data : '');
    });
    ws.addEventListener('close', (e) => {
      void this.onClose(e.code, e.reason);
    });
    ws.addEventListener('error', () => {
      void this.onClose(1006, 'error');
    });
  }

  private async onMessage(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const p = parseGatewayFrame(json);
    if (!p) return;
    if (p.s !== null && p.s !== undefined) this.seq = p.s;

    switch (p.op) {
      case 10: {
        // HELLO
        const hello = parseHelloData(p.d);
        if (!hello) {
          console.warn('[discord-gateway] malformed HELLO, reconnecting');
          await this.reconnect();
          break;
        }
        this.heartbeatInterval = hello.heartbeat_interval;
        this.ctx.storage.setAlarm(Date.now() + this.heartbeatInterval);
        if (this.sessionId && this.seq !== null) {
          this.send({
            op: 6,
            d: { token: this.env.DISCORD_BOT_TOKEN, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.send({
            op: 2,
            d: {
              token: this.env.DISCORD_BOT_TOKEN,
              intents: GATEWAY_INTENTS,
              properties: { os: 'linux', browser: 'flue', device: 'flue' },
            },
          });
        }
        break;
      }
      case 11: // HEARTBEAT ACK
        this.heartbeatAcked = true;
        break;
      case 1: // server-requested immediate heartbeat
        this.send({ op: 1, d: this.seq });
        break;
      case 7: // RECONNECT
        await this.reconnect();
        break;
      case 9: // INVALID_SESSION
        if (p.d !== true) {
          this.sessionId = null;
          this.seq = null;
        }
        this.closeExisting();
        this.ctx.storage.setAlarm(Date.now() + 3000);
        break;
      case 0: // dispatched event
        await this.onEvent(p.t ?? null, p.d);
        break;
    }
  }

  private async onEvent(t: string | null, d: unknown): Promise<void> {
    switch (t) {
      case 'READY': {
        const ready = parseReadyData(d);
        if (!ready) break;
        this.sessionId = ready.session_id;
        this.resumeGatewayUrl = ready.resume_gateway_url;
        this.botId = ready.user.id;
        console.log('[discord-gateway] READY as', this.botId);
        break;
      }
      case 'MESSAGE_CREATE':
        await this.onMessageCreate(d);
        break;
      default:
        break;
    }
  }

  private async onMessageCreate(raw: unknown): Promise<void> {
    if (!this.botId) return;
    const m = parseMessageCreate(raw);
    if (!m) return;
    if (m.author?.bot) return;
    const mentioned = m.mentions?.some((u) => u.id === this.botId) ?? false;
    if (!mentioned) return;

    const text = stripMention(m.content ?? '', this.botId);
    if (!text) return;

    // At-most-once: a message already claimed by a prior delivery (e.g. a
    // Gateway RESUME replay) is not dispatched again.
    if (!this.claimMessage(m.id)) return;

    const channelId = m.channel_id;
    const messageId = m.id;
    const rest = this.rest();
    // Acknowledge the mention immediately. Awaited so the 👀 is present before a
    // fast completion could try to swap it for ✅/❌.
    await this.safeDiscord(() => addOwnReaction(rest, channelId, messageId, REACTION.working));
    await this.safeDiscord(() => triggerTyping(rest, channelId));

    const key = conversationKey({ guildId: m.guild_id ?? null, channelId });
    try {
      const receipt = await dispatch(haloCreator, {
        id: key,
        input: {
          type: 'discord.mention',
          text,
          author: m.author?.username ?? 'unknown',
          messageId,
          channelId,
        },
      });
      this.recordPendingReaction(receipt.dispatchId, key, channelId, messageId);
    } catch (err) {
      // Admission itself failed: there will be no completion event, so react now.
      console.error('[discord-gateway] dispatch failed', err);
      await this.reactFailure(channelId, messageId, err instanceof Error ? err.message : String(err));
    }
  }

  // Called over RPC from the agent's post_discord_message tool once it posts a
  // reply, so a successful turn flips 👀 → ✅ on the triggering message. The tool
  // knows only its channel; the gateway holds the message id. Flue processes one
  // instance's dispatches in order, so the oldest pending entry for the channel
  // is the turn being answered.
  async markReplied(channelId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec(
        'SELECT dispatch_id, message_id FROM pending_reaction WHERE channel_id = ? ORDER BY created_at ASC LIMIT 1',
        channelId,
      )
      .toArray()[0];
    if (!row) return;
    sql.exec('DELETE FROM pending_reaction WHERE dispatch_id = ?', String(row.dispatch_id));
    const messageId = String(row.message_id);
    const rest = this.rest();
    await this.safeDiscord(() => removeOwnReaction(rest, channelId, messageId, REACTION.working));
    await this.safeDiscord(() => addOwnReaction(rest, channelId, messageId, REACTION.done));
  }

  // Turns that never posted a reply (model/gateway error, exhausted retries)
  // leave their 👀 unanswered. Flip anything past the failure window to ❌ with a
  // note so a message never sits on 👀 forever.
  private async sweepFailedReactions(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const stale = sql
      .exec(
        'SELECT dispatch_id, channel_id, message_id FROM pending_reaction WHERE created_at < ?',
        Date.now() - REACTION_FAILURE_MS,
      )
      .toArray();
    for (const row of stale) {
      sql.exec('DELETE FROM pending_reaction WHERE dispatch_id = ?', String(row.dispatch_id));
      await this.reactFailure(String(row.channel_id), String(row.message_id), null);
    }
  }

  private async reactFailure(
    channelId: string,
    messageId: string,
    errorMessage: string | null,
  ): Promise<void> {
    const rest = this.rest();
    await this.safeDiscord(() => removeOwnReaction(rest, channelId, messageId, REACTION.working));
    await this.safeDiscord(() => addOwnReaction(rest, channelId, messageId, REACTION.failed));
    await this.safeDiscord(() => sendChannelMessage(rest, channelId, formatFailure(errorMessage)));
  }

  private async safeDiscord(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      console.warn('[discord-gateway] discord call failed', err);
    }
  }

  private recordPendingReaction(
    dispatchId: string,
    instanceId: string,
    channelId: string,
    messageId: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO pending_reaction
         (dispatch_id, instance_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      dispatchId,
      instanceId,
      channelId,
      messageId,
      Date.now(),
    );
  }


  private async onClose(code: number, reason: string): Promise<void> {
    console.log('[discord-gateway] closed', code, reason);
    this.ws = null;
    this.heartbeatAcked = true;
    // Reconnect shortly (resumes if the session is still valid).
    this.ctx.storage.setAlarm(Date.now() + 3000);
  }

  // Records a message id, returning false if it was already recorded. Serialized
  // DO execution plus the primary-key constraint make the claim atomic.
  private claimMessage(messageId: string): boolean {
    const cursor = this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO processed_message (id, seen_at) VALUES (?, ?)',
      messageId,
      Date.now(),
    );
    return cursor.rowsWritten > 0;
  }

  private pruneProcessedMessages(): void {
    const cutoff = Date.now() - PROCESSED_MESSAGE_TTL_MS;
    this.ctx.storage.sql.exec('DELETE FROM processed_message WHERE seen_at < ?', cutoff);
    // Drop reactions whose completion event never arrived (e.g. an evicted agent
    // isolate), so the 👀 is the only stale artifact rather than a leaked row.
    this.ctx.storage.sql.exec('DELETE FROM pending_reaction WHERE created_at < ?', cutoff);
  }

  private send(data: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(data));
  }

  private closeExisting(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

function formatFailure(message: string | null): string {
  const detail = (message ?? 'Unknown error').slice(0, 1800);
  return `⚠️ I hit an error and couldn't respond:\n\`\`\`\n${detail}\n\`\`\``;
}

// The agent runs in its own Durable Object isolate, and `observe()` only sees
// events emitted in the current isolate. This module-level registration runs in
// every isolate (including the agent's), so it is what catches the agent's
// terminal `submission_settled` event. It hands the outcome to the gateway DO,
// which owns the triggering message id and performs the reaction. In the gateway
// and main-worker isolates no submissions settle, so this stays dormant there.
// Cron-driven keep-alive: pokes the single Gateway DO every few minutes so the
// WebSocket is re-established if it was ever evicted or dropped.
export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const id = env.DISCORD_GATEWAY.idFromName(DO_NAME);
    const stub = env.DISCORD_GATEWAY.get(id);
    await stub.fetch(new Request('https://discord-gateway/ensure'));
  },
};
