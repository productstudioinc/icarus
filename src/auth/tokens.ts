/**
 * Token storage utilities for OAuth credentials
 * Stores tokens at ~/.letta/lettabot/tokens.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";

const TOKENS_DIR = join(homedir(), ".letta", "lettabot");
const TOKENS_FILE = join(TOKENS_DIR, "tokens.json");

export interface TokenStore {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number; // Unix timestamp in milliseconds
  deviceId: string;
  deviceName?: string;
}

/**
 * Ensure the tokens directory exists
 */
function ensureDir(): void {
  if (!existsSync(TOKENS_DIR)) {
    mkdirSync(TOKENS_DIR, { recursive: true });
  }
}

/**
 * Load tokens from disk
 */
export function loadTokens(): TokenStore | null {
  if (!existsSync(TOKENS_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(TOKENS_FILE, "utf-8");
    return JSON.parse(content) as TokenStore;
  } catch {
    return null;
  }
}

/**
 * Save tokens to disk
 */
export function saveTokens(tokens: TokenStore): void {
  ensureDir();
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Delete stored tokens (logout)
 */
export function deleteTokens(): boolean {
  if (existsSync(TOKENS_FILE)) {
    unlinkSync(TOKENS_FILE);
    return true;
  }
  return false;
}

/**
 * Get or create a persistent device ID
 */
export function getOrCreateDeviceId(): string {
  const tokens = loadTokens();
  if (tokens?.deviceId) {
    return tokens.deviceId;
  }

  // Check if there's a device ID file (for cases where tokens don't exist yet)
  const deviceIdFile = join(TOKENS_DIR, "device-id");
  if (existsSync(deviceIdFile)) {
    try {
      return readFileSync(deviceIdFile, "utf-8").trim();
    } catch {
      // Fall through to create new
    }
  }

  // Create new device ID
  const deviceId = randomUUID();
  ensureDir();
  writeFileSync(deviceIdFile, deviceId);
  return deviceId;
}

/**
 * Get the device name (hostname)
 */
export function getDeviceName(): string {
  return hostname();
}

/**
 * Check if the access token is expired or about to expire
 * @param bufferMs - Consider expired if within this many ms of expiry (default: 5 minutes)
 */
export function isTokenExpired(tokens: TokenStore | null, bufferMs = 5 * 60 * 1000): boolean {
  if (!tokens?.tokenExpiresAt) {
    // No expiry info, assume not expired
    return false;
  }

  return Date.now() >= tokens.tokenExpiresAt - bufferMs;
}

/**
 * Check if we have a valid refresh token
 */
export function hasRefreshToken(tokens: TokenStore | null): boolean {
  return !!tokens?.refreshToken;
}

/**
 * Get the current access token, or null if not logged in
 * This checks env var first, then stored tokens
 */
export function getAccessToken(): string | null {
  // Environment variable takes precedence
  if (process.env.LETTA_API_KEY) {
    return process.env.LETTA_API_KEY;
  }

  const tokens = loadTokens();
  return tokens?.accessToken ?? null;
}
