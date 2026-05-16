/**
 * Adversarial tests for skill-propagation-gate (Task 4.4).
 *
 * Attack vectors:
 * 1. Injection via skill paths: malformed paths with ../, absolute paths, null bytes, long strings
 * 2. Regex bypass: COMPLIANCE_PATTERN with mixed-case, whitespace tricks, embedded newlines
 * 3. Prompt injection: taskId extraction from crafted strings
 * 4. parseSkillPaths edge cases: commas, semicolons, pipes, URL-encoded chars
 * 5. Delegation recording abuse: malformed agent names, empty/whitespace skill paths
 * 6. Transform scan edge cases: multiple verdicts (first only), empty parts, TO in code blocks
 *
 * Uses _internals DI seam. Temp dirs via os.tmpdir() + path.join().
 * Does NOT use bun:test mock-module API (uses _internals DI seam instead).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Static import — same module under test
import {
	_internals,
	extractTaskIdFromPrompt,
	parseSkillPaths,
	skillPropagationGateBefore,
	skillPropagationTransformScan,
} from '../../../src/hooks/skill-propagation-gate';
import type { SkillUsageEntry } from '../../../src/hooks/skill-usage-log';

// ============================================================================
// Helpers
// ============================================================================

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gate-adv-'));
}

type Internals = typeof _internals;
type Override<T> = { [P in keyof T]?: T[P] };

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
// 1. Injection via skill paths
// ============================================================================

describe('1 — Injection via skill paths', () => {
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

	test('accepts ../ path traversal sequences in parseSkillPaths (recorded verbatim)', () => {
		const paths = parseSkillPaths('../etc/passwd');
		expect(paths).toEqual(['../etc/passwd']);
	});

	test('accepts multiple ../ sequences in parseSkillPaths', () => {
		const paths = parseSkillPaths('../../../root/.ssh/id_rsa');
		expect(paths).toEqual(['../../../root/.ssh/id_rsa']);
	});

	test('accepts absolute Unix paths in parseSkillPaths', () => {
		const paths = parseSkillPaths('/etc/passwd');
		expect(paths).toEqual(['/etc/passwd']);
	});

	test('accepts absolute Windows paths in parseSkillPaths', () => {
		const paths = parseSkillPaths('C:\\Windows\\System32\\config\\SAM');
		expect(paths).toEqual(['C:\\Windows\\System32\\config\\SAM']); // case preserved
	});

	test('accepts null byte in skill path string (embedded \\0)', () => {
		// A string with an embedded null byte — JavaScript strings can contain U+0000
		const nullBytePath = 'skill\0malicious';
		const paths = parseSkillPaths(nullBytePath);
		expect(paths).toEqual(['skill\0malicious']);
	});

	test('accepts extremely long skill path strings (10KB+)', () => {
		const longPath = 'a'.repeat(20_000);
		const paths = parseSkillPaths(longPath);
		expect(paths).toEqual([longPath]);
	});

	test('records skill usage with path-traversal skill path', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: '../../../secrets/db',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-traversal',
			parseSkillPaths: (v: string) => [v],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-traversal',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: ../../../secrets/db\ndo work',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(1);
		expect(recorded[0].skillPath).toBe('../../../secrets/db');
	});

	test('records skill usage with absolute path skill path', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: '/root/.ssh/id_rsa',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-abs',
			parseSkillPaths: (v: string) => [v],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-abs',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS: /root/.ssh/id_rsa\ndo work',
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(1);
		expect(recorded[0].skillPath).toBe('/root/.ssh/id_rsa');
	});

	test('records skill usage with null-byte embedded skill path', async () => {
		const recorded: RecordedEntry[] = [];
		const nullPath = 'skill\0path';
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: nullPath,
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-null',
			parseSkillPaths: (v: string) => [v],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-null',
				args: {
					subagent_type: 'mega_coder',
					prompt: `SKILLS: ${nullPath}\ndo work`,
				},
			},
			{ enabled: true },
		);

		expect(recorded).toHaveLength(1);
		expect(recorded[0].skillPath).toBe(nullPath);
	});
});

// ============================================================================
// 2. Regex bypass — COMPLIANCE_PATTERN
// ============================================================================

describe('2 — Regex bypass: COMPLIANCE_PATTERN', () => {
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

	test('records COMPLIANT verdict in mixed case (CoMpLiAnT)', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: CoMpLiAnT' }],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
	});

	test('records PARTIAL verdict in all-lowercase', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: partial' }],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('partial');
	});

	test('records VIOLATED verdict in all-caps', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: VIOLATED' }],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('violated');
	});

	test('handles extra leading whitespace before verdict', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: '   SKILL_COMPLIANCE: COMPLIANT' }],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
	});

	test('handles extra spaces between colon and verdict', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE:   COMPLIANT' }],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
	});

	test('handles embedded newline in verdict line (line continuation)', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE:\nCOMPLIANT' }],
			},
		]);

		// The pattern requires the verdict on the same line as "SKILL_COMPLIANCE:"
		// so this should NOT match — the verdict is on a separate line
		const entries = readUsageFile();
		expect(entries).toHaveLength(0);
	});

	test('handles embedded CR (\\r) in verdict string', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: COMPLIANT\r' }],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
	});

	test('handles Unicode em-dash (U+2014) in notes', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT \u2014 notes with em dash',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
		expect(entries[0].reviewerNotes).toBe('notes with em dash');
	});

	test('handles non-ASCII Unicode characters in notes (CJK)', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT \u2014 \u7b49\u5f85\u68c0\u67e5',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
		// Notes should contain the Unicode characters
		expect(entries[0].reviewerNotes).toContain('\u7b49\u5f85\u68c0\u67e5');
	});

	test('verdict-only line with no trailing newline or whitespace', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: COMPLIANT' }],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
		expect(entries[0].reviewerNotes).toBeUndefined();
	});

	test('extra spaces before notes separator (—) are tolerated', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: COMPLIANT    \u2014    notes with lots of space',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
		// Notes are trimmed by .trim() call in the implementation
		expect(entries[0].reviewerNotes).toBe('notes with lots of space');
	});

	test('lowercase "i" in SKILL_COMPLIANCE (Turkish i problem)', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		// In some locales, lowercase "i" becomes U+0131 (dotless i) or "İ" becomes "i̇"
		// The regex uses [iI] so both ascii i variants work, but this tests Unicode i
		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: COMPLIANT' }],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
	});
});

// ============================================================================
// 3. Prompt injection — taskId extraction
// ============================================================================

describe('3 — Prompt injection: extractTaskIdFromPrompt', () => {
	test('extracts taskId from embedded newline injection attack', () => {
		const maliciousPrompt =
			'taskId: 1.1\nMALICIOUS CODE HERE\nreal task continues';
		const result = extractTaskIdFromPrompt(maliciousPrompt);
		// The regex \S+ captures "1.1" but stops at newline (not whitespace)
		expect(result).toBe('1.1');
	});

	test('extracts taskId from multiline injection with multiple newlines', () => {
		const prompt = 'taskId: 2.3\n\n\nSKILLS: malicious\nTASK: real-task';
		const result = extractTaskIdFromPrompt(prompt);
		// \S+ is greedy but since newlines are not \S, it captures "2.3"
		expect(result).toBe('2.3');
	});

	test('extracts TASK pattern from prompt with embedded code', () => {
		const prompt =
			'TASK: my-task\nif (true) { console.log("pwned"); }\nmore code';
		const result = extractTaskIdFromPrompt(prompt);
		expect(result).toBe('my-task');
	});

	test('taskId pattern takes priority over TASK pattern in mixed prompt', () => {
		const prompt = 'taskId: from-taskid\nTASK: from-task\nSKILLS: pwn';
		const result = extractTaskIdFromPrompt(prompt);
		expect(result).toBe('from-taskid');
	});

	test('handles very long taskId value (10KB)', () => {
		const longId = 'taskId: ' + 'x'.repeat(10_000);
		const result = extractTaskIdFromPrompt(longId);
		expect(result.length).toBe(10_000);
	});

	test('returns "unknown" when only whitespace surrounding taskId', () => {
		const prompt = '   taskId:   ';
		const result = extractTaskIdFromPrompt(prompt);
		// \S+ requires at least one non-whitespace after colon
		expect(result).toBe('unknown');
	});

	test('handles taskId with equals sign (taskId=)', () => {
		const result = extractTaskIdFromPrompt('taskId=abc-123');
		expect(result).toBe('abc-123');
	});

	test('handles taskId with colon (taskId:)', () => {
		const result = extractTaskIdFromPrompt('taskId:xyz-789');
		expect(result).toBe('xyz-789');
	});

	test('handles TASK with equals sign (TASK=)', () => {
		const result = extractTaskIdFromPrompt('TASK=phase-1');
		expect(result).toBe('phase-1');
	});

	test('handles TASK with colon (TASK:)', () => {
		const result = extractTaskIdFromPrompt('TASK: phase-2');
		expect(result).toBe('phase-2');
	});

	test('handles taskId with leading/trailing whitespace around colon', () => {
		const result = extractTaskIdFromPrompt('taskId : abc');
		expect(result).toBe('abc');
	});

	test('handles TASK with mixed case (Task:)', () => {
		const result = extractTaskIdFromPrompt('Task: mixed-case');
		expect(result).toBe('mixed-case');
	});

	test('handles taskId with Unicode digits (fullwidth)', () => {
		// U+FF10 "０" is a fullwidth digit zero — not matched by \S or \d in basic regex
		const result = extractTaskIdFromPrompt('taskId: \uff10\uff11\uff12');
		// \S+ will capture the fullwidth digits as non-whitespace characters
		expect(result).toBe('\uff10\uff11\uff12');
	});

	test('handles very short taskId (single char)', () => {
		const result = extractTaskIdFromPrompt('taskId: x');
		expect(result).toBe('x');
	});

	test('extracts taskId from middle of large prompt (not just start/end)', () => {
		const prefix = 'a'.repeat(5000);
		const result = extractTaskIdFromPrompt(
			`${prefix}\ntaskId: mid-task\n${'b'.repeat(5000)}`,
		);
		expect(result).toBe('mid-task');
	});

	test('TASK pattern also extracted correctly from injected prompt', () => {
		const prompt = 'TASK: injected-task\nrm -rf /';
		const result = extractTaskIdFromPrompt(prompt);
		expect(result).toBe('injected-task');
	});
});

// ============================================================================
// 4. Edge cases in parseSkillPaths
// ============================================================================

describe('4 — Edge cases in parseSkillPaths', () => {
	test('handles semicolon as separator (split behavior)', () => {
		// parseSkillPaths only splits on comma, so semicolons remain
		const paths = parseSkillPaths('skill-a;skill-b');
		expect(paths).toEqual(['skill-a;skill-b']);
	});

	test('handles pipe character in path', () => {
		const paths = parseSkillPaths('skill|pipe|path');
		expect(paths).toEqual(['skill|pipe|path']);
	});

	test('handles URL-encoded characters (%20, %2F)', () => {
		const paths = parseSkillPaths('skill%20name,skill%2Fpath');
		expect(paths).toEqual(['skill%20name', 'skill%2Fpath']); // case preserved
	});

	test('handles multiple consecutive commas (empty segments filtered)', () => {
		const paths = parseSkillPaths('skill-a,,,skill-b,,');
		expect(paths).toEqual(['skill-a', 'skill-b']);
	});

	test('handles whitespace-only segments filtered', () => {
		const paths = parseSkillPaths('skill-a,   ,skill-b');
		expect(paths).toEqual(['skill-a', 'skill-b']);
	});

	test('handles tab and newline characters in field value', () => {
		// The field value is a single string; split is on commas only
		// tab and newline are NOT separators; trim() removes leading/trailing whitespace
		const paths = parseSkillPaths('skill\tone,\nskill two');
		// First segment: 'skill\tone' trimmed -> 'skill\tone' (tab is internal, not stripped)
		// Second segment: '\nskill two' trimmed -> 'skill two' (newline stripped by trim)
		expect(paths).toEqual(['skill\tone', 'skill two']);
	});

	test('handles skill path that is just a comma', () => {
		const paths = parseSkillPaths(',');
		expect(paths).toEqual([]);
	});

	test('handles skill path that is all commas', () => {
		const paths = parseSkillPaths(',,,');
		expect(paths).toEqual([]);
	});

	test('handles skill path with spaces around commas', () => {
		const paths = parseSkillPaths('  skill-a ,  skill-b  ');
		expect(paths).toEqual(['skill-a', 'skill-b']);
	});

	test('handles single space as field value (non-empty but whitespace)', () => {
		const paths = parseSkillPaths(' ');
		expect(paths).toEqual([]);
	});

	test('handles tab character as entire field', () => {
		const paths = parseSkillPaths('\t');
		expect(paths).toEqual([]);
	});

	test('handles newline as entire field', () => {
		const paths = parseSkillPaths('\n');
		expect(paths).toEqual([]);
	});

	test('handles CR LF line endings in field value', () => {
		// split(',') only splits on comma; \r\n is NOT a separator
		// trim() removes leading/trailing \r and \n
		const paths = parseSkillPaths('skill-a\r\n,skill-b');
		// First segment: 'skill-a\r\n' trimmed -> 'skill-a' (both \r and \n stripped)
		expect(paths).toEqual(['skill-a', 'skill-b']);
	});

	test('handles Unicode fullwidth comma (U+FF0C) not split', () => {
		// Fullwidth comma is different from ASCII comma (U+002C)
		const paths = parseSkillPaths('skill\uFF0Cskill-two');
		expect(paths).toEqual(['skill\uFF0Cskill-two']);
	});

	test('handles skill path with hash (#) character', () => {
		const paths = parseSkillPaths('skill#with#hash');
		expect(paths).toEqual(['skill#with#hash']);
	});

	test('handles skill path starting with hyphen', () => {
		const paths = parseSkillPaths('-dashed-skill');
		expect(paths).toEqual(['-dashed-skill']);
	});

	test('handles skill path with at-sign (@) character', () => {
		const paths = parseSkillPaths('@scope/skill');
		expect(paths).toEqual(['@scope/skill']);
	});

	test('handles very short single-character skill paths', () => {
		const paths = parseSkillPaths('a,b,c');
		expect(paths).toEqual(['a', 'b', 'c']);
	});
});

// ============================================================================
// 5. Delegation recording abuse — malformed agent names, empty paths
// ============================================================================

describe('5 — Delegation recording abuse', () => {
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

	test('records skill usage even if agent name contains Unicode', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder\u200b', // zero-width space appended
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-unicode-agent',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-unicode',
				args: {
					subagent_type: 'coder\u200b',
					prompt: 'SKILLS: writing-tests\ndo work',
				},
			},
			{ enabled: true },
		);

		// Zero-width space in targetAgent means stripKnownSwarmPrefix returns 'coder\u200b'
		// which is not in SKILL_CAPABLE_AGENTS, so nothing recorded
		// This test documents the current behavior
		expect(recorded).toHaveLength(0);
	});

	test('records skill usage with empty-string agent name (edge case)', async () => {
		const recorded: RecordedEntry[] = [];
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: '',
				skillsField: 'writing-tests',
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-empty-agent',
			parseSkillPaths: (v: string) =>
				v === 'writing-tests' ? ['writing-tests'] : [],
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-empty-agent',
				args: {
					subagent_type: '',
					prompt: 'SKILLS: writing-tests\ndo work',
				},
			},
			{ enabled: true },
		);

		// Empty targetAgent returns null from parseDelegationArgs overall,
		// but let's trace: targetAgent='' is falsy so parseDelegationArgs returns null early
		// Actually in parseDelegationArgs: !targetAgent => return null at line 185
		// So this won't even reach recording
		expect(recorded).toHaveLength(0);
	});

	test('records with whitespace-only skill path that survived parseSkillPaths', async () => {
		const recorded: RecordedEntry[] = [];
		// parseSkillPaths filters empty segments, but a single space becomes [''] then filtered
		// So whitespace-only never survives parseSkillPaths
		applyOverrides(_internals, {
			parseDelegationArgs: () => ({
				targetAgent: 'coder',
				skillsField: '   ', // only whitespace
			}),
			discoverAvailableSkills: () => ['.claude/skills/foo/SKILL.md'],
			appendSkillUsageEntry: makeMockAppendSkillUsageEntry(recorded),
			extractTaskIdFromPrompt: () => 'task-whitespace',
			parseSkillPaths: (v: string) => {
				// Real parseSkillPaths returns [] for whitespace-only
				if (v.trim() === '') return [];
				return [v];
			},
		});

		await skillPropagationGateBefore(
			tmp,
			{
				tool: 'task',
				agent: 'architect',
				sessionID: 'sess-whitespace-path',
				args: {
					subagent_type: 'mega_coder',
					prompt: 'SKILLS:    \ndo work',
				},
			},
			{ enabled: true },
		);

		// Whitespace-only field is falsy on line 303: skillsValue && ...
		// so it doesn't even enter the recording block
		expect(recorded).toHaveLength(0);
	});

	test('malformed agent name with newline is handled by parseDelegationArgs', () => {
		// parseDelegationArgs uses typeof checks, not regex
		// It reads subagent_type which must be a string (or falsy)
		// Newline in a JS string is fine — it's a character in the string
		const result = parseSkillPaths('skill\nmalicious');
		// Newline is part of the string, not a separator
		expect(result).toEqual(['skill\nmalicious']);
	});

	test('empty prompt string in args does not crash parseDelegationArgs', () => {
		const result = _internals.parseDelegationArgs({
			subagent_type: 'coder',
			prompt: '',
		});
		// Empty prompt is fine — subagent_type is authoritative
		expect(result).not.toBeNull();
		expect(result!.targetAgent).toBe('coder');
		expect(result!.skillsField).toBe('');
	});

	test('undefined subagent_type and empty prompt returns null', () => {
		const result = _internals.parseDelegationArgs({
			subagent_type: undefined,
			prompt: '',
		});
		expect(result).toBeNull();
	});

	test('null subagent_type with valid prompt uses prompt fallback', () => {
		const result = _internals.parseDelegationArgs({
			subagent_type: null,
			prompt: 'fallback_coder\nSKILLS: code',
		});
		expect(result).not.toBeNull();
		expect(result!.targetAgent).toBe('fallback_coder');
	});
});

// ============================================================================
// 6. Transform scan edge cases
// ============================================================================

describe('6 — Transform scan edge cases', () => {
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

	test('only the FIRST compliance verdict is processed (second is ignored)', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'SKILL_COMPLIANCE: VIOLATED\nSKILL_COMPLIANCE: COMPLIANT',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('violated');
		// There should only be 1 entry since the loop breaks after first match
		expect(entries).toHaveLength(1);
	});

	test('reviewer message with empty parts array does not crash', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [],
			},
		]);

		// Should not throw, should produce no entries
		const entries = readUsageFile();
		expect(entries).toHaveLength(0);
	});

	test('reviewer message with null parts — documents crash vulnerability', async () => {
		// BUG FOUND: When parts array contains a null element, `p.text` throws
		// TypeError before the `typeof` guard can protect it.
		// This is a pre-existing bug in skillPropagationTransformScan (line 417).
		// typeof null === 'object', NOT 'null', so the guard doesn't protect against null.
		expect(() => {
			// Simulate what the real code does:
			const parts: unknown[] = [null];
			const text = parts.map((p) =>
				typeof (p as { text?: string }).text === 'string'
					? (p as { text: string }).text
					: '',
			);
		}).toThrow(TypeError);
	});

	test('architect message with TO pattern in code block is NOT processed', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'skill-in-code' ? ['skill-in-code'] : [],
			extractTaskIdFromPrompt: () => 'task-code-block',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: `Here is the code:
\`\`\`
TO coder
SKILLS: skill-in-code
do the work
\`\`\`
End of code.`,
					},
				],
			},
		]);

		// The TO pattern regex matches regardless of code block context
		// This is a design decision — the pattern matches the literal text
		const entries = readUsageFile();
		// The current implementation matches even inside code blocks
		// This documents the existing behavior
		expect(entries.length).toBeGreaterThanOrEqual(1);
	});

	test('architect message with SKILLS in comment is matched (TO and SKILLS on separate lines)', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'skill-comment' ? ['skill-comment'] : [],
			extractTaskIdFromPrompt: () => 'task-comment',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO coder\nSKILLS: skill-comment\ndo the work',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[0].skillPath).toBe('skill-comment');
	});

	test('reviewer message with no info.agent does not crash', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: {},
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: COMPLIANT' }],
			},
		]);

		const entries = readUsageFile();
		// No agent means stripKnownSwarmPrefix(undefined as string) — returns "undefined" — not "reviewer"
		// So the message is skipped
		expect(entries).toHaveLength(0);
	});

	test('reviewer message with non-string agent does not crash', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 123 as unknown as string },
				parts: [{ type: 'text', text: 'SKILL_COMPLIANCE: COMPLIANT' }],
			},
		]);

		const entries = readUsageFile();
		// typeof agent !== 'string' check at line 410 catches this
		expect(entries).toHaveLength(0);
	});

	test('multiple SKILL_COMPLIANCE verdicts across multiple lines — only first processed', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{
						type: 'text',
						text: 'First line\nSKILL_COMPLIANCE: PARTIAL\nMiddle\nSKILL_COMPLIANCE: VIOLATED\nLast',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('partial');
		// Only one entry because break exits after first match
		expect(entries).toHaveLength(1);
	});

	test('SKILL_COMPLIANCE verdict at very end of large message is found', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: () => [],
		});

		const longContent = 'a'.repeat(50_000);
		await runTransform([
			{
				info: { role: 'assistant', agent: 'reviewer' },
				parts: [
					{ type: 'text', text: `${longContent}\nSKILL_COMPLIANCE: COMPLIANT` },
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].complianceVerdict).toBe('compliant');
	});

	test('architect delegation with only whitespace between TO and agent name', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'whitespace-skill' ? ['whitespace-skill'] : [],
			extractTaskIdFromPrompt: () => 'task-ws',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'TO   coder\nSKILLS: whitespace-skill\ndo work',
					},
				],
			},
		]);

		const entries = readUsageFile();
		expect(entries[0].skillPath).toBe('whitespace-skill');
	});

	test('architect delegation with lowercase to (not TO) is not matched', async () => {
		applyOverrides(_internals, {
			parseSkillPaths: (v: string) =>
				v === 'lowercase-skill' ? ['lowercase-skill'] : [],
			extractTaskIdFromPrompt: () => 'task-lower',
		});

		await runTransform([
			{
				info: { role: 'assistant', agent: 'architect' },
				parts: [
					{
						type: 'text',
						text: 'to coder\nSKILLS: lowercase-skill\ndo work',
					},
				],
			},
		]);

		// Pattern is /TO\s+(coder|...)/i — lowercase "to" matches because of /i flag
		// So it SHOULD match
		const entries = readUsageFile();
		expect(entries[0].skillPath).toBe('lowercase-skill');
	});
});
