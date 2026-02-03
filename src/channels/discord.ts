/**
 * Discord Channel Adapter
 *
 * Uses discord.js for Discord API.
 * Guild-only with a primary channel; no DMs.
 */

import type { ChannelAdapter } from './types.js';
import type { InboundAttachment, InboundMessage, OutboundMessage } from '../core/types.js';
import { buildAttachmentPath, downloadToFile } from './attachments.js';
import type { Attachment, Collection } from 'discord.js';

// Dynamic import to avoid requiring Discord deps if not used
let Client: typeof import('discord.js').Client;
let GatewayIntentBits: typeof import('discord.js').GatewayIntentBits;

export interface DiscordConfig {
  token: string;
  guildId?: string;
  channelId?: string; // Primary channel where all messages are handled
  attachmentsDir?: string;
  attachmentsMaxBytes?: number;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord' as const;
  readonly name = 'Discord';

  private client: InstanceType<typeof Client> | null = null;
  private config: DiscordConfig;
  private running = false;
  private attachmentsDir?: string;
  private attachmentsMaxBytes?: number;

  onMessage?: (msg: InboundMessage) => Promise<void>;
  onCommand?: (command: string) => Promise<string | null>;

  constructor(config: DiscordConfig) {
    this.config = { ...config };
    this.attachmentsDir = config.attachmentsDir;
    this.attachmentsMaxBytes = config.attachmentsMaxBytes;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const discord = await import('discord.js');
    Client = discord.Client;
    GatewayIntentBits = discord.GatewayIntentBits;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('ready', () => {
      const tag = this.client?.user?.tag || '(unknown)';
      console.log(`[Discord] Bot logged in as ${tag}`);
      console.log(`[Discord] Guild: ${this.config.guildId || '(unset)'}`);
      console.log(`[Discord] Primary channel: ${this.config.channelId || '(unset)'}`);
      this.running = true;
    });

    this.client.on('messageCreate', async (message) => {
      if (message.author?.bot) return;
      if (!message.guildId) return;
      if (this.config.guildId && message.guildId !== this.config.guildId) return;

      let content = (message.content || '').trim();
      const userId = message.author?.id;
      if (!userId) return;

      const botUserId = this.client?.user?.id;
      if (!botUserId) return;

      const isPrimaryChannel = this.config.channelId
        ? message.channel.id === this.config.channelId
        : false;

      if (!isPrimaryChannel) {
        const isMentioned = message.mentions.has(botUserId);
        let isReplyToBot = false;
        if (message.reference?.messageId) {
          try {
            const referenced = await message.fetchReference();
            isReplyToBot = referenced.author.id === botUserId;
          } catch {
            // Ignore reference fetch failures
          }
        }

        if (!isMentioned && !isReplyToBot) return;
      }
      
      // Handle audio attachments
      const audioAttachment = message.attachments.find(a => a.contentType?.startsWith('audio/'));
      if (audioAttachment?.url) {
        try {
          const { loadConfig } = await import('../config/index.js');
          const config = loadConfig();
          if (!config.transcription?.apiKey && !process.env.OPENAI_API_KEY) {
            await message.reply('Voice messages require OpenAI API key for transcription. See: https://github.com/letta-ai/lettabot#voice-messages');
          } else {
            // Download audio
            const response = await fetch(audioAttachment.url);
            const buffer = Buffer.from(await response.arrayBuffer());
            
            const { transcribeAudio } = await import('../transcription/index.js');
            const ext = audioAttachment.contentType?.split('/')[1] || 'mp3';
            const transcript = await transcribeAudio(buffer, audioAttachment.name || `audio.${ext}`);
            
            console.log(`[Discord] Transcribed audio: "${transcript.slice(0, 50)}..."`);
            content = (content ? content + '\n' : '') + `[Voice message]: ${transcript}`;
          }
        } catch (error) {
          console.error('[Discord] Error transcribing audio:', error);
        }
      }

      const attachments = await this.collectAttachments(message.attachments, message.channel.id);
      if (!content && attachments.length === 0) return;

      if (content.startsWith('/')) {
        const command = content.slice(1).split(/\s+/)[0]?.toLowerCase();
        if (this.onCommand) {
          if (command === 'status') {
            const result = await this.onCommand('status');
            if (result) {
              await message.channel.send(result);
            }
            return;
          }
          if (command === 'heartbeat') {
            const result = await this.onCommand('heartbeat');
            if (result) {
              await message.channel.send(result);
            }
            return;
          }
        }
      }

      if (this.onMessage) {
        const isGroup = !!message.guildId;
        const groupName = isGroup && 'name' in message.channel ? message.channel.name : undefined;
        const displayName = message.member?.displayName || message.author.globalName || message.author.username;

        await this.onMessage({
          channel: 'discord',
          chatId: message.channel.id,
          userId,
          userName: displayName,
          userHandle: message.author.username,
          messageId: message.id,
          text: content || '',
          timestamp: message.createdAt,
          isGroup,
          groupName,
          attachments,
        });
      }
    });

    this.client.on('error', (err) => {
      console.error('[Discord] Client error:', err);
    });

    console.log('[Discord] Connecting...');
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    if (!this.running || !this.client) return;
    this.client.destroy();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(msg: OutboundMessage): Promise<{ messageId: string }> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(msg.chatId);
    if (!isSendableChannel(channel)) {
      throw new Error(`Discord channel not found or not text-based: ${msg.chatId}`);
    }

    const result = await channel.send(msg.text);
    return { messageId: result.id };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Discord not started');
    const channel = await this.client.channels.fetch(chatId);
    if (!isSendableChannel(channel)) {
      throw new Error(`Discord channel not found or not text-based: ${chatId}`);
    }

    const message = await channel.messages.fetch(messageId);
    if (!isEditableMessage(message)) {
      console.warn('[Discord] Cannot edit message: unsupported message type');
      return;
    }
    const botUserId = this.client.user?.id;
    if (!botUserId || message.author.id !== botUserId) {
      console.warn('[Discord] Cannot edit message not sent by bot');
      return;
    }
    await message.edit(text);
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!isSendableChannel(channel)) return;
      await channel.sendTyping();
    } catch {
      // Ignore typing indicator failures
    }
  }

  supportsEditing(): boolean {
    return true;
  }

  private async collectAttachments(
    attachments: Collection<string, Attachment>,
    channelId: string
  ): Promise<InboundAttachment[]> {
    if (attachments.size === 0) return [];
    const results: InboundAttachment[] = [];
    for (const attachment of attachments.values()) {
      const name = attachment.name || attachment.id || 'attachment';
      const entry: InboundAttachment = {
        id: attachment.id,
        name,
        mimeType: attachment.contentType || undefined,
        size: attachment.size,
        kind: attachment.contentType?.startsWith('image/') ? 'image' : 'file',
        url: attachment.url,
      };
      if (this.attachmentsDir && attachment.url) {
        if (this.attachmentsMaxBytes === 0) {
          results.push(entry);
          continue;
        }
        if (this.attachmentsMaxBytes && attachment.size && attachment.size > this.attachmentsMaxBytes) {
          console.warn(`[Discord] Attachment ${name} exceeds size limit, skipping download.`);
          results.push(entry);
          continue;
        }
        const target = buildAttachmentPath(this.attachmentsDir, 'discord', channelId, name);
        try {
          await downloadToFile(attachment.url, target);
          entry.localPath = target;
          console.log(`[Discord] Attachment saved to ${target}`);
        } catch (err) {
          console.warn('[Discord] Failed to download attachment:', err);
        }
      }
      results.push(entry);
    }
    return results;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type SendableChannel = {
  send: (content: string) => Promise<{ id: string }>;
  sendTyping: () => Promise<void>;
  messages: { fetch: (messageId: string) => Promise<unknown> };
};

type EditableMessage = {
  author: { id: string };
  edit: (content: string) => Promise<unknown>;
};

function isSendableChannel(channel: unknown): channel is SendableChannel {
  if (!isRecord(channel)) return false;
  const send = channel['send'];
  const sendTyping = channel['sendTyping'];
  const messages = channel['messages'];
  if (typeof send !== 'function' || typeof sendTyping !== 'function') return false;
  if (!isRecord(messages) || typeof messages['fetch'] !== 'function') return false;
  return true;
}

function isEditableMessage(message: unknown): message is EditableMessage {
  if (!isRecord(message)) return false;
  const author = message['author'];
  const edit = message['edit'];
  if (!isRecord(author) || typeof author['id'] !== 'string') return false;
  if (typeof edit !== 'function') return false;
  return true;
}
