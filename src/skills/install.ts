/**
 * Skills Install - Install skill dependencies
 */

import { spawn } from 'node:child_process';
import type { SkillInstallResult, SkillInstallSpec, NodeManager } from './types.js';
import { hasBinary } from './loader.js';

/**
 * Run a command with timeout
 */
async function runCommand(
  argv: string[],
  timeoutMs: number = 300_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    
    proc.on('error', (err) => {
      resolve({ code: null, stdout, stderr: err.message });
    });
  });
}

/**
 * Build install command for a spec
 */
function buildInstallCommand(
  spec: SkillInstallSpec,
  nodeManager: NodeManager
): { argv: string[] | null; error?: string } {
  switch (spec.kind) {
    case 'brew': {
      if (!spec.formula) return { argv: null, error: 'Missing brew formula' };
      return { argv: ['brew', 'install', spec.formula] };
    }
    
    case 'node': {
      if (!spec.package) return { argv: null, error: 'Missing node package' };
      switch (nodeManager) {
        case 'pnpm':
          return { argv: ['pnpm', 'add', '-g', spec.package] };
        case 'bun':
          return { argv: ['bun', 'add', '-g', spec.package] };
        default:
          return { argv: ['npm', 'install', '-g', spec.package] };
      }
    }
    
    case 'go': {
      if (!spec.module) return { argv: null, error: 'Missing go module' };
      return { argv: ['go', 'install', spec.module] };
    }
    
    case 'uv': {
      if (!spec.package) return { argv: null, error: 'Missing uv package' };
      return { argv: ['uv', 'tool', 'install', spec.package] };
    }
    
    case 'download': {
      // TODO: Implement download handler
      return { argv: null, error: 'Download not yet implemented' };
    }
    
    default:
      return { argv: null, error: 'Unknown install kind' };
  }
}

/**
 * Check prerequisites for install kind
 */
function checkPrerequisites(spec: SkillInstallSpec): string | null {
  switch (spec.kind) {
    case 'brew':
      if (!hasBinary('brew')) {
        return 'Homebrew not installed. Install from https://brew.sh';
      }
      break;
    case 'go':
      if (!hasBinary('go')) {
        return 'Go not installed. Install from https://go.dev or `brew install go`';
      }
      break;
    case 'uv':
      if (!hasBinary('uv')) {
        return 'uv not installed. Install from https://astral.sh/uv or `brew install uv`';
      }
      break;
  }
  return null;
}

/**
 * Install a skill's dependencies using a specific install spec
 */
export async function installSkillDeps(
  spec: SkillInstallSpec,
  nodeManager: NodeManager = 'npm',
  timeoutMs: number = 300_000
): Promise<SkillInstallResult> {
  // Check prerequisites
  const prereqError = checkPrerequisites(spec);
  if (prereqError) {
    return {
      ok: false,
      message: prereqError,
      stdout: '',
      stderr: '',
      code: null,
    };
  }
  
  // Build command
  const command = buildInstallCommand(spec, nodeManager);
  if (!command.argv) {
    return {
      ok: false,
      message: command.error || 'Invalid install command',
      stdout: '',
      stderr: '',
      code: null,
    };
  }
  
  // Run command
  const result = await runCommand(command.argv, timeoutMs);
  const ok = result.code === 0;
  
  return {
    ok,
    message: ok ? 'Installed successfully' : `Install failed (exit ${result.code})`,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}

/**
 * Install dependencies for first matching install option
 */
export async function installFirstOption(
  specs: SkillInstallSpec[],
  nodeManager: NodeManager = 'npm'
): Promise<SkillInstallResult> {
  // Filter by platform
  const platform = process.platform;
  const filtered = specs.filter(spec => {
    const osList = spec.os ?? [];
    return osList.length === 0 || osList.includes(platform);
  });
  
  if (filtered.length === 0) {
    return {
      ok: false,
      message: 'No install options available for this platform',
      stdout: '',
      stderr: '',
      code: null,
    };
  }
  
  // Try first option that has prerequisites met
  for (const spec of filtered) {
    const prereqError = checkPrerequisites(spec);
    if (!prereqError) {
      return installSkillDeps(spec, nodeManager);
    }
  }
  
  // Fall back to first option (will fail with prereq error)
  return installSkillDeps(filtered[0], nodeManager);
}
