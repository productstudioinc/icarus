/**
 * Skills Manager Types
 */

/**
 * Skill requirements from metadata.clawdbot.requires
 */
export interface SkillRequirements {
  bins?: string[];      // Required binaries (all must exist)
  anyBins?: string[];   // Any of these binaries (at least one)
  env?: string[];       // Required environment variables
}

/**
 * Skill install specification from metadata.clawdbot.install[]
 */
export interface SkillInstallSpec {
  id?: string;
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download';
  formula?: string;     // brew
  package?: string;     // node/uv
  module?: string;      // go
  url?: string;         // download
  bins?: string[];      // Binaries this installs
  label?: string;       // Display label
  os?: string[];        // Platform filter (darwin, linux, win32)
}

/**
 * ClawdBot metadata embedded in skill frontmatter
 */
export interface ClawdbotMetadata {
  emoji?: string;
  requires?: SkillRequirements;
  install?: SkillInstallSpec[];
  primaryEnv?: string;
  os?: string[];        // Platform filter
  always?: boolean;     // Always eligible
  skillKey?: string;    // Override skill key
}

/**
 * Parsed skill entry
 */
export interface SkillEntry {
  name: string;
  description: string;
  emoji?: string;
  homepage?: string;
  filePath: string;
  baseDir: string;
  clawdbot?: ClawdbotMetadata;
}

/**
 * Skill status with eligibility info
 */
export interface SkillStatus {
  skill: SkillEntry;
  eligible: boolean;
  disabled: boolean;
  missing: {
    bins: string[];
    env: string[];
    os: boolean;  // true if OS doesn't match
  };
  installOptions: SkillInstallOption[];
}

/**
 * Normalized install option for display
 */
export interface SkillInstallOption {
  id: string;
  kind: SkillInstallSpec['kind'];
  label: string;
  bins: string[];
}

/**
 * Result of installing a skill's dependencies
 */
export interface SkillInstallResult {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Node package manager preference
 */
export type NodeManager = 'npm' | 'pnpm' | 'bun';
