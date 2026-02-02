/**
 * Skills Status - Check skill eligibility and requirements
 */

import type {
  SkillEntry,
  SkillStatus,
  SkillInstallOption,
  SkillInstallSpec,
  NodeManager,
} from './types.js';
import { hasBinary, loadSkills, GLOBAL_SKILLS_DIR } from './loader.js';

/**
 * Build install option label
 */
function buildInstallLabel(spec: SkillInstallSpec, nodeManager: NodeManager): string {
  if (spec.label?.trim()) return spec.label.trim();
  
  switch (spec.kind) {
    case 'brew':
      return spec.formula ? `Install ${spec.formula} (brew)` : 'Install via brew';
    case 'node':
      return spec.package ? `Install ${spec.package} (${nodeManager})` : `Install via ${nodeManager}`;
    case 'go':
      return spec.module ? `Install ${spec.module} (go)` : 'Install via go';
    case 'uv':
      return spec.package ? `Install ${spec.package} (uv)` : 'Install via uv';
    case 'download':
      if (spec.url) {
        const filename = spec.url.split('/').pop() || 'file';
        return `Download ${filename}`;
      }
      return 'Download';
    default:
      return 'Install';
  }
}

/**
 * Normalize install options for a skill
 * Filters by platform and selects preferred option
 */
function normalizeInstallOptions(
  skill: SkillEntry,
  nodeManager: NodeManager = 'npm'
): SkillInstallOption[] {
  const specs = skill.clawdbot?.install ?? [];
  if (specs.length === 0) return [];
  
  const platform = process.platform;
  
  // Filter by platform
  const filtered = specs.filter(spec => {
    const osList = spec.os ?? [];
    return osList.length === 0 || osList.includes(platform);
  });
  
  if (filtered.length === 0) return [];
  
  // Convert to options
  return filtered.map((spec, index) => ({
    id: spec.id ?? `${spec.kind}-${index}`,
    kind: spec.kind,
    label: buildInstallLabel(spec, nodeManager),
    bins: spec.bins ?? [],
  }));
}

/**
 * Check a single skill's eligibility
 */
export function checkSkillStatus(
  skill: SkillEntry,
  nodeManager: NodeManager = 'npm'
): SkillStatus {
  const requires = skill.clawdbot?.requires;
  const osFilter = skill.clawdbot?.os ?? [];
  const always = skill.clawdbot?.always === true;
  
  // Check OS
  const osMatch = osFilter.length === 0 || osFilter.includes(process.platform);
  
  // Check required binaries
  const requiredBins = requires?.bins ?? [];
  const missingBins = requiredBins.filter(bin => !hasBinary(bin));
  
  // Check anyBins (at least one must exist)
  const anyBins = requires?.anyBins ?? [];
  const hasAnyBin = anyBins.length === 0 || anyBins.some(bin => hasBinary(bin));
  
  // Check environment variables
  const requiredEnv = requires?.env ?? [];
  const missingEnv = requiredEnv.filter(name => !process.env[name]);
  
  // Determine eligibility
  const eligible = always || (
    osMatch &&
    missingBins.length === 0 &&
    hasAnyBin &&
    missingEnv.length === 0
  );
  
  return {
    skill,
    eligible,
    disabled: false,  // TODO: Support disabled skills via config
    missing: {
      bins: [...missingBins, ...(hasAnyBin ? [] : anyBins)],
      env: missingEnv,
      os: !osMatch,
    },
    installOptions: normalizeInstallOptions(skill, nodeManager),
  };
}

/**
 * Build status report for all skills
 */
export function buildSkillsStatus(
  skillsDirs: string[] = [GLOBAL_SKILLS_DIR],
  nodeManager: NodeManager = 'npm'
): SkillStatus[] {
  const skills = loadSkills(skillsDirs);
  return skills.map(skill => checkSkillStatus(skill, nodeManager));
}

/**
 * Summary of skills status
 */
export interface SkillsSummary {
  total: number;
  eligible: number;
  missingDeps: number;
  wrongPlatform: number;
  skills: SkillStatus[];
}

/**
 * Get a summary of all skills
 */
export function getSkillsSummary(
  skillsDirs: string[] = [GLOBAL_SKILLS_DIR],
  nodeManager: NodeManager = 'npm'
): SkillsSummary {
  const statuses = buildSkillsStatus(skillsDirs, nodeManager);
  
  const eligible = statuses.filter(s => s.eligible);
  const missingDeps = statuses.filter(s => 
    !s.eligible && !s.missing.os && s.missing.bins.length > 0
  );
  const wrongPlatform = statuses.filter(s => s.missing.os);
  
  return {
    total: statuses.length,
    eligible: eligible.length,
    missingDeps: missingDeps.length,
    wrongPlatform: wrongPlatform.length,
    skills: statuses,
  };
}
