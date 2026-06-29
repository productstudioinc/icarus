import { REST } from '@discordjs/rest';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { Redacted } from './redacted.ts';

export interface DiscordDestination {
  guildId: string | null;
  channelId: string;
}

// Canonical agent-instance id for one Discord channel conversation.
// Guild channels: "discord:<guildId>:<channelId>". DMs: "discord:dm:<channelId>".
export function conversationKey(ref: DiscordDestination): string {
  return ref.guildId ? `discord:${ref.guildId}:${ref.channelId}` : `discord:dm:${ref.channelId}`;
}

export function tryParseConversationKey(key: string): DiscordDestination | null {
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== 'discord') return null;
  const [, guild, channel] = parts;
  if (!guild || !channel) return null;
  return { guildId: guild === 'dm' ? null : guild, channelId: channel };
}

// Remove the bot user mention (and channel/role mentions) so only the user's
// actual question reaches the model.
export function stripMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .replace(/<@&\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .trim();
}

// Discord Gateway frames and REST responses are untrusted boundary input;
// parse the fields we rely on before the Durable Object acts on them. Discord
// payloads carry many more fields, so these shapes are intentionally lenient.
const GatewayFrameSchema = v.object({
  op: v.number(),
  s: v.nullish(v.number()),
  t: v.nullish(v.string()),
  d: v.unknown(),
});
const HelloDataSchema = v.object({ heartbeat_interval: v.number() });
const ReadyDataSchema = v.object({
  session_id: v.string(),
  resume_gateway_url: v.string(),
  user: v.object({ id: v.string() }),
});
const MessageCreateSchema = v.object({
  id: v.string(),
  channel_id: v.string(),
  content: v.optional(v.string()),
  guild_id: v.nullish(v.string()),
  author: v.optional(
    v.object({
      id: v.optional(v.string()),
      bot: v.optional(v.boolean()),
      username: v.optional(v.string()),
    }),
  ),
  mentions: v.optional(v.array(v.object({ id: v.optional(v.string()) }))),
});
const GatewayBotSchema = v.object({ url: v.string() });
const PostMessageResponseSchema = v.object({ id: v.optional(v.string()) });

export type GatewayFrame = v.InferOutput<typeof GatewayFrameSchema>;

function parseOrNull<TSchema extends v.GenericSchema>(
  schema: TSchema,
  raw: unknown,
): v.InferOutput<TSchema> | null {
  const result = v.safeParse(schema, raw);
  return result.success ? result.output : null;
}

export const parseGatewayFrame = (raw: unknown): GatewayFrame | null =>
  parseOrNull(GatewayFrameSchema, raw);
export const parseHelloData = (raw: unknown) => parseOrNull(HelloDataSchema, raw);
export const parseReadyData = (raw: unknown) => parseOrNull(ReadyDataSchema, raw);
export const parseMessageCreate = (raw: unknown) => parseOrNull(MessageCreateSchema, raw);
export const parseGatewayBotResponse = (raw: unknown) => parseOrNull(GatewayBotSchema, raw);
const parsePostMessageResponse = (raw: unknown) => parseOrNull(PostMessageResponseSchema, raw);

// Reaction emoji used on the triggering message to signal processing state.
export const REACTION = {
  working: '👀',
  done: '✅',
  failed: '❌',
} as const;

// REST client for gateway-side Discord calls (reactions, typing, plain channel
// posts) that are not model-driven tools.
export function createDiscordRest(token: Redacted<string>): REST {
  return new REST({ version: '10' }).setToken(token.reveal());
}

// Reactions and typing are best-effort UX: a missing ADD_REACTIONS permission or
// a deleted message must never break message handling, so callers swallow
// failures. Discord's reaction route takes the emoji URL-encoded.
export function addOwnReaction(rest: REST, channelId: string, messageId: string, emoji: string) {
  return rest.put(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
}

export function removeOwnReaction(rest: REST, channelId: string, messageId: string, emoji: string) {
  return rest.delete(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
}

export function triggerTyping(rest: REST, channelId: string) {
  return rest.post(`/channels/${channelId}/typing`);
}

export function sendChannelMessage(rest: REST, channelId: string, content: string) {
  return rest.post(`/channels/${channelId}/messages`, { body: { content: content.slice(0, 2000) } });
}

// Application-owned tool bound to one Discord destination and credential. The
// model picks the message content; it cannot choose arbitrary channels or
// credentials. Discord publishes no official JS SDK, so outbound calls go
// through the community-maintained @discordjs/rest client.
export function postDiscordMessage(
  ref: DiscordDestination,
  token: Redacted<string>,
  onPosted?: () => Promise<void> | void,
) {
  const rest = new REST({ version: '10' }).setToken(token.reveal());
  return defineTool({
    name: 'post_discord_message',
    description:
      'Post a message to the Discord channel this conversation is happening in. ' +
      'Use this to reply to the user who mentioned the bot. Keep content under 2000 characters.',
    input: v.object({ content: v.pipe(v.string(), v.minLength(1)) }),
    async run({
      input: { content },
      signal,
    }): Promise<{ posted: false; error: string } | { posted: true; messageId: string | null }> {
      try {
        const response: unknown = await rest.post(`/channels/${ref.channelId}/messages`, {
          body: { content: content.slice(0, 2000) },
          signal,
        });
        const parsed = parsePostMessageResponse(response);
        // Best-effort completion signal (e.g. flip the triggering message's
        // reaction to ✅); a failure here must not fail the post itself.
        try {
          await onPosted?.();
        } catch {
          // ignore
        }
        return { posted: true as const, messageId: parsed?.id ?? null };
      } catch (err) {
        return { posted: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}
