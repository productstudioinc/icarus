/**
 * DM Pairing Types
 * 
 * Secure access control for direct messages.
 */

/** DM access policy */
export type DmPolicy = 'pairing' | 'allowlist' | 'open';

/** A pending pairing request */
export interface PairingRequest {
  id: string;           // User ID (e.g., Telegram user ID)
  code: string;         // 8-char pairing code
  createdAt: string;    // ISO timestamp
  lastSeenAt: string;   // ISO timestamp (updated on repeat contact)
  meta?: {
    username?: string;
    firstName?: string;
    lastName?: string;
  };
}

/** Pairing store on disk */
export interface PairingStore {
  version: 1;
  requests: PairingRequest[];
}

/** AllowFrom store on disk */
export interface AllowFromStore {
  version: 1;
  allowFrom: string[];
}

/** Channel pairing configuration */
export interface PairingConfig {
  dmPolicy: DmPolicy;
  allowedUsers?: string[];  // Pre-configured allowlist
}
