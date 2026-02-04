/**
 * WhatsApp Group Gating
 *
 * Applies group-specific access control and mention gating.
 * Based on OpenClaw's group gating patterns.
 */

import { detectMention, type MentionConfig } from './mentions.js';
import type { WebInboundMessage } from './types.js';

export interface GroupGatingParams {
  /** Extracted message */
  msg: WebInboundMessage;

  /** Group JID */
  groupJid: string;

  /** Bot's JID */
  selfJid: string | null;

  /** Bot's Linked Device ID (for Business/multi-device mentions) */
  selfLid: string | null;

  /** Bot's E.164 number */
  selfE164: string | null;

  /** Per-group configuration */
  groupsConfig?: Record<string, { requireMention?: boolean }>;

  /** Mention patterns from config */
  mentionPatterns?: string[];
}

export interface GroupGatingResult {
  /** Whether message should be processed */
  shouldProcess: boolean;

  /** Whether bot was mentioned */
  wasMentioned?: boolean;

  /** Reason for filtering (if shouldProcess=false) */
  reason?: string;
}

/**
 * Apply group-specific gating logic.
 *
 * Steps:
 * 1. Check group allowlist (if groups config exists)
 * 2. Resolve requireMention setting
 * 3. Detect mentions (JID, regex, E.164, reply)
 * 4. Apply mention gating
 *
 * @param params - Gating parameters
 * @returns Gating decision
 *
 * @example
 * const result = applyGroupGating({
 *   msg: inboundMessage,
 *   groupJid: "12345@g.us",
 *   selfJid: "555@s.whatsapp.net",
 *   selfE164: "+15551234567",
 *   groupsConfig: { "*": { requireMention: true } },
 *   mentionPatterns: ["@?bot"]
 * });
 *
 * if (!result.shouldProcess) {
 *   console.log(`Skipped: ${result.reason}`);
 *   return;
 * }
 */
export function applyGroupGating(params: GroupGatingParams): GroupGatingResult {
  const { msg, groupJid, selfJid, selfLid, selfE164, groupsConfig, mentionPatterns } = params;

  // Step 1: Check group allowlist (if groups config exists)
  const groups = groupsConfig ?? {};
  const allowlistEnabled = Object.keys(groups).length > 0;

  if (allowlistEnabled) {
    // Check if this specific group is allowed
    const hasWildcard = Object.hasOwn(groups, '*');
    const hasSpecific = Object.hasOwn(groups, groupJid);

    if (!hasWildcard && !hasSpecific) {
      return {
        shouldProcess: false,
        reason: 'group-not-in-allowlist',
      };
    }
  }

  // Step 2: Resolve requireMention setting (default: true)
  // Priority: specific group → wildcard → true
  const groupConfig = groups[groupJid];
  const wildcardConfig = groups['*'];
  const requireMention =
    groupConfig?.requireMention ??
    wildcardConfig?.requireMention ??
    true; // Default: require mention for safety

  // If requireMention is false, allow all messages from this group
  if (!requireMention) {
    return {
      shouldProcess: true,
      wasMentioned: false, // Didn't check, not required
    };
  }

  // Step 3: Detect mentions
  const mentionResult = detectMention({
    body: msg.body,
    mentionedJids: msg.mentionedJids,
    replyToSenderJid: msg.replyContext?.senderJid,
    replyToSenderE164: msg.replyContext?.senderE164,
    config: {
      mentionPatterns: mentionPatterns ?? [],
      selfE164,
      selfJid,
      selfLid,
    },
  });

  // Step 4: Apply mention gating
  if (!mentionResult.wasMentioned) {
    // Not mentioned and mention required - skip this message
    // Note: In a full implementation, this message could be stored in
    // "pending history" for context injection when bot IS mentioned
    return {
      shouldProcess: false,
      wasMentioned: false,
      reason: 'mention-required',
    };
  }

  // Mentioned! Process this message
  return {
    shouldProcess: true,
    wasMentioned: true,
  };
}
