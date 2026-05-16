import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Static import of the module under test
import {
	_internals,
	discoverAvailableSkills,
	parseDelegationArgs,
	parseSkillPaths,
	SKILL_CAPABLE_AGENTS,
	skillPropagationGateBefore,
	skillPropagationTransformScan,
	writeWarnEvent,
} from '../../../src/hooks/skill-propagation-gate';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log';
import {
	appendSkillUsageEntry,
	readSkillUsageEntries,
} from '../../../src/hooks/skill-usage-log';

// ============================================================================
// Helpers
// ============================================================================

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gate-test-'));
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

// Track skill-usage entries written via the mocked appendSkillUsageEntry
interface RecordedEntry {
	skillPath: string;
	agentName: string;
	taskID: string;
	complianceVerdict: string;
	sessionID: string;
	reviewerNotes?: string;
	timestamp: string;
}

function makeMockAppendSkillUsageEntry(
	records: RecordedEntry[],
): typeof _internals.appendSkillUsageEntry {
	return (_directory: string, entry: Omit<SkillUsageEntry, 'id'>) => {
		records.push({
			skillPath: entry.skillPath as string,
			agentName: entry.agentName as string,
			taskID: entry.taskID as string,
			complianceVerdict: entry.complianceVerdict as string,
			sessionID: entry.sessionID as string,
			reviewerNotes: entry.reviewerNotes as string | undefined,
			timestamp: entry.timestamp as string,
		});
	};
}

// ============================================================================
// parseDelegationArgs — original tests
// ============================================================================

describe('parseDelegationArgs', () => {
	test('returns null when args is null', () => {
		expect(parseDelegationArgs(null)).toBeNull();
	});

	test('returns null when args is undefined', () => {
		expect(parseDelegationArgs(undefined)).toBeNull();
	});

	test('returns null when args is not an object', () => {
		expect(parseDelegationArgs('string' as unknown)).toBeNull();
		expect(parseDelegationArgs(42 as unknown)).toBeNull();
	});

	test('returns null when no subagent_type and no prompt', () => {
		expect(parseDelegationArgs({})).toBeNull();
		expect(parseDelegationArgs({ other: 'field' })).toBeNull();
	});

	test('extracts target agent from subagent_type', () => {
		const result = parseDelegationArgs({
			subagent_type: 'mega_coder',
			prompt: 'do something',
		});
		expect(result).not.toBeNull();
		expect(result!.targetAgent).toBe('mega_coder');
	});

	test('extracts target agent from prompt first line as fallback', () => {
		const result = parseDelegationArgs({
			prompt: 'lowtier_coder\ndo the thing',
		});
		expect(result).not.toBeNull();
		expect(result!.targetAgent).toBe('lowtier_coder');
	});

	test('subagent_type takes priority over prompt fallback', () => {
		const result = parseDelegationArgs({
			subagent_type: 'mega_reviewer',
			prompt: 'lowtier_coder\ndo the thing',
		});
		expect(result).not.toBeNull();
		expect(result!.targetAgent).toBe('mega_reviewer');
	});

	test('extracts SKILLS field value from prompt', () => {
		const result = parseDelegationArgs({
			subagent_type: 'coder',
			prompt: 'do the thing\nSKILLS: writing-tests\nmore content',
		});
		expect(result).not.toBeNull();
		expect(result!.skillsField).toBe('writing-tests');
	});

	test('returns empty skillsField when no SKILLS line found', () => {
		const result = parseDelegationArgs({
			subagent_type: 'coder',
			prompt: 'do the thing\nno skills here',
		});
		expect(result).not.toBeNull();
		expect(result!.skillsField).toBe('');
	});

	test('handles SKILLS: with trailing whitespace', () => {
		const result = parseDelegationArgs({
			subagent_type: 'coder',
			prompt: 'SKILLS:   writing-tests  \nmore',
		});
		expect(result).not.toBeNull();
		expect(result!.skillsField).toBe('writing-tests');
	});

	test('returns null when prompt is empty and no subagent_type', () => {
		expect(parseDelegationArgs({ prompt: '' })).toBeNull();
	});

	test('returns null when subagent_type is empty string only', () => {
		expect(parseDelegationArgs({ subagent_type: '', prompt: '' })).toBeNull();
	});
});

// ============================================================================
// discoverAvailableSkills — original tests
// ============================================================================

describe('discoverAvailableSkills', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		originals = {
			existsSync: _internals.existsSync,
			readdirSync: _internals.readdirSync,
			statSync: _internals.statSync,
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

	test('returns empty array when no skill directories exist', () => {
		const result = discoverAvailableSkills(tmp);
		expect(result).toEqual([]);
	});

	test('discovers skills from .opencode/skills/*/SKILL.md', () => {
		const skillDir = path.join(tmp, '.opencode', 'skills', 'my-skill');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill');

		const result = discoverAvailableSkills(tmp);
		const normalized = result.map(normalizePath);
		expect(normalized).toContain('.opencode/skills/my-skill/SKILL.md');
	});

	test('discovers skills from .opencode/skills/generated/*/SKILL.md', () => {
		const skillDir = path.join(
			tmp,
			'.opencode',
			'skills',
			'generated',
			'gen-skill',
		);
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Generated Skill');

		const result = discoverAvailableSkills(tmp);
		const normalized = result.map(normalizePath);
		expect(normalized).toContain(
			'.opencode/skills/generated/gen-skill/SKILL.md',
		);
	});

	test('discovers skills from .claude/skills/*/SKILL.md', () => {
		const skillDir = path.join(tmp, '.claude', 'skills', 'claude-skill');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Claude Skill');

		const result = discoverAvailableSkills(tmp);
		const normalized = result.map(normalizePath);
		expect(normalized).toContain('.claude/skills/claude-skill/SKILL.md');
	});

	test('returns relative paths', () => {
		const skillDir = path.join(tmp, '.claude', 'skills', 'my-skill');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill');

		const result = discoverAvailableSkills(tmp);
		expect(normalizePath(result[0])).toBe('.claude/skills/my-skill/SKILL.md');
	});

	test('ignores dot-prefixed entries in skill root', () => {
		const skillsRoot = path.join(tmp, '.opencode', 'skills');
		fs.mkdirSync(skillsRoot, { recursive: true });
		// Create a dotfile entry
		fs.mkdirSync(path.join(skillsRoot, '.git'), { recursive: true });
		fs.writeFileSync(
			path.join(skillsRoot, '.git', 'SKILL.md'),
			'# Should be ignored',
		);

		const result = discoverAvailableSkills(tmp);
		const normalized = result.map(normalizePath);
		expect(normalized).not.toContain('.opencode/skills/.git/SKILL.md');
	});

	test('skips entries that are not directories', () => {
		const skillsRoot = path.join(tmp, '.opencode', 'skills');
		fs.mkdirSync(skillsRoot, { recursive: true });
		fs.writeFileSync(path.join(skillsRoot, 'not-a-dir.txt'), 'not a skill');

		const result = discoverAvailableSkills(tmp);
		expect(result).not.toContain('not-a-dir.txt');
	});

	test('skips skill directories without SKILL.md', () => {
		const skillDir = path.join(tmp, '.claude', 'skills', 'no-md-skill');
		fs.mkdirSync(skillDir, { recursive: true });
		// No SKILL.md file

		const result = discoverAvailableSkills(tmp);
		expect(result).not.toContain('no-md-skill');
	});
});

// ============================================================================
// skillPropagationGateBefore — gating logic (original tests)
// ============================================================================

describe('skillPropagationGateBefore', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		originals = {
			parseDelegationArgs: _internals.parseDelegationArgs,
			discoverAvailableSkills: _internals.discoverAvailableSkills,
			writeWarnEvent: _internals.writeWarnEvent,
			SKILL_CAPABLE_AGENTS: _internals.SKILL_CAPABLE_AGENTS,
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

	async function runGate(input: {
		tool?: string;
		agent?: string;
		sessionID?: string;
		args?: unknown;
	}): Promise<void> {
		return skillPropagationGateBefore(
			tmp,
			{
				tool: input.tool,
				agent: input.agent,
				sessionID: input.sessionID,
				args: input.args,
			} as {
				tool: unknown;
				agent?: unknown;
				sessionID?: unknown;
				args?: unknown;
			},
			{ enabled: true },
		);
	}

	test('does NOT block when config.enabled = false', async () => {
		const result = await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				args: { subagent_type: 'mega_coder', prompt: 'SKILLS: none\ndo work' },
			},
			{ enabled: false },
		);
		expect(result).toBeUndefined();
	});

	test('does NOT block when tool is not task/Task', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({ tool: 'not-task', agent: 'architect' });
		expect(warnEventWritten).toHaveLength(0);
	});

	test('does NOT block when agent is not architect', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		// 'random_agent' doesn't end with any known role+separator, so stripKnownSwarmPrefix returns 'random_agent' which !== 'architect'
		await runGate({ tool: 'task', agent: 'random_agent' });
		expect(warnEventWritten).toHaveLength(0);
	});

	test('does NOT block when args.subagent_type is not skill-capable', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'unknown_agent',
				skillsField: '',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: { subagent_type: 'unknown_agent', prompt: 'do work' },
		});
		expect(warnEventWritten).toHaveLength(0);
	});

	test('does NOT block when no skills exist in project', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
			discoverAvailableSkills: () => [],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: { subagent_type: 'mega_coder', prompt: 'do work' },
		});
		expect(warnEventWritten).toHaveLength(0);
	});

	test('does NOT block when SKILLS field is present and not none', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: writing-tests\ndo work',
			},
		});
		expect(warnEventWritten).toHaveLength(0);
	});

	test('logs warning when SKILLS field is none and skills exist', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'none',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: none\ndo work',
			},
		});

		expect(warnEventWritten).toHaveLength(1);
		expect(warnEventWritten[0]).toMatchObject({
			type: 'skill_propagation_warn',
			target_agent: 'coder',
			skills_missing: true,
		});
	});

	test('logs warning when SKILLS field is missing and skills exist', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
			discoverAvailableSkills: () => [
				'.claude/skills/foo/SKILL.md',
				'.claude/skills/bar/SKILL.md',
			],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: {
				subagent_type: 'mega_coder',
				prompt: 'do work without SKILLS',
			},
		});

		expect(warnEventWritten).toHaveLength(1);
		expect(warnEventWritten[0]).toMatchObject({
			type: 'skill_propagation_warn',
			target_agent: 'coder',
			skills_missing: true,
			available_skills: [
				'.claude/skills/foo/SKILL.md',
				'.claude/skills/bar/SKILL.md',
			],
		});
	});

	test('writes warning event to events.jsonl', async () => {
		// Override SKILL_CAPABLE_AGENTS to ensure coder is considered skill-capable
		// This is needed because a previous DI seam test may have corrupted the shared Set reference
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'none',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) => {
				const filePath = path.join(_d, '.swarm', 'events.jsonl');
				const line = JSON.stringify(r) + '\n';
				// Create directory if needed (same as real writeWarnEvent)
				if (!fs.existsSync(path.dirname(filePath))) {
					fs.mkdirSync(path.dirname(filePath), { recursive: true });
				}
				fs.appendFileSync(filePath, line, 'utf-8');
			},
			SKILL_CAPABLE_AGENTS: new Set([
				'coder',
				'reviewer',
				'test_engineer',
				'sme',
				'docs',
				'designer',
			]),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: none\ndo work',
			},
		});

		const eventsPath = path.join(tmp, '.swarm', 'events.jsonl');
		expect(fs.existsSync(eventsPath)).toBe(true);
		const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.type).toBe('skill_propagation_warn');
		expect(parsed.skills_missing).toBe(true);
	});

	test('does NOT block execution even when warning is logged', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'none',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) => {
				warnEventWritten.push(r);
			},
		});

		await expect(
			runGate({
				tool: 'task',
				agent: 'architect',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: none\ndo work',
				},
			}),
		).resolves.toBeUndefined();

		expect(warnEventWritten).toHaveLength(1);
	});

	test('SKILLS value is case-insensitive for none check', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'NONE',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: {
				subagent_type: 'mega_coder',
				prompt: 'SKILLS: NONE\ndo work',
			},
		});

		expect(warnEventWritten).toHaveLength(1);
	});

	test('handles prefixed agent names (mega_coder)', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'mega_coder',
				skillsField: '',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			args: { subagent_type: 'mega_coder', prompt: 'do work' },
		});

		expect(warnEventWritten).toHaveLength(1);
		expect(warnEventWritten[0].target_agent).toBe('mega_coder');
	});

	test('handles local prefixed agent names (local_coder)', async () => {
		const warnEventWritten: Array<Record<string, unknown>> = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'local_coder',
				skillsField: '',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) =>
				warnEventWritten.push(r),
		});

		await runGate({
			tool: 'Task',
			agent: 'local_architect',
			args: { subagent_type: 'local_coder', prompt: 'do work' },
		});

		expect(warnEventWritten).toHaveLength(1);
	});

	test('sessionID passed through to warning event', async () => {
		let capturedSessionID = '';
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: (_d: string, r: Record<string, unknown>) => {
				capturedSessionID = r.sessionID as string;
			},
		});

		await runGate({
			tool: 'task',
			agent: 'architect',
			sessionID: 'test-session-123',
			args: { subagent_type: 'mega_coder', prompt: 'do work' },
		});

		expect(capturedSessionID).toBe('test-session-123');
	});
});

// ============================================================================
// _internals DI seam — original tests
// ============================================================================

describe('_internals DI seam', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		originals = {
			discoverAvailableSkills: _internals.discoverAvailableSkills,
			writeWarnEvent: _internals.writeWarnEvent,
			parseDelegationArgs: _internals.parseDelegationArgs,
			SKILL_CAPABLE_AGENTS: _internals.SKILL_CAPABLE_AGENTS,
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

	test('can override discoverAvailableSkills', () => {
		const fakeSkills = [
			'.claude/skills/fake/SKILL.md',
			'.opencode/skills/generated/fake/SKILL.md',
		];
		applyOverrides(_internals, {
			discoverAvailableSkills: () => fakeSkills,
		});

		const result = _internals.discoverAvailableSkills(tmp);
		expect(result).toEqual(fakeSkills);
	});

	test('can override writeWarnEvent', async () => {
		let callCount = 0;
		applyOverrides(_internals, {
			writeWarnEvent: () => callCount++,
			parseDelegationArgs: () => ({ targetAgent: 'coder', skillsField: '' }),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
		});

		await _internals.skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				args: { subagent_type: 'mega_coder', prompt: 'SKILLS: none\nwork' },
			},
			{ enabled: true },
		);

		expect(callCount).toBe(1);
	});

	test('can override parseDelegationArgs', async () => {
		let overrideCalled = false;
		applyOverrides(_internals, {
			parseDelegationArgs: () => {
				overrideCalled = true;
				return null; // Return null so gate short-circuits
			},
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
		});

		await _internals.skillPropagationGateBefore(
			tmp,
			{ tool: 'task', agent: 'architect', args: {} },
			{ enabled: true },
		);

		expect(overrideCalled).toBe(true);
	});

	test('can override SKILL_CAPABLE_AGENTS', async () => {
		let warnCount = 0;
		applyOverrides(_internals, {
			SKILL_CAPABLE_AGENTS: new Set(['totally_custom_agent']),
			parseDelegationArgs: () => ({
				targetAgent: 'totally_custom_agent',
				skillsField: '',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			writeWarnEvent: () => warnCount++,
		});

		await _internals.skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				args: { subagent_type: 'totally_custom_agent', prompt: 'work' },
			},
			{ enabled: true },
		);

		expect(warnCount).toBe(1);
	});

	test('originals are restored after afterEach', async () => {
		// Apply custom overrides
		applyOverrides(_internals, {
			discoverAvailableSkills: () => ['custom/path/SKILL.md'],
			SKILL_CAPABLE_AGENTS: new Set(['custom_agent']),
		});

		restoreOverrides(_internals, originals);

		// After restore, original function should work again
		const skillDir = path.join(tmp, '.claude', 'skills', 'restored-skill');
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Restored');

		const skills = _internals.discoverAvailableSkills(tmp);
		const normalized = skills.map(normalizePath);
		expect(normalized).toContain('.claude/skills/restored-skill/SKILL.md');
	});
});

// ============================================================================
// SKILL_CAPABLE_AGENTS constant — original tests
// ============================================================================

describe('SKILL_CAPABLE_AGENTS', () => {
	test('contains expected agents', () => {
		expect(SKILL_CAPABLE_AGENTS.has('coder')).toBe(true);
		expect(SKILL_CAPABLE_AGENTS.has('reviewer')).toBe(true);
		expect(SKILL_CAPABLE_AGENTS.has('test_engineer')).toBe(true);
		expect(SKILL_CAPABLE_AGENTS.has('sme')).toBe(true);
		expect(SKILL_CAPABLE_AGENTS.has('docs')).toBe(true);
		expect(SKILL_CAPABLE_AGENTS.has('designer')).toBe(true);
	});

	test('does not contain non-skill-capable agents', () => {
		expect(SKILL_CAPABLE_AGENTS.has('architect')).toBe(false);
		expect(SKILL_CAPABLE_AGENTS.has('critic')).toBe(false);
		expect(SKILL_CAPABLE_AGENTS.has('unknown')).toBe(false);
	});
});

// ============================================================================
// writeWarnEvent — original tests
// ============================================================================

describe('writeWarnEvent', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = tmpDir();
	});

	afterEach(() => {
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('creates .swarm directory if it does not exist', () => {
		const eventsDir = path.join(tmp, '.swarm');
		expect(fs.existsSync(eventsDir)).toBe(false);

		writeWarnEvent(tmp, { type: 'test_event', data: 42 });

		expect(fs.existsSync(eventsDir)).toBe(true);
	});

	test('appends event to events.jsonl', () => {
		writeWarnEvent(tmp, { type: 'event_one', n: 1 });
		writeWarnEvent(tmp, { type: 'event_two', n: 2 });

		const filePath = path.join(tmp, '.swarm', 'events.jsonl');
		const content = fs.readFileSync(filePath, 'utf-8');
		const lines = content.trim().split('\n');

		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toEqual({ type: 'event_one', n: 1 });
		expect(JSON.parse(lines[1])).toEqual({ type: 'event_two', n: 2 });
	});

	test('does not throw when directory creation fails', () => {
		// writeWarnEvent uses best-effort and catches errors internally
		expect(() => {
			writeWarnEvent(tmp, { type: 'safe_event' });
		}).not.toThrow();
	});
});

// ============================================================================
// skillPropagationTransformScan — original COMPLIANT test (line 838-862)
// ============================================================================

describe('skillPropagationTransformScan — existing compliance test', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = tmpDir();
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('records compliance entry for SKILL_COMPLIANCE: COMPLIANT without notes suffix', async () => {
		const messages = [
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT',
					},
				],
			},
		];

		await skillPropagationTransformScan(tmp, { messages }, 'test-session-1');

		const usagePath = path.join(tmp, '.swarm', 'skill-usage.jsonl');
		expect(fs.existsSync(usagePath)).toBe(true);

		const lines = fs.readFileSync(usagePath, 'utf-8').trim().split('\n');
		expect(lines.length).toBeGreaterThanOrEqual(1);

		const entry = JSON.parse(lines[lines.length - 1]);
		expect(entry.complianceVerdict).toBe('compliant');
		expect(entry.agentName).toBe('reviewer');
	});
});

// ============================================================================
// parseSkillPaths — NEW: Task 4.4 coverage gaps
// ============================================================================

describe('parseSkillPaths', () => {
	test('returns empty array for null', () => {
		expect(parseSkillPaths(null as unknown as string)).toEqual([]);
	});

	test('returns empty array for undefined', () => {
		expect(parseSkillPaths(undefined as unknown as string)).toEqual([]);
	});

	test('returns empty array for non-string', () => {
		expect(parseSkillPaths(42 as unknown as string)).toEqual([]);
	});

	test('returns empty array for empty string', () => {
		expect(parseSkillPaths('')).toEqual([]);
	});

	test('returns empty array for whitespace-only string', () => {
		expect(parseSkillPaths('   ')).toEqual([]);
	});

	test('returns empty array for "none" (lowercase)', () => {
		expect(parseSkillPaths('none')).toEqual([]);
	});

	test('returns empty array for "NONE" (uppercase)', () => {
		expect(parseSkillPaths('NONE')).toEqual([]);
	});

	test('returns empty array for "None" (mixed case)', () => {
		expect(parseSkillPaths('None')).toEqual([]);
	});

	test('parses single skill path', () => {
		expect(parseSkillPaths('writing-tests')).toEqual(['writing-tests']);
	});

	test('parses comma-separated multiple skill paths', () => {
		expect(parseSkillPaths('writing-tests,code,review')).toEqual([
			'writing-tests',
			'code',
			'review',
		]);
	});

	test('trims whitespace around skill paths', () => {
		expect(parseSkillPaths('  writing-tests  ,  code  ')).toEqual([
			'writing-tests',
			'code',
		]);
	});

	test('filters empty segments from comma-separated list', () => {
		expect(parseSkillPaths('writing-tests,,code,,')).toEqual([
			'writing-tests',
			'code',
		]);
	});

	test('preserves original case', () => {
		expect(parseSkillPaths('Writing-Tests')).toEqual(['Writing-Tests']);
	});

	test('handles single skill with trailing comma', () => {
		expect(parseSkillPaths('writing-tests,')).toEqual(['writing-tests']);
	});

	test('parses "none" with surrounding whitespace', () => {
		expect(parseSkillPaths('  none  ')).toEqual([]);
	});
});

// ============================================================================
// extractTaskIdFromPrompt — NEW: Task 4.4 coverage gaps
// ============================================================================

describe('extractTaskIdFromPrompt', () => {
	const { extractTaskIdFromPrompt: extractFn } = _internals;

	test('returns "unknown" for null', () => {
		expect(extractFn(null as unknown as string)).toBe('unknown');
	});

	test('returns "unknown" for undefined', () => {
		expect(extractFn(undefined as unknown as string)).toBe('unknown');
	});

	test('returns "unknown" for empty string', () => {
		expect(extractFn('')).toBe('unknown');
	});

	test('extracts taskId from "taskId: <id>" pattern', () => {
		expect(extractFn('some prompt\ntaskId: abc-123\nmore')).toBe('abc-123');
	});

	test('extracts taskId from "taskId=<id>" pattern', () => {
		expect(extractFn('taskId=xyz-789')).toBe('xyz-789');
	});

	test('extracts taskId from "TASK: <id>" pattern', () => {
		expect(extractFn('TASK: plan-42')).toBe('plan-42');
	});

	test('extracts taskId from "TASK = <id>" pattern', () => {
		expect(extractFn('TASK = phase-1')).toBe('phase-1');
	});

	test('taskId pattern is case-insensitive', () => {
		expect(extractFn('TaskId: task-5')).toBe('task-5');
	});

	test('TASK pattern is case-insensitive', () => {
		expect(extractFn('task: task-6')).toBe('task-6');
	});

	test('returns "unknown" when no pattern matches', () => {
		expect(extractFn('do the thing with the stuff')).toBe('unknown');
	});

	test('prefers taskId over TASK when both present', () => {
		const prompt = 'taskId: id-from-taskid\nTASK: id-from-task';
		expect(extractFn(prompt)).toBe('id-from-taskid');
	});

	test('handles taskId at start of prompt', () => {
		expect(extractFn('taskId: first-thing')).toBe('first-thing');
	});

	test('handles taskId at end of prompt', () => {
		expect(extractFn('end of prompt\ntaskId: last-thing')).toBe('last-thing');
	});
});

// ============================================================================
// skillPropagationGateBefore — delegation recording (NEW: Task 4.4)
// Uses _internals.appendSkillUsageEntry mock seam
// ============================================================================

describe('skillPropagationGateBefore — delegation recording', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		originals = {
			parseDelegationArgs: _internals.parseDelegationArgs,
			discoverAvailableSkills: _internals.discoverAvailableSkills,
			writeWarnEvent: _internals.writeWarnEvent,
			appendSkillUsageEntry: _internals.appendSkillUsageEntry,
			parseSkillPaths: _internals.parseSkillPaths,
			extractTaskIdFromPrompt: _internals.extractTaskIdFromPrompt,
			SKILL_CAPABLE_AGENTS: _internals.SKILL_CAPABLE_AGENTS,
			computeSkillRelevanceScore: _internals.computeSkillRelevanceScore,
			readSkillUsageEntries: _internals.readSkillUsageEntries,
			readSkillUsageEntriesTail: _internals.readSkillUsageEntriesTail,
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

	test('records skill usage entry when SKILLS field is non-none', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-42',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-abc',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\ndo the work',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			skillPath: 'writing-tests',
			agentName: 'coder',
			taskID: 'task-42',
			complianceVerdict: 'not_checked',
			sessionID: 'sess-abc',
		});
	});

	test('records one entry per skill path for comma-separated SKILLS', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'reviewer',
				skillsField: 'code,review',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-99',
			parseSkillPaths: (v: string) => {
				if (v === 'code,review') return ['code', 'review'];
				return [];
			},
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-xyz',
				args: {
					subagent_type: 'mega_reviewer',
					prompt: 'SKILLS: code,review\nreview the code',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(2);
		expect(recorded.map((r) => r.skillPath).sort()).toEqual(['code', 'review']);
		expect(recorded[0].agentName).toBe('reviewer');
		expect(recorded[1].agentName).toBe('reviewer');
	});

	test('parses SKILLS_USED_BY_CODER from prompt and combines with SKILLS field', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-7',
			parseSkillPaths: (v: string) => {
				if (v === 'writing-tests') return ['writing-tests'];
				if (v === 'code,architecture') return ['code', 'architecture'];
				return [];
			},
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-coder',
				args: {
					subagent_type: 'mega_coder',
					prompt:
						'SKILLS: writing-tests\nSKILLS_USED_BY_CODER: code,architecture\ndo work',
				},
			},
			{ enabled: true },
		);

		// writing-tests (from SKILLS:) + code + architecture (from SKILLS_USED_BY_CODER:)
		expect(recorded).toHaveLength(3);
		const paths = recorded.map((r) => r.skillPath).sort();
		expect(paths).toEqual(['architecture', 'code', 'writing-tests']);
	});

	test('deduplicates skill paths when SKILLS and SKILLS_USED_BY_CODER overlap', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-dedup',
			parseSkillPaths: (v: string) => {
				if (v === 'writing-tests') return ['writing-tests'];
				if (v === 'writing-tests,code') return ['writing-tests', 'code'];
				return [];
			},
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-dedup',
				args: {
					subagent_type: 'mega_coder',
					prompt:
						'SKILLS: writing-tests\nSKILLS_USED_BY_CODER: writing-tests,code\ndo work',
				},
			},
			{ enabled: true },
		);

		// writing-tests deduplicated — should only appear once
		expect(recorded).toHaveLength(2);
		const paths = recorded.map((r) => r.skillPath).sort();
		expect(paths).toEqual(['code', 'writing-tests']);
	});

	test('does NOT record when SKILLS field is "none"', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'none',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'unknown',
			parseSkillPaths: () => [],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-none',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: none\ndo work',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(0);
	});

	test('does NOT record when SKILLS field is empty', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: '',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-empty',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'do work without skills',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(0);
	});

	test('records with taskId "unknown" when prompt has no taskId pattern', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'unknown',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-no-taskid',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'just do the thing',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(1);
		expect(recorded[0].taskID).toBe('unknown');
	});

	test('records with sessionID from input', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'test_engineer',
				skillsField: 'code',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-session-test',
			parseSkillPaths: (v: string) => (v === 'code' ? ['code'] : []),
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'Task',
				agent: 'architect',
				sessionID: 'custom-session-id',
				args: {
					subagent_type: 'test_engineer',
					prompt: 'SKILLS: code\nrun the tests',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(1);
		expect(recorded[0].sessionID).toBe('custom-session-id');
	});

	test('records with agentName from stripped target agent', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'mega_coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-agent-strip',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-agent-strip',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\ndo work',
				},
			},
			{ enabled: true },
		);

		// agentName should be stripped to 'coder', not 'mega_coder'
		expect(recorded).toHaveLength(1);
		expect(recorded[0].agentName).toBe('coder');
	});

	test('complianceVerdict is "not_checked" for delegation recording', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-not-checked',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-not-checked',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\ndo work',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(1);
		expect(recorded[0].complianceVerdict).toBe('not_checked');
	});

	test('does NOT record for non-skill-capable target agents', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'unknown_agent',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-non-skill',
				args: {
					subagent_type: 'unknown_agent',
					prompt: 'SKILLS: writing-tests\ndo work',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(0);
	});

	test('calls computeSkillRelevanceScore for each available skill when skills are present', async () => {
		let scoringCallCount = 0;
		let lastScoringArgs: [string, string, unknown[]] | null = null;
		const mockComputeSkillRelevanceScore = (
			skillPath: string,
			taskDescription: string,
			usageHistory: unknown[],
		) => {
			scoringCallCount++;
			lastScoringArgs = [skillPath, taskDescription, usageHistory];
			return 0.85;
		};

		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => [
				'.claude/skills/writing-tests/SKILL.md',
				'.claude/skills/engineering-conventions/SKILL.md',
			],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry([]),
			extractTaskIdFromPrompt: () => 'task-score',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			readSkillUsageEntriesTail: () => [
				{
					id: 'e1',
					skillPath: '.claude/skills/writing-tests/SKILL.md',
					agentName: 'coder',
					taskID: 'task-score',
					sessionID: 'sess-score',
					timestamp: new Date().toISOString(),
					complianceVerdict: 'compliant',
				},
			],
			computeSkillRelevanceScore: mockComputeSkillRelevanceScore,
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-score',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\nimplement the feature',
				},
			},
			{ enabled: true },
		);

		// computeSkillRelevanceScore should be called once per available skill
		expect(scoringCallCount).toBe(2);
		expect(lastScoringArgs).not.toBeNull();
		expect(lastScoringArgs![1]).toContain('implement the feature');
	});

	test('scoring error does not block the delegation recording', async () => {
		const recorded: RecordedEntry[] = [];
		const scoringError = new Error('computeSkillRelevanceScore failed');

		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/writing-tests/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-error',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			readSkillUsageEntriesTail: () => [],
			computeSkillRelevanceScore: () => {
				throw scoringError;
			},
		});

		// Should NOT throw — scoring error is caught
		await expect(
			skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-error',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\nimplement the feature',
					},
				},
				{ enabled: true },
			),
		).resolves.toBeUndefined();

		// Delegation recording should still have succeeded
		expect(recorded).toHaveLength(1);
		expect(recorded[0].skillPath).toBe('writing-tests');
		expect(recorded[0].taskID).toBe('task-error');
	});

	test('does NOT call computeSkillRelevanceScore when skillsValue is "none"', async () => {
		let scoringCalled = false;

		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'none',
			}),
			discoverAvailableSkills: () => ['.claude/skills/writing-tests/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry([]),
			computeSkillRelevanceScore: () => {
				scoringCalled = true;
				return 0;
			},
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-no-score',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: none\nimplement the feature',
				},
			},
			{ enabled: true },
		);

		expect(scoringCalled).toBe(false);
	});

	test('skips scoring when session entries exceed MAX_SCORING_SESSION_ENTRIES', async () => {
		let scoringCalled = false;
		const recorded: RecordedEntry[] = [];

		// Simulate a session with more entries than the limit
		const largeEntryList = Array.from({ length: 501 }, (_, i) => ({
			id: `id-${i}`,
			skillPath: `skill-${i}`,
			agentName: 'coder',
			taskID: `task-${i}`,
			sessionID: 'sess-overflow',
			timestamp: new Date().toISOString(),
			complianceVerdict: 'not_checked',
		}));

		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/writing-tests/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-overflow',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			readSkillUsageEntriesTail: () => largeEntryList,
			computeSkillRelevanceScore: () => {
				scoringCalled = true;
				return 0;
			},
			MAX_SCORING_SESSION_ENTRIES: 500,
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-overflow',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\nimplement the feature',
				},
			},
			{ enabled: true },
		);

		// Scoring should have been skipped
		expect(scoringCalled).toBe(false);

		// Delegation recording should still have proceeded normally
		expect(recorded).toHaveLength(1);
		expect(recorded[0].skillPath).toBe('writing-tests');
		expect(recorded[0].taskID).toBe('task-overflow');
	});

	test('proceeds with scoring when session entries are within limit', async () => {
		let scoringCalled = false;
		const recorded: RecordedEntry[] = [];

		// Simulate a session with entries under the limit
		const smallEntryList = Array.from({ length: 10 }, (_, i) => ({
			id: `id-${i}`,
			skillPath: `skill-${i}`,
			agentName: 'coder',
			taskID: `task-${i}`,
			sessionID: 'sess-ok',
			timestamp: new Date().toISOString(),
			complianceVerdict: 'not_checked',
		}));

		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/writing-tests/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-within-limit',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			readSkillUsageEntriesTail: () => smallEntryList,
			computeSkillRelevanceScore: () => {
				scoringCalled = true;
				return 0;
			},
			MAX_SCORING_SESSION_ENTRIES: 500,
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-ok',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: writing-tests\nimplement the feature',
				},
			},
			{ enabled: true },
		);

		// Scoring should have proceeded
		expect(scoringCalled).toBe(true);

		// Delegation recording should also have proceeded
		expect(recorded).toHaveLength(1);
		expect(recorded[0].skillPath).toBe('writing-tests');
	});

	test('scoring skip due to entry count is non-blocking (readSkillUsageEntriesTail error)', async () => {
		let scoringCalled = false;
		const recorded: RecordedEntry[] = [];

		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/writing-tests/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-read-error',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			readSkillUsageEntriesTail: () => {
				throw new Error('simulated read failure');
			},
			computeSkillRelevanceScore: () => {
				scoringCalled = true;
				return 0;
			},
			MAX_SCORING_SESSION_ENTRIES: 500,
		});

		// Should NOT throw — the error in readSkillUsageEntries is caught by the
		// existing try/catch around the scoring block
		await expect(
			skillPropagationGateBefore(
				tmp,
				{
					tool: 'task',
					agent: 'architect',
					sessionID: 'sess-read-error',
					args: {
						subagent_type: 'mega_coder',
						prompt: 'SKILLS: writing-tests\nimplement the feature',
					},
				},
				{ enabled: true },
			),
		).resolves.toBeUndefined();

		// Scoring was not called because the read threw before we could check
		expect(scoringCalled).toBe(false);

		// Delegation recording should still have succeeded (it runs before scoring)
		expect(recorded).toHaveLength(1);
	});
});

// ============================================================================
// skillPropagationTransformScan — reviewer compliance verdicts (NEW: Task 4.4)
// ============================================================================

describe('skillPropagationTransformScan — reviewer compliance verdicts', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		originals = {
			appendSkillUsageEntry: _internals.appendSkillUsageEntry,
			parseSkillPaths: _internals.parseSkillPaths,
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

	async function runTransform(
		messages: Array<{
			info?: { role?: string; agent?: string };
			parts?: Array<{ type: string; text?: string }>;
		}>,
		sessionID = 'transform-session',
	): Promise<void> {
		await skillPropagationTransformScan(
			tmp,
			{
				messages: messages as Parameters<
					typeof skillPropagationTransformScan
				>[1]['messages'],
			},
			sessionID,
		);
	}

	function readUsageFile(): RecordedEntry[] {
		const usagePath = path.join(tmp, '.swarm', 'skill-usage.jsonl');
		if (!fs.existsSync(usagePath)) return [];
		const raw = fs.readFileSync(usagePath, 'utf-8').trim();
		if (!raw) return [];
		return raw
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as RecordedEntry);
	}

	test('SKILL_COMPLIANCE: COMPLIANT with em-dash notes suffix', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'code,writing-tests' ? ['code', 'writing-tests'] : [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILLS_USED_BY_CODER: code,writing-tests\nSKILL_COMPLIANCE: COMPLIANT — All skills loaded and applied correctly',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries.length).toBeGreaterThanOrEqual(1);
		const compliantEntries = entries.filter(
			(e) => e.complianceVerdict === 'compliant',
		);
		expect(compliantEntries.length).toBe(2);
		expect(compliantEntries[0].reviewerNotes).toBe(
			'All skills loaded and applied correctly',
		);
		expect(compliantEntries[0].agentName).toBe('reviewer');
	});

	test('SKILL_COMPLIANCE: PARTIAL verdict', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: PARTIAL — some skills not followed',
					},
				],
			},
		]);

		const entries = readUsageFile();
		const partialEntries = entries.filter(
			(e) => e.complianceVerdict === 'partial',
		);
		expect(partialEntries.length).toBeGreaterThanOrEqual(1);
		expect(partialEntries[0].reviewerNotes).toBe('some skills not followed');
	});

	test('SKILL_COMPLIANCE: VIOLATED verdict', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: VIOLATED — skill not loaded at all',
					},
				],
			},
		]);

		const entries = readUsageFile();
		const violatedEntries = entries.filter(
			(e) => e.complianceVerdict === 'violated',
		);
		expect(violatedEntries.length).toBeGreaterThanOrEqual(1);
		expect(violatedEntries[0].reviewerNotes).toBe('skill not loaded at all');
	});

	test('records __overall__ when no SKILLS_USED_BY_CODER paths found', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries.some((e) => e.skillPath === '__overall__')).toBe(true);
	});

	test('records per skill path when SKILLS_USED_BY_CODER is present', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) => {
				if (v === 'skill-a,skill-b,skill-c')
					return ['skill-a', 'skill-b', 'skill-c'];
				return [];
			},
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILLS_USED_BY_CODER: skill-a,skill-b,skill-c\nSKILL_COMPLIANCE: COMPLIANT',
					},
				],
			},
		]);

		const entries = readUsageFile();
		const paths = entries.map((e) => e.skillPath).sort();
		expect(paths).toEqual(['skill-a', 'skill-b', 'skill-c']);
	});

	test('only processes the most recent reviewer message', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: VIOLATED — earlier message',
					},
				],
			},
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT — latest message',
					},
				],
			},
		]);

		const entries = readUsageFile();
		const compliantEntries = entries.filter(
			(e) => e.complianceVerdict === 'compliant',
		);
		const violatedEntries = entries.filter(
			(e) => e.complianceVerdict === 'violated',
		);
		expect(compliantEntries.length).toBeGreaterThanOrEqual(1);
		expect(violatedEntries.length).toBe(0);
	});

	test('skips non-reviewer messages in compliance scan', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'coder' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT — should be ignored',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries).toHaveLength(0);
	});

	test('handles reviewer message with no parts', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [],
			},
		]);

		const entries = readUsageFile();
		expect(entries).toHaveLength(0);
	});

	test('verdict is lowercased when recorded', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
	});
});

// ============================================================================
// skillPropagationTransformScan — architect delegation scanning (NEW: Task 4.4)
// ============================================================================

describe('skillPropagationTransformScan — architect delegation scanning', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		originals = {
			appendSkillUsageEntry: _internals.appendSkillUsageEntry,
			parseSkillPaths: _internals.parseSkillPaths,
			extractTaskIdFromPrompt: _internals.extractTaskIdFromPrompt,
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

	async function runTransform(
		messages: Array<{
			info?: { role?: string; agent?: string };
			parts?: Array<{ type: string; text?: string }>;
		}>,
		sessionID = 'arch-session',
	): Promise<void> {
		await skillPropagationTransformScan(
			tmp,
			{
				messages: messages as Parameters<
					typeof skillPropagationTransformScan
				>[1]['messages'],
			},
			sessionID,
		);
	}

	function readUsageFile(): RecordedEntry[] {
		const usagePath = path.join(tmp, '.swarm', 'skill-usage.jsonl');
		if (!fs.existsSync(usagePath)) return [];
		const raw = fs.readFileSync(usagePath, 'utf-8').trim();
		if (!raw) return [];
		return raw
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as RecordedEntry);
	}

	test('records delegation when architect message contains TO coder with SKILLS field', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			extractTaskIdFromPrompt: () => 'task-arch-1',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'Delegate to coder\nTO coder\nSKILLS: writing-tests\ndo the work',
					},
				],
			},
		]);

		const entries = readUsageFile();
		const delegationEntries = entries.filter(
			(e) => e.complianceVerdict === 'not_checked',
		);
		expect(delegationEntries.length).toBeGreaterThanOrEqual(1);
		expect(delegationEntries[0].skillPath).toBe('writing-tests');
		expect(delegationEntries[0].agentName).toBe('coder');
	});

	test('records delegation for TO reviewer with SKILLS field', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'code,review' ? ['code', 'review'] : [],
			extractTaskIdFromPrompt: () => 'task-arch-review',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO reviewer\nSKILLS: code,review\nreview the PR',
					},
				],
			},
		]);

		const entries = readUsageFile();
		const paths = entries.map((e) => e.skillPath).sort();
		expect(paths).toEqual(['code', 'review']);
		expect(entries[0].agentName).toBe('reviewer');
	});

	test('records delegation for TO test_engineer with SKILLS field', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			extractTaskIdFromPrompt: () => 'task-arch-test',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO test_engineer\nSKILLS: writing-tests\ngenerate tests',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].agentName).toBe('test_engineer');
		expect(entries[0].skillPath).toBe('writing-tests');
	});

	test('records delegation for TO sme with SKILLS field', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'architecture' ? ['architecture'] : [],
			extractTaskIdFromPrompt: () => 'task-arch-sme',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO sme\nSKILLS: architecture\nanalyze this',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].agentName).toBe('sme');
	});

	test('records delegation for TO docs with SKILLS field', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			extractTaskIdFromPrompt: () => 'task-arch-docs',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO docs\nSKILLS: writing-tests\nwrite docs',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].agentName).toBe('docs');
	});

	test('records delegation for TO designer with SKILLS field', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'frontend-design' ? ['frontend-design'] : [],
			extractTaskIdFromPrompt: () => 'task-arch-designer',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO designer\nSKILLS: frontend-design\ndesign the UI',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].agentName).toBe('designer');
	});

	test('does NOT record when SKILLS field is "none"', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
			extractTaskIdFromPrompt: () => 'task-arch-none',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO coder\nSKILLS: none\ndo the work',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries).toHaveLength(0);
	});

	test('does NOT record when SKILLS field is "NONE" (uppercase)', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
			extractTaskIdFromPrompt: () => 'task-arch-upper',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO coder\nSKILLS: NONE\ndo the work',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries).toHaveLength(0);
	});

	test('skips non-architect messages in delegation scan', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			extractTaskIdFromPrompt: () => 'task-skip',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'coder' },
				parts: [
					{
						type: 'text',
						text: 'TO mega_coder\nSKILLS: writing-tests\nwork',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries).toHaveLength(0);
	});

	test('only scans the most recent architect message', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'code' ? ['code'] : v === 'review' ? ['review'] : [],
			extractTaskIdFromPrompt: () => 'task-arch-latest',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO coder\nSKILLS: code\ndo code',
					},
				],
			},
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO reviewer\nSKILLS: review\ndo review',
					},
				],
			},
		]);

		const entries = readUsageFile();
		// Only the last architect message should be processed
		expect(entries.some((e) => e.skillPath === 'code')).toBe(false);
		expect(entries.some((e) => e.skillPath === 'review')).toBe(true);
	});

	test('extracts taskId from architect prompt text', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
			extractTaskIdFromPrompt: () => 'task-from-arch-prompt',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO coder\nSKILLS: writing-tests\ntaskId: task-from-arch-prompt\ndo work',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].taskID).toBe('task-from-arch-prompt');
	});

	test('handles multiple delegations in same architect message', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) => {
				if (v === 'code') return ['code'];
				if (v === 'review') return ['review'];
				return [];
			},
			extractTaskIdFromPrompt: () => 'task-multi',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO coder\nSKILLS: code\ndo code\nTO reviewer\nSKILLS: review\ndo review',
					},
				],
			},
		]);

		const entries = readUsageFile();
		const paths = entries.map((e) => e.skillPath).sort();
		expect(paths).toEqual(['code', 'review']);
		expect(entries.map((e) => e.agentName).sort()).toEqual([
			'coder',
			'reviewer',
		]);
	});

	test('resets target agent and skills field after recording', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) => {
				if (v === 'code') return ['code'];
				if (v === 'docs') return ['docs'];
				return [];
			},
			extractTaskIdFromPrompt: () => 'task-reset',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO coder\nSKILLS: code\ncode work\nTO docs\nSKILLS: docs\ndocs work',
					},
				],
			},
		]);

		const entries = readUsageFile();
		const coderEntries = entries.filter((e) => e.agentName === 'coder');
		const docsEntries = entries.filter((e) => e.agentName === 'docs');
		expect(coderEntries[0].skillPath).toBe('code');
		expect(docsEntries[0].skillPath).toBe('docs');
	});
});

// ============================================================================
// COMPLIANCE_PATTERN edge cases (NEW: Task 4.4)
// ============================================================================

describe('COMPLIANCE_PATTERN edge cases', () => {
	let tmp: string;
	let originals: Override<Internals>;

	beforeEach(() => {
		tmp = tmpDir();
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		originals = {
			appendSkillUsageEntry: _internals.appendSkillUsageEntry,
			parseSkillPaths: _internals.parseSkillPaths,
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

	test('handles hyphen separator (—) in notes', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await skillPropagationTransformScan(
			tmp,
			{
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [
							{
								type: 'text',
								text: 'SKILL_COMPLIANCE: COMPLIANT — notes after em dash',
							},
						],
					},
				] as Parameters<typeof skillPropagationTransformScan>[1]['messages'],
			},
			'session-emdash',
		);

		const usagePath = path.join(tmp, '.swarm', 'skill-usage.jsonl');
		expect(fs.existsSync(usagePath)).toBe(true);
		const lines = fs.readFileSync(usagePath, 'utf-8').trim().split('\n');
		const entry = JSON.parse(lines[lines.length - 1]);
		expect(entry.complianceVerdict).toBe('compliant');
		expect(entry.reviewerNotes).toBe('notes after em dash');
	});

	test('handles hyphen-minus separator (-) in notes', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await skillPropagationTransformScan(
			tmp,
			{
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [
							{
								type: 'text',
								text: 'SKILL_COMPLIANCE: VIOLATED - notes after hyphen',
							},
						],
					},
				] as Parameters<typeof skillPropagationTransformScan>[1]['messages'],
			},
			'session-hyphen',
		);

		const usagePath = path.join(tmp, '.swarm', 'skill-usage.jsonl');
		const lines = fs.readFileSync(usagePath, 'utf-8').trim().split('\n');
		const entry = JSON.parse(lines[lines.length - 1]);
		expect(entry.complianceVerdict).toBe('violated');
		expect(entry.reviewerNotes).toBe('notes after hyphen');
	});

	test('pattern matches without trailing whitespace or newline', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await skillPropagationTransformScan(
			tmp,
			{
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [
							{
								type: 'text',
								text: 'SKILL_COMPLIANCE: COMPLIANT',
							},
						],
					},
				] as Parameters<typeof skillPropagationTransformScan>[1]['messages'],
			},
			'session-no-trail',
		);

		const usagePath = path.join(tmp, '.swarm', 'skill-usage.jsonl');
		const lines = fs.readFileSync(usagePath, 'utf-8').trim().split('\n');
		const entry = JSON.parse(lines[lines.length - 1]);
		expect(entry.complianceVerdict).toBe('compliant');
		expect(entry.reviewerNotes).toBeUndefined();
	});

	test('pattern matches verdict in uppercase', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await skillPropagationTransformScan(
			tmp,
			{
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [
							{
								type: 'text',
								text: 'SKILL_COMPLIANCE: PARTIAL — some partial notes',
							},
						],
					},
				] as Parameters<typeof skillPropagationTransformScan>[1]['messages'],
			},
			'session-uppercase',
		);

		const usagePath = path.join(tmp, '.swarm', 'skill-usage.jsonl');
		const lines = fs.readFileSync(usagePath, 'utf-8').trim().split('\n');
		const entry = JSON.parse(lines[lines.length - 1]);
		expect(entry.complianceVerdict).toBe('partial');
		expect(entry.reviewerNotes).toBe('some partial notes');
	});
});

// ============================================================================
// skillPropagationTransformScan — dedup regression (repeated calls)
// ============================================================================

describe('skillPropagationTransformScan — dedup on repeated calls', () => {
	test('transform scan continues gracefully when readSkillUsageEntries throws', async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-err-'));
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const sessionID = `dedup-err-${Date.now()}`;

		// Override readSkillUsageEntries to throw
		const origRead = _internals.readSkillUsageEntries;
		_internals.readSkillUsageEntries = () => {
			throw new Error('simulated read failure');
		};

		try {
			// Should NOT throw even when read fails
			await _internals.skillPropagationTransformScan(
				tempDir,
				{
					messages: [] as Parameters<
						typeof _internals.skillPropagationTransformScan
					>[1]['messages'],
				},
				sessionID,
			);
			// If we get here, the function handled the error gracefully
			expect(true).toBe(true);
		} finally {
			_internals.readSkillUsageEntries = origRead;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('repeated transform scan calls with same messages do not produce duplicates', async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const sessionID = `dedup-${Date.now()}`;
		const skillPath = 'file:.claude/skills/writing-tests/SKILL.md';

		// Create the mock skill file
		const skillAbsPath = path.join(
			tempDir,
			'.claude',
			'skills',
			'writing-tests',
			'SKILL.md',
		);
		fs.mkdirSync(path.dirname(skillAbsPath), { recursive: true });
		fs.writeFileSync(skillAbsPath, '# Writing Tests Skill\n');

		const messages = [
			{
				info: { role: 'assistant', agent: 'architect', sessionID },
				parts: [
					{ type: 'text', text: `TO coder\nSKILLS: ${skillPath}\nTASK: test` },
				],
			},
			{
				info: { role: 'assistant', agent: 'reviewer', sessionID },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT — all guidelines followed',
					},
				],
			},
		];

		try {
			// Call transform scan 3 times with the same messages
			await _internals.skillPropagationTransformScan(
				tempDir,
				{
					messages: messages as Parameters<
						typeof _internals.skillPropagationTransformScan
					>[1]['messages'],
				},
				sessionID,
			);
			await _internals.skillPropagationTransformScan(
				tempDir,
				{
					messages: messages as Parameters<
						typeof _internals.skillPropagationTransformScan
					>[1]['messages'],
				},
				sessionID,
			);
			await _internals.skillPropagationTransformScan(
				tempDir,
				{
					messages: messages as Parameters<
						typeof _internals.skillPropagationTransformScan
					>[1]['messages'],
				},
				sessionID,
			);

			const entries = readSkillUsageEntries(tempDir, { sessionID });

			// Should have 2-3 entries: 1 architect delegation + 1-2 reviewer compliance
			// NOT 6-9 (which would happen without dedup: 3x2=6 or 3x3=9)
			// First call uses __overall__ (no existing delegation data), subsequent calls
			// attribute compliance to actual skill paths from prior delegation entries.
			expect(entries.length).toBeGreaterThanOrEqual(2);
			expect(entries.length).toBeLessThanOrEqual(3);

			// Exactly 1 delegation entry (coder)
			const delegationEntries = entries.filter((e) => e.agentName === 'coder');
			expect(delegationEntries.length).toBe(1);

			// 1-2 compliance entries — at least one should be attributed to the
			// actual skill path (not __overall__) thanks to the delegation fallback
			const complianceEntries = entries.filter(
				(e) => e.agentName === 'reviewer',
			);
			expect(complianceEntries.length).toBeGreaterThanOrEqual(1);
			expect(complianceEntries.length).toBeLessThanOrEqual(2);
			const actualSkillCompliance = complianceEntries.filter(
				(e) => e.skillPath === skillPath,
			);
			expect(actualSkillCompliance.length).toBeGreaterThanOrEqual(1);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('compliance attribution uses only latest delegation task, not all session entries', async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attribution-'));
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const sessionID = `attr-${Date.now()}`;
		const skillA = 'file:.claude/skills/writing-tests/SKILL.md';
		const skillB = 'file:.claude/skills/engineering-conventions/SKILL.md';

		// Create mock skill files
		for (const sp of [skillA, skillB]) {
			const absPath = path.join(tempDir, sp.replace('file:', ''));
			fs.mkdirSync(path.dirname(absPath), { recursive: true });
			fs.writeFileSync(absPath, '# Skill\n');
		}

		// Pre-record two delegation entries for DIFFERENT tasks
		appendSkillUsageEntry(tempDir, {
			skillPath: skillA,
			agentName: 'coder',
			taskID: 'task-earlier',
			complianceVerdict: 'not_checked',
			sessionID,
			timestamp: new Date().toISOString(),
		});
		appendSkillUsageEntry(tempDir, {
			skillPath: skillB,
			agentName: 'coder',
			taskID: 'task-latest',
			complianceVerdict: 'not_checked',
			sessionID,
			timestamp: new Date().toISOString(),
		});

		// Reviewer message WITHOUT SKILLS_USED_BY_CODER
		const messages = [
			{
				info: { role: 'assistant', agent: 'reviewer', sessionID },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT — all guidelines followed',
					},
				],
			},
		];

		try {
			await _internals.skillPropagationTransformScan(
				tempDir,
				{
					messages: messages as Parameters<
						typeof _internals.skillPropagationTransformScan
					>[1]['messages'],
				},
				sessionID,
			);

			const entries = readSkillUsageEntries(tempDir, { sessionID });
			const complianceEntries = entries.filter(
				(e) => e.agentName === 'reviewer',
			);

			// Compliance should be attributed to skillB (latest delegation) ONLY,
			// NOT to skillA (earlier unrelated task)
			expect(complianceEntries.length).toBeGreaterThanOrEqual(1);
			const compliancePaths = complianceEntries.map((e) => e.skillPath);
			expect(compliancePaths).toContain(skillB);
			expect(compliancePaths).not.toContain(skillA);

			// Compliance entries should carry the latest delegation's taskID,
			// not 'unknown'
			for (const entry of complianceEntries) {
				expect(entry.taskID).toBe('task-latest');
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('compliance uses resolved taskID even when SKILLS_USED_BY_CODER is present', async () => {
		const sessionID = 'test-skills-with-taskid';
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spg-taskid-'));

		const skillPath = 'file:.claude/skills/writing-tests/SKILL.md';

		// Pre-record a delegation entry with a specific taskID
		appendSkillUsageEntry(tempDir, {
			skillPath,
			agentName: 'coder',
			taskID: 'task-5.2',
			complianceVerdict: 'not_checked',
			sessionID,
			timestamp: new Date().toISOString(),
		});

		// Reviewer message WITH SKILLS_USED_BY_CODER — skillPaths are populated
		// from the reviewer text, NOT from the fallback. But taskID should still
		// be resolved from the latest delegation, not 'unknown'.
		const messages = [
			{
				info: { role: 'assistant', agent: 'reviewer', sessionID },
				parts: [
					{
						type: 'text',
						text: `SKILLS_USED_BY_CODER: ${skillPath}\nSKILL_COMPLIANCE: COMPLIANT — all guidelines followed`,
					},
				],
			},
		];

		try {
			await _internals.skillPropagationTransformScan(
				tempDir,
				{
					messages: messages as Parameters<
						typeof _internals.skillPropagationTransformScan
					>[1]['messages'],
				},
				sessionID,
			);

			const entries = readSkillUsageEntries(tempDir, { sessionID });
			const complianceEntries = entries.filter(
				(e) => e.agentName === 'reviewer',
			);

			expect(complianceEntries.length).toBeGreaterThanOrEqual(1);
			// Even though SKILLS_USED_BY_CODER provided the skill paths,
			// the taskID must come from the latest delegation, not 'unknown'
			for (const entry of complianceEntries) {
				expect(entry.taskID).toBe('task-5.2');
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
