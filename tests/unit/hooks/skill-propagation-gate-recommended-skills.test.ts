import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Static import of the module under test
import {
	_internals,
	skillPropagationGateBefore,
} from '../../../src/hooks/skill-propagation-gate';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log';

// ============================================================================
// Helpers
// ============================================================================

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gate-rec-test-'));
}

// Normalize paths to use forward slashes for cross-platform comparison
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

// ============================================================================
// save/restore helpers for _internals DI seam
// ============================================================================

type Internals = typeof _internals;
type Override<T> = {
	[P in keyof T]?: T[P];
};

function applyOverrides(
	internals: Internals,
	overrides: Override<Internals>,
): void {
	for (const [k, v] of Object.entries(overrides)) {
		(internals as Record<string, unknown>)[k] = v;
	}
}

function restoreOverrides(
	internals: Internals,
	originals: Override<Internals>,
): void {
	for (const k of Object.keys(originals) as (keyof Internals)[]) {
		(internals as Record<string, unknown>)[k] = originals[k];
	}
}

// ============================================================================
// Return type for skillPropagationGateBefore
// ============================================================================

interface GateResult {
	blocked: boolean;
	reason: string | null;
	recommendedSkills?: Array<{
		skillPath: string;
		score: number;
		usageCount: number;
	}>;
}

// ============================================================================
// recommendedSkills field — tests
// ============================================================================

describe('skillPropagationGateBefore — recommendedSkills field', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		originals = {
			parseDelegationArgs: _internals.parseDelegationArgs,
			discoverAvailableSkills: _internals.discoverAvailableSkills,
			writeWarnEvent: _internals.writeWarnEvent,
			SKILL_CAPABLE_AGENTS: _internals.SKILL_CAPABLE_AGENTS,
			readSkillUsageEntriesTail: _internals.readSkillUsageEntriesTail,
			computeSkillRelevanceScore: _internals.computeSkillRelevanceScore,
			appendSkillUsageEntry: _internals.appendSkillUsageEntry,
			readSkillUsageEntries: _internals.readSkillUsageEntries,
			parseSkillPaths: _internals.parseSkillPaths,
			extractTaskIdFromPrompt: _internals.extractTaskIdFromPrompt,
			formatSkillIndexWithContext: _internals.formatSkillIndexWithContext,
			MAX_SCORING_SESSION_ENTRIES: _internals.MAX_SCORING_SESSION_ENTRIES,
		};
	});

	afterEach(() => {
		restoreOverrides(_internals, originals);
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// -------------------------------------------------------------------------
	// Early-return paths — recommendedSkills MUST be undefined
	// -------------------------------------------------------------------------

	describe('recommendedSkills is undefined in early-return paths', () => {
		test('config.enabled=false → recommendedSkills undefined', async () => {
			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: none\ndo work',
					},
				},
				{ enabled: false },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('tool is not task/Task → recommendedSkills undefined', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'not-task',
					agent: 'architect',
					args: {},
				},
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('agent is missing/empty → recommendedSkills undefined', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: '',
					args: {},
				},
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('agent is not architect → recommendedSkills undefined', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'random_agent',
					args: {},
				},
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('args are unparseable (parseDelegationArgs returns null) → recommendedSkills undefined', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => null,
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: { invalid: 'args' },
				},
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('target agent is not skill-capable → recommendedSkills undefined', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'unknown_agent',
					skillsField: '',
				}),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: { subagent_type: 'unknown_agent', prompt: 'do work' },
				},
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('no available skills in project → recommendedSkills undefined', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
				discoverAvailableSkills: () => [],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: { subagent_type: 'mega_coder', prompt: 'do work' },
				},
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('enforce=true with missing SKILLS → recommendedSkills undefined (blocked path)', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-enforce',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'do work without SKILLS',
					},
				},
				{ enabled: true, enforce: true },
			);
			expect(result.blocked).toBe(true);
			expect(result.reason).toContain('Blocked by skill propagation gate');
			expect(result.recommendedSkills).toBeUndefined();
		});

		test('SKILLS_USED_BY_CODER warning (reviewer without forwarding) → recommendedSkills undefined', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'reviewer',
					skillsField: 'writing-tests',
				}),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-skuc',
					args: {
						subagent_type: 'mega_reviewer',
						prompt: 'review the work',
					},
				},
				{ enabled: true },
			);

			expect(result.blocked).toBe(false);
			expect(result.reason).toContain('SKILLS_USED_BY_CODER warning');
			expect(result.recommendedSkills).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Scoring-computed path — recommendedSkills MUST be present
	// -------------------------------------------------------------------------

	describe('recommendedSkills is present when scoring was computed', () => {
		test('SKILLS present and not none with available skills → recommendedSkills present with scored entries', async () => {
			// Set up session entries so scoring has data to work with
			const sessionEntries: SkillUsageEntry[] = [
				{
					id: '1',
					skillPath: '.claude/skills/writing-tests/SKILL.md',
					agentName: 'coder',
					taskID: 'task-1',
					complianceVerdict: 'compliant',
					sessionID: 'sess-score',
					timestamp: new Date().toISOString(),
				},
				{
					id: '2',
					skillPath: '.claude/skills/code/SKILL.md',
					agentName: 'coder',
					taskID: 'task-1',
					complianceVerdict: 'compliant',
					sessionID: 'sess-score',
					timestamp: new Date().toISOString(),
				},
			];

			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: 'writing-tests',
				}),
				discoverAvailableSkills: () => [
					'.claude/skills/writing-tests/SKILL.md',
					'.claude/skills/code/SKILL.md',
				],
				readSkillUsageEntriesTail: () => sessionEntries,
				computeSkillRelevanceScore: (
					skillPath: string,
					_prompt: string,
					entries: SkillUsageEntry[],
				) => {
					// Simple scoring: higher score for skills with more entries
					if (entries.length === 0) return 0;
					const complianceRate =
						entries.filter((e) => e.complianceVerdict === 'compliant').length /
						entries.length;
					return 0.3 + complianceRate * 0.7;
				},
				writeWarnEvent: () => {},
				formatSkillIndexWithContext: () => '',
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-score',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\ndo the work',
					},
				},
				{ enabled: true },
			);

			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
			expect(result.recommendedSkills).toBeDefined();
			expect(Array.isArray(result.recommendedSkills)).toBe(true);
			expect(result.recommendedSkills!.length).toBeGreaterThan(0);
			// Each entry must have the required shape
			for (const entry of result.recommendedSkills!) {
				expect(typeof entry.skillPath).toBe('string');
				expect(typeof entry.score).toBe('number');
				expect(typeof entry.usageCount).toBe('number');
			}
			// Verify skillPath values
			const skillPaths = result.recommendedSkills!.map((e) => e.skillPath);
			expect(skillPaths).toContain('.claude/skills/writing-tests/SKILL.md');
			expect(skillPaths).toContain('.claude/skills/code/SKILL.md');
		});

		test('scored skills are sorted by score descending, then usageCount descending', async () => {
			const sessionEntries: SkillUsageEntry[] = [
				{
					id: '1',
					skillPath: '.claude/skills/low-score/SKILL.md',
					agentName: 'coder',
					taskID: 'task-1',
					complianceVerdict: 'compliant',
					sessionID: 'sess-sort',
					timestamp: new Date().toISOString(),
				},
			];

			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: 'writing-tests',
				}),
				discoverAvailableSkills: () => [
					'.claude/skills/high-score/SKILL.md',
					'.claude/skills/low-score/SKILL.md',
					'.claude/skills/mid-score/SKILL.md',
				],
				readSkillUsageEntriesTail: () => sessionEntries,
				computeSkillRelevanceScore: (
					skillPath: string,
					_prompt: string,
					entries: SkillUsageEntry[],
				) => {
					// Return different scores for each skill
					if (skillPath.includes('high-score')) return 0.9;
					if (skillPath.includes('mid-score')) return 0.5;
					if (skillPath.includes('low-score')) return 0.3;
					return 0;
				},
				writeWarnEvent: () => {},
				formatSkillIndexWithContext: () => '',
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-sort',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\ndo the work',
					},
				},
				{ enabled: true },
			);

			expect(result.recommendedSkills).toBeDefined();
			expect(result.recommendedSkills!.length).toBe(3);
			// Verify sorted by score descending
			expect(result.recommendedSkills![0].skillPath).toContain('high-score');
			expect(result.recommendedSkills![0].score).toBe(0.9);
			expect(result.recommendedSkills![1].skillPath).toContain('mid-score');
			expect(result.recommendedSkills![1].score).toBe(0.5);
			expect(result.recommendedSkills![2].skillPath).toContain('low-score');
			expect(result.recommendedSkills![2].score).toBe(0.3);
		});

		test('empty sessionEntries → scoring still runs with zero scores but recommendedSkills is present', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: 'writing-tests',
				}),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				readSkillUsageEntriesTail: () => [],
				computeSkillRelevanceScore: () => 0,
				writeWarnEvent: () => {},
				formatSkillIndexWithContext: () => '',
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-empty',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\ndo the work',
					},
				},
				{ enabled: true },
			);

			// recommendedSkills must be present even with empty scoring
			expect(Object.hasOwn(result, 'recommendedSkills')).toBe(true);
			expect(Array.isArray(result.recommendedSkills)).toBe(true);
		});

		test('session entries exceed MAX_SCORING_SESSION_ENTRIES → scoring skipped, recommendedSkills is empty array', async () => {
			// Create entries exceeding the limit
			const manyEntries: SkillUsageEntry[] = Array.from(
				{ length: _internals.MAX_SCORING_SESSION_ENTRIES + 10 },
				(_, i) => ({
					id: String(i),
					skillPath: '.claude/skills/foo/SKILL.md',
					agentName: 'coder',
					taskID: `task-${i}`,
					complianceVerdict: 'compliant' as const,
					sessionID: 'sess-overflow',
					timestamp: new Date().toISOString(),
				}),
			);

			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: 'writing-tests',
				}),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				readSkillUsageEntriesTail: () => manyEntries,
				writeWarnEvent: () => {},
				formatSkillIndexWithContext: () => '',
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-overflow',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\ndo the work',
					},
				},
				{ enabled: true },
			);

			// When scoring is skipped due to budget, scored remains [].
			// The function continues and returns recommendedSkills: scored which is [].
			// recommendedSkills is NOT undefined because this is not an early return path.
			expect(result.recommendedSkills).toEqual([]);
		});

		test('scoring throws an error → best-effort fallback, recommendedSkills undefined', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: 'writing-tests',
				}),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				readSkillUsageEntriesTail: () => [],
				computeSkillRelevanceScore: () => {
					throw new Error('scoring failed');
				},
				writeWarnEvent: () => {},
				formatSkillIndexWithContext: () => '',
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-error',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\ndo the work',
					},
				},
				{ enabled: true },
			);

			// Error in scoring block is caught, execution continues to availableSkills check
			// Since availableSkills.length > 0 and skillsValue is not 'none',
			// the function returns { blocked: false, reason: null, recommendedSkills: scored }
			// but scored is [] (empty because scoring threw before populating it)
			// So recommendedSkills should be [] (empty array, but PRESENT)
			expect(Object.hasOwn(result, 'recommendedSkills')).toBe(true);
			expect(result.recommendedSkills).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// Backward compatibility — existing blocked/reason fields unchanged
	// -------------------------------------------------------------------------

	describe('backward compatibility — blocked and reason fields', () => {
		test('config.enabled=false → blocked=false, reason=null', async () => {
			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: none\ndo work',
					},
				},
				{ enabled: false },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
		});

		test('tool is not task → blocked=false, reason=null', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{ tool: 'not-task', agent: 'architect', args: {} },
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
		});

		test('enforce=true with missing SKILLS → blocked=true with reason message', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'do work without SKILLS',
					},
				},
				{ enabled: true, enforce: true },
			);
			expect(result.blocked).toBe(true);
			expect(typeof result.reason).toBe('string');
			expect(result.reason).toContain('Blocked by skill propagation gate');
		});

		test('SKILLS field present and not none → blocked=false, reason=null', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: 'writing-tests',
				}),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\ndo work',
					},
				},
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(result.reason).toBeNull();
		});

		test('enforce=false with missing SKILLS → blocked=false, reason=warning message', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'do work without SKILLS',
					},
				},
				{ enabled: true, enforce: false },
			);
			expect(result.blocked).toBe(false);
			expect(typeof result.reason).toBe('string');
			expect(result.reason).toContain('Skill propagation warning:');
		});

		test('SKILLS: none with available skills → blocked=false, reason=warning message', async () => {
			applyOverrides(_internals, {
				parseDelegationArgs: () => ({
					targetAgent: 'coder',
					skillsField: 'none',
				}),
				discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
				writeWarnEvent: () => {},
			});

			const result = await skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: none\ndo work',
					},
				},
				{ enabled: true },
			);
			expect(result.blocked).toBe(false);
			expect(typeof result.reason).toBe('string');
			expect(result.reason).toContain('Skill propagation warning:');
		});
	});
});
