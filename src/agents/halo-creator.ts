import { defineAgent } from '@flue/runtime';
import type { DiscordGateway } from '../cloudflare.ts';
import { postDiscordMessage, tryParseConversationKey } from '../shared/discord.ts';
import { redact } from '../shared/redacted.ts';

// Single Gateway DO instance; mirrors DO_NAME in cloudflare.ts.
const GATEWAY_DO_NAME = 'default';

interface HaloCreatorEnv {
  DISCORD_BOT_TOKEN: string;
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
}

export default defineAgent<HaloCreatorEnv>(({ id, env }) => {
  const dest = tryParseConversationKey(id);
  // After the model posts a reply, tell the gateway this channel's pending turn
  // succeeded so it flips the triggering message's 👀 → ✅.
  const markReplied = dest
    ? () => {
        const ns = env.DISCORD_GATEWAY;
        return ns.get(ns.idFromName(GATEWAY_DO_NAME)).markReplied(dest.channelId);
      }
    : undefined;

  return {
    model: 'cloudflare/anthropic/claude-sonnet-4.6',
    instructions: `You are the Halo AI creator assistant, a Discord bot that helps
Halo AI's UGC creators make engaging short-form videos. Your job has two parts:

1. Trend pipeline: research current social trends and propose specific,
   makeable video ideas tuned to the creator's audience.
2. Script generation: write full production scripts for those ideas, grounded
   in the top-performing videos tracked in the Cops platform (connected through
   its MCP server). Favor ideas and scripts that mirror what is already
   working for the creator.

Be concrete, practical, and concise. When Cops data is available, cite the
top-performing videos you are basing a script on.

## Replying on Discord

When a creator mentions you in Discord, the message arrives as a <dispatch>
signal whose JSON body has a "text" field with their message (and an "author"
field with their username). Your ONLY way to reach Discord is the
post_discord_message tool, which posts to the channel the conversation is
happening in. Always call post_discord_message with your reply instead of
relying on a plain text response. Keep each reply concise and Discord-friendly
(under 2000 characters). If a reply is long, split it across multiple
post_discord_message calls.`,
    tools: dest ? [postDiscordMessage(dest, redact(env.DISCORD_BOT_TOKEN), markReplied)] : [],
  };
});
