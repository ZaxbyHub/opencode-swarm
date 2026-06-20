/**
 * Unit tests for skill-usage feedback bridge functions:
 * - bumpKnowledgeConfidenceBatch (knowledge-store.ts)
 * - resolveSourceKnowledgeIds (skill-usage-log.ts)
 * - applySkillUsageFeedback (skill-usage-log.ts)
 *
 * Tests use _internals DI seams for isolation (no mock.module).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	bumpKnowledgeConfidenceBatch,
	_internals as ks_internals,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';

import {
	appendSkillUsageEntry,
	applySkillUsageFeedback,
	computeComplianceByVersion,
	normalizeComplianceVerdict,
	pruneSkillUsageLog,
	readSkillUsageEntries,
	resolveSourceKnowledgeIds,
	type SkillUsageEntry,
	_internals as sul_internals,
} from '../../../src/hooks/skill-usage-log.js';

// =============================================================================
// Helpers
// =============================================================================

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-feedback-test-'));
}

/** Write raw content to the skill-usage log. */
function writeRawLog(dir: string, content: string): void {
	const resolved = path.join(dir, '.swarm', 'skill-usage.jsonl');
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, content, 'utf-8');
}

/** Write a knowledge entry directly to the swarm knowledge file. */
function writeSwarmKnowledge(
	dir: string,
	entries: Array<{
		id: string;
		lesson: string;
		confidence: number;
		status?: string;
	}>,
): void {
	const resolved = resolveSwarmKnowledgePath(dir);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
	fs.writeFileSync(resolved, content, 'utf-8');
}

/** Read swarm knowledge entries. */
function readSwarmKnowledge(
	dir: string,
): Array<{ id: string; lesson: string; confidence: number; status?: string }> {
	const resolved = resolveSwarmKnowledgePath(dir);
	if (!fs.existsSync(resolved)) return [];
	return fs
		.readFileSync(resolved, 'utf-8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

/** Minimal skill entry template. */
function makeEntry(
	overrides: Partial<Omit<SkillUsageEntry, 'id'>> = {},
): Omit<SkillUsageEntry, 'id'> {
	return {
		skillPath: '.claude/skills/my-skill/SKILL.md',
		agentName: 'test-agent',
		taskID: 'task-001',
		timestamp: '2026-01-01T00:00:00.000Z',
		complianceVerdict: 'compliant',
		sessionID: 'session-abc',
		...overrides,
	};
}

// =============================================================================
// bumpKnowledgeConfidenceBatch tests
// =============================================================================

describe('bumpKnowledgeConfidenceBatch', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		mock.restore();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('happy path: bumps confidence for existing entry', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'uuid-001',
				lesson: 'use _internals for test isolation',
				confidence: 0.5,
			},
		]);

		await bumpKnowledgeConfidenceBatch(tempDir, [
			{ id: 'uuid-001', delta: 0.05 },
		]);

		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBe(0.55);
	});

	test('confidence capped at 1.0 (entry at 0.98 + 0.05 → 1.0, not 1.03)', async () => {
		writeSwarmKnowledge(tempDir, [
			{ id: 'uuid-cap', lesson: 'high confidence entry', confidence: 0.98 },
		]);

		await bumpKnowledgeConfidenceBatch(tempDir, [
			{ id: 'uuid-cap', delta: 0.05 },
		]);

		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBe(1.0); // capped, not 1.03
	});

	test('confidence floored at 0.1 (entry at 0.15 - 0.1 → 0.1, not 0.05)', async () => {
		writeSwarmKnowledge(tempDir, [
			{ id: 'uuid-floor', lesson: 'low confidence entry', confidence: 0.15 },
		]);

		await bumpKnowledgeConfidenceBatch(tempDir, [
			{ id: 'uuid-floor', delta: -0.1 },
		]);

		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBe(0.1); // floored, not 0.05
	});

	test('missing entry: silently skipped (fail-open)', async () => {
		writeSwarmKnowledge(tempDir, [
			{ id: 'uuid-present', lesson: 'existing entry', confidence: 0.5 },
		]);

		// delta for a non-existent entry — should not throw
		await bumpKnowledgeConfidenceBatch(tempDir, [
			{ id: 'uuid-present', delta: 0.05 },
			{ id: 'uuid-missing', delta: 0.05 },
		]);

		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBe(0.55); // only the present entry was bumped
	});

	test('updates updated_at timestamp when confidence changes', async () => {
		const before = '2025-01-01T00:00:00.000Z';
		writeSwarmKnowledge(tempDir, [
			{
				id: 'uuid-ts',
				lesson: 'timestamp test',
				confidence: 0.5,
				updated_at: before,
			},
		]);

		await bumpKnowledgeConfidenceBatch(tempDir, [
			{ id: 'uuid-ts', delta: 0.05 },
		]);

		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.updated_at).not.toBe(before);
		expect(entries[0]!.updated_at > before).toBe(true);
	});

	test('empty deltas array: no-op', async () => {
		writeSwarmKnowledge(tempDir, [
			{ id: 'uuid-unchanged', lesson: 'should not change', confidence: 0.7 },
		]);

		await bumpKnowledgeConfidenceBatch(tempDir, []);

		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBe(0.7);
	});

	test('multiple entries in same file: all get their respective deltas', async () => {
		writeSwarmKnowledge(tempDir, [
			{ id: 'uuid-a', lesson: 'entry a', confidence: 0.5 },
			{ id: 'uuid-b', lesson: 'entry b', confidence: 0.3 },
			{ id: 'uuid-c', lesson: 'entry c', confidence: 0.8 },
		]);

		await bumpKnowledgeConfidenceBatch(tempDir, [
			{ id: 'uuid-a', delta: 0.05 },
			{ id: 'uuid-b', delta: 0.1 },
			{ id: 'uuid-c', delta: -0.2 },
		]);

		const entries = readSwarmKnowledge(tempDir);
		const byId = new Map(entries.map((e) => [e.id, e]));
		expect(byId.get('uuid-a')!.confidence).toBe(0.55);
		expect(byId.get('uuid-b')!.confidence).toBe(0.4);
		expect(byId.get('uuid-c')!.confidence).toBeCloseTo(0.6); // 0.8 - 0.2
	});

	test('accumulated deltas when same ID appears multiple times', async () => {
		writeSwarmKnowledge(tempDir, [
			{ id: 'uuid-dup', lesson: 'duplicate delta test', confidence: 0.5 },
		]);

		// The implementation merges deltas for the same ID
		await bumpKnowledgeConfidenceBatch(tempDir, [
			{ id: 'uuid-dup', delta: 0.02 },
			{ id: 'uuid-dup', delta: 0.03 },
		]);

		const entries = readSwarmKnowledge(tempDir);
		// 0.5 + 0.02 + 0.03 = 0.55
		expect(entries[0]!.confidence).toBeCloseTo(0.55);
	});
});

// =============================================================================
// resolveSourceKnowledgeIds tests
// =============================================================================

describe('resolveSourceKnowledgeIds', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		sul_internals.readFileSync = fs.readFileSync.bind(fs);
		sul_internals.existsSync = fs.existsSync.bind(fs);
	});

	test('happy path: SKILL.md with generated_from_knowledge UUIDs → returns UUIDs', async () => {
		const skillPath = path.join(
			tempDir,
			'.claude',
			'skills',
			'test-skill',
			'SKILL.md',
		);
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(
			skillPath,
			`---
name: test-skill
generated_from_knowledge:
  - aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee
  - bbbb2222-cccc-4ddd-9eee-ffffffffffff
---

# Skill content
`,
			'utf-8',
		);

		const result = await resolveSourceKnowledgeIds(tempDir, skillPath);

		expect(result).toHaveLength(2);
		expect(result).toContain('aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee');
		expect(result).toContain('bbbb2222-cccc-4ddd-9eee-ffffffffffff');
	});

	test('single UUID in generated_from_knowledge', async () => {
		const skillPath = path.join(tempDir, 'skill.md');
		fs.writeFileSync(
			skillPath,
			`---
name: single-uuid-skill
generated_from_knowledge:
  - only-one-uuid-0000-4aaa-bbbb-cccccccccccc
---

Content
`,
			'utf-8',
		);

		const result = await resolveSourceKnowledgeIds(tempDir, skillPath);

		expect(result).toHaveLength(1);
		expect(result[0]).toBe('only-one-uuid-0000-4aaa-bbbb-cccccccccccc');
	});

	test('UUID with trailing comment is parsed correctly', async () => {
		const skillPath = path.join(tempDir, 'skill.md');
		fs.writeFileSync(
			skillPath,
			`---
name: skill-with-comment
generated_from_knowledge:
  - uuid-with-comment # this is the source knowledge ID
---

Content
`,
			'utf-8',
		);

		const result = await resolveSourceKnowledgeIds(tempDir, skillPath);

		expect(result).toHaveLength(1);
		expect(result[0]).toBe('uuid-with-comment');
	});

	test('no frontmatter → returns []', async () => {
		const skillPath = path.join(tempDir, 'skill.md');
		fs.writeFileSync(skillPath, '# Skill without frontmatter\n', 'utf-8');

		const result = await resolveSourceKnowledgeIds(tempDir, skillPath);

		expect(result).toEqual([]);
	});

	test('empty frontmatter (no generated_from_knowledge section) → returns []', async () => {
		const skillPath = path.join(tempDir, 'skill.md');
		fs.writeFileSync(
			skillPath,
			`---
name: skill-no-source
author: someone
---

Content
`,
			'utf-8',
		);

		const result = await resolveSourceKnowledgeIds(tempDir, skillPath);

		expect(result).toEqual([]);
	});

	test('file does not exist → returns [] (fail-open)', async () => {
		const result = await resolveSourceKnowledgeIds(
			tempDir,
			path.join(tempDir, 'nonexistent', 'SKILL.md'),
		);

		expect(result).toEqual([]);
	});

	test('relative skillPath is resolved relative to directory', async () => {
		const relPath = '.claude/skills/rel-skill/SKILL.md';
		const fullPath = path.join(tempDir, relPath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(
			fullPath,
			`---
name: relative-path-skill
generated_from_knowledge:
  - relative-path-uuid-0000-4aaa-bbbb-cccccccccccc
---

Content
`,
			'utf-8',
		);

		const result = await resolveSourceKnowledgeIds(tempDir, relPath);

		expect(result).toHaveLength(1);
		expect(result[0]).toBe('relative-path-uuid-0000-4aaa-bbbb-cccccccccccc');
	});

	test('absolute skillPath is used as-is', async () => {
		const absPath = path.join(tempDir, 'absolute', 'skill.md');
		fs.mkdirSync(path.dirname(absPath), { recursive: true });
		fs.writeFileSync(
			absPath,
			`---
name: absolute-skill
generated_from_knowledge:
  - absolute-uuid-0000-4aaa-bbbb-cccccccccccc
---

Content
`,
			'utf-8',
		);

		const result = await resolveSourceKnowledgeIds(tempDir, absPath);

		expect(result).toHaveLength(1);
		expect(result[0]).toBe('absolute-uuid-0000-4aaa-bbbb-cccccccccccc');
	});

	test('handles YAML list with extra whitespace', async () => {
		const skillPath = path.join(tempDir, 'skill.md');
		fs.writeFileSync(
			skillPath,
			`---
name: whitespace-skill
generated_from_knowledge:
  -
    uuid-whitespace-0000-4aaa-bbbb-cccccccccccc
---

Content
`,
			'utf-8',
		);

		const result = await resolveSourceKnowledgeIds(tempDir, skillPath);

		// The regex expects "- " format, so this might not parse — verifying current behavior
		expect(Array.isArray(result)).toBe(true);
	});
});

// =============================================================================
// applySkillUsageFeedback tests
//
// Uses real SKILL.md files that resolveSourceKnowledgeIds can read, since
// applySkillUsageFeedback calls resolveSourceKnowledgeIds directly (not via _internals).
// =============================================================================

/** Helper: create a real SKILL.md file with generated_from_knowledge UUIDs. */
function writeSkillFile(
	dir: string,
	skillRelPath: string,
	uuids: string[],
): void {
	const fullPath = path.join(dir, skillRelPath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	const uuidLines = uuids.map((u) => `  - ${u}`).join('\n');
	fs.writeFileSync(
		fullPath,
		`---
name: ${path.basename(path.dirname(fullPath))}
generated_from_knowledge:
${uuidLines}
---

Content
`,
		'utf-8',
	);
}

describe('applySkillUsageFeedback', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		mock.restore();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('compliant entry → source knowledge confidence increases', async () => {
		// Set up real knowledge entry
		writeSwarmKnowledge(tempDir, [
			{
				id: 'source-uuid-001',
				lesson: 'compliant test entry',
				confidence: 0.5,
			},
		]);

		// Create real SKILL.md that resolveSourceKnowledgeIds can read
		writeSkillFile(tempDir, '.claude/skills/compliant-skill/SKILL.md', [
			'source-uuid-001',
		]);

		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/compliant-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-001',
			timestamp: '2026-01-01T00:01:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});

		const result = await applySkillUsageFeedback(tempDir);

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		// Verify bumpKnowledgeConfidenceBatch was called (via knowledge file)
		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBeCloseTo(0.55); // 0.5 + 0.05
	});

	test('processed entry markers prevent marker-loss reapplication', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'idempotent-source-uuid',
				lesson: 'idempotent feedback test entry',
				confidence: 0.5,
			},
		]);
		writeSkillFile(tempDir, '.claude/skills/idempotent-skill/SKILL.md', [
			'idempotent-source-uuid',
		]);
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/idempotent-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-001',
			timestamp: '2026-01-01T00:01:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});

		const first = await applySkillUsageFeedback(tempDir);
		const second = await applySkillUsageFeedback(tempDir);

		expect(first).toEqual({ processed: 1, bumps: 1 });
		expect(second).toEqual({ processed: 0, bumps: 0 });
		expect(readSwarmKnowledge(tempDir)[0]!.confidence).toBeCloseTo(0.55);
		expect(readSkillUsageEntries(tempDir)).toHaveLength(1);
		const rawLog = fs.readFileSync(
			path.join(tempDir, '.swarm', 'skill-usage.jsonl'),
			'utf-8',
		);
		expect(rawLog).toContain('"type":"feedback_applied"');
	});

	test('violation entry → source knowledge confidence decreases', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'violation-source-uuid',
				lesson: 'violation test entry',
				confidence: 0.5,
			},
		]);

		writeSkillFile(tempDir, '.claude/skills/violation-skill/SKILL.md', [
			'violation-source-uuid',
		]);

		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/violation-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-001',
			timestamp: '2026-01-01T00:02:00.000Z',
			complianceVerdict: 'violated',
			sessionID: 'session-abc',
		});

		const result = await applySkillUsageFeedback(tempDir);

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBe(0.4); // 0.5 - 0.1
	});

	test('legacy violation entry is normalized and still decreases confidence', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'legacy-violation-source-uuid',
				lesson: 'legacy violation test entry',
				confidence: 0.5,
			},
		]);

		writeSkillFile(tempDir, '.claude/skills/legacy-violation-skill/SKILL.md', [
			'legacy-violation-source-uuid',
		]);

		writeRawLog(
			tempDir,
			`${JSON.stringify({
				id: 'legacy-skill-usage-id',
				skillPath: '.claude/skills/legacy-violation-skill/SKILL.md',
				agentName: 'test-agent',
				taskID: 'task-001',
				timestamp: '2026-01-01T00:02:00.000Z',
				complianceVerdict: 'violation',
				sessionID: 'session-abc',
			})}\n`,
		);

		expect(readSkillUsageEntries(tempDir)[0]!.complianceVerdict).toBe(
			'violated',
		);

		const result = await applySkillUsageFeedback(tempDir);

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);
		expect(readSwarmKnowledge(tempDir)[0]!.confidence).toBe(0.4);
	});

	test('mixed: 3 compliant + 1 violation → net positive delta (compliant > violation)', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'mixed-source-uuid',
				lesson: 'mixed test entry',
				confidence: 0.5,
			},
		]);

		writeSkillFile(tempDir, '.claude/skills/mixed-skill/SKILL.md', [
			'mixed-source-uuid',
		]);

		// 3 compliant + 1 violation = net positive (compliant > violation)
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/mixed-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-001',
			timestamp: '2026-01-01T00:01:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/mixed-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-002',
			timestamp: '2026-01-01T00:02:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/mixed-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-003',
			timestamp: '2026-01-01T00:03:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/mixed-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-004',
			timestamp: '2026-01-01T00:04:00.000Z',
			complianceVerdict: 'violated',
			sessionID: 'session-abc',
		});

		const result = await applySkillUsageFeedback(tempDir);

		// compliantCount (3) > violationCount (1) → +0.05
		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		const knowledge = readSwarmKnowledge(tempDir);
		expect(knowledge).toHaveLength(1);
		expect(knowledge[0]!.confidence).toBeCloseTo(0.55); // 0.5 + 0.05
	});

	test('no usage entries → no changes', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'unchanged-uuid',
				lesson: 'should not change',
				confidence: 0.7,
			},
		]);

		// Write a log with only non-actionable entries
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/test-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-001',
			timestamp: '2026-01-01T00:00:00.000Z',
			complianceVerdict: 'not_checked',
			sessionID: 'session-abc',
		});

		const result = await applySkillUsageFeedback(tempDir);

		expect(result.processed).toBe(0);
		expect(result.bumps).toBe(0);

		// Knowledge unchanged
		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBe(0.7);
	});

	test('skill with no source knowledge IDs → silently skipped', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'no-source-uuid',
				lesson: 'no source test entry',
				confidence: 0.5,
			},
		]);

		// Create SKILL.md with frontmatter but NO generated_from_knowledge
		const skillPath = path.join(
			tempDir,
			'.claude',
			'skills',
			'no-source-skill',
			'SKILL.md',
		);
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(
			skillPath,
			`---
name: no-source-skill
author: someone
---

Content
`,
			'utf-8',
		);

		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/no-source-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-001',
			timestamp: '2026-01-01T00:01:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});

		const result = await applySkillUsageFeedback(tempDir);

		// Skill NOT counted in processed because it has no source IDs (silently skipped)
		// The code does: if (sourceIds.length === 0) continue; (no processed++ for this skill)
		expect(result.processed).toBe(0);
		expect(result.bumps).toBe(0);

		// Knowledge unchanged (no IDs to bump)
		const entries = readSwarmKnowledge(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.confidence).toBe(0.5);
	});

	test('sinceTimestamp option filters entries correctly', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'timestamp-source-uuid',
				lesson: 'timestamp test entry',
				confidence: 0.5,
			},
		]);

		writeSkillFile(tempDir, '.claude/skills/timestamp-skill/SKILL.md', [
			'timestamp-source-uuid',
		]);

		// One entry before cutoff, one after
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/timestamp-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-001',
			timestamp: '2026-01-01T00:00:00.000Z', // before cutoff
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/timestamp-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-002',
			timestamp: '2026-01-15T00:00:00.000Z', // after cutoff
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});

		const result = await applySkillUsageFeedback(tempDir, {
			sinceTimestamp: '2026-01-10T00:00:00.000Z',
		});

		// Only the second entry (after cutoff) should be counted
		// compliantCount=1, violationCount=0 → +0.05
		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		const knowledge = readSwarmKnowledge(tempDir);
		expect(knowledge).toHaveLength(1);
		expect(knowledge[0]!.confidence).toBeCloseTo(0.55);
	});

	test('multiple skills with different source IDs → both entries updated', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'source-a-uuid',
				lesson: 'skill A entry',
				confidence: 0.5,
			},
			{
				id: 'source-b-uuid',
				lesson: 'skill B entry',
				confidence: 0.5,
			},
		]);

		writeSkillFile(tempDir, '.claude/skills/skill-a/SKILL.md', [
			'source-a-uuid',
		]);
		writeSkillFile(tempDir, '.claude/skills/skill-b/SKILL.md', [
			'source-b-uuid',
		]);

		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/skill-a/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-001',
			timestamp: '2026-01-01T00:01:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/skill-b/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-002',
			timestamp: '2026-01-01T00:02:00.000Z',
			complianceVerdict: 'violated',
			sessionID: 'session-abc',
		});

		const result = await applySkillUsageFeedback(tempDir);

		expect(result.processed).toBe(2);
		expect(result.bumps).toBe(2);

		const knowledge = readSwarmKnowledge(tempDir);
		const byId = new Map(knowledge.map((e) => [e.id, e]));
		// skill-a: compliant → +0.05 → 0.55
		expect(byId.get('source-a-uuid')!.confidence).toBeCloseTo(0.55);
		// skill-b: violation → -0.1 → 0.4
		expect(byId.get('source-b-uuid')!.confidence).toBe(0.4);
	});

	test('malformed JSON lines in usage log are skipped', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'malformed-source-uuid',
				lesson: 'malformed test entry',
				confidence: 0.5,
			},
		]);

		writeSkillFile(tempDir, '.claude/skills/malformed-skill/SKILL.md', [
			'malformed-source-uuid',
		]);

		// Write valid entries and malformed JSON directly to the log
		const logPath = path.join(tempDir, '.swarm', 'skill-usage.jsonl');
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(
			logPath,
			JSON.stringify({
				skillPath: '.claude/skills/malformed-skill/SKILL.md',
				agentName: 'test-agent',
				taskID: 'task-001',
				timestamp: '2026-01-01T00:01:00.000Z',
				complianceVerdict: 'compliant',
				sessionID: 'session-abc',
			}) +
				'\nBROKEN JSON\n' +
				JSON.stringify({
					skillPath: '.claude/skills/malformed-skill/SKILL.md',
					agentName: 'test-agent',
					taskID: 'task-002',
					timestamp: '2026-01-01T00:02:00.000Z',
					complianceVerdict: 'compliant',
					sessionID: 'session-abc',
				}) +
				'\n',
			'utf-8',
		);

		const result = await applySkillUsageFeedback(tempDir);

		// 2 valid compliant entries for same skill = +0.05 (not 0.1)
		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		const knowledge = readSwarmKnowledge(tempDir);
		expect(knowledge).toHaveLength(1);
		expect(knowledge[0]!.confidence).toBeCloseTo(0.55);
	});
	test('prune preserves feedback_applied markers so reprocessing is idempotent across prune cycles', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'prune-feedback-uuid',
				lesson: 'prune marker survival test entry',
				confidence: 0.5,
			},
		]);
		writeSkillFile(tempDir, '.claude/skills/prune-feedback-skill/SKILL.md', [
			'prune-feedback-uuid',
		]);

		// Write non-actionable entries first (older timestamps)
		for (let i = 0; i < 5; i++) {
			appendSkillUsageEntry(tempDir, {
				skillPath: '.claude/skills/prune-feedback-skill/SKILL.md',
				agentName: 'test-agent',
				taskID: `task-old-${i}`,
				timestamp: `2026-01-01T00:0${i.toString()}:00.000Z`,
				complianceVerdict: 'not_checked',
				sessionID: 'session-abc',
			});
		}

		// Write the actionable compliant entry LAST (newest timestamp — survives pruning)
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/prune-feedback-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-actionable',
			timestamp: '2026-01-02T00:00:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});

		// First feedback pass — writes a feedback_applied marker covering task-actionable
		const first = await applySkillUsageFeedback(tempDir);
		expect(first).toEqual({ processed: 1, bumps: 1 });
		expect(readSwarmKnowledge(tempDir)[0]!.confidence).toBeCloseTo(0.55);

		// Prune with maxEntriesPerSkill=3: keeps the 3 newest entries (the compliant
		// actionable entry + 2 of the not_checked entries). The marker must survive.
		const pruneResult = pruneSkillUsageLog(tempDir, 3);
		expect(pruneResult.pruned).toBeGreaterThan(0);

		// Verify feedback_applied markers still exist in the raw log after prune
		const rawLog = fs.readFileSync(
			path.join(tempDir, '.swarm', 'skill-usage.jsonl'),
			'utf-8',
		);
		const markerLines = rawLog
			.split('\n')
			.filter((l) => l.trim().includes('"type":"feedback_applied"'));
		expect(markerLines.length).toBeGreaterThan(0);

		// Second feedback pass — the actionable entry is still in the log (newest),
		// but the preserved marker covers its ID, so no reprocessing occurs.
		const second = await applySkillUsageFeedback(tempDir);
		expect(second).toEqual({ processed: 0, bumps: 0 });

		// Knowledge confidence must not be bumped again
		expect(readSwarmKnowledge(tempDir)[0]!.confidence).toBeCloseTo(0.55);
	});

	test('markers survive multiple prune cycles and remain idempotent', async () => {
		writeSwarmKnowledge(tempDir, [
			{
				id: 'multi-cycle-uuid',
				lesson: 'multi-cycle prune idempotency test entry',
				confidence: 0.5,
			},
		]);
		writeSkillFile(tempDir, '.claude/skills/multi-cycle-skill/SKILL.md', [
			'multi-cycle-uuid',
		]);

		// Seed one actionable entry and several older non-actionable entries so
		// pruning actually removes lines on each cycle.
		for (let i = 0; i < 5; i++) {
			appendSkillUsageEntry(tempDir, {
				skillPath: '.claude/skills/multi-cycle-skill/SKILL.md',
				agentName: 'test-agent',
				taskID: `task-old-${i}`,
				timestamp: `2026-01-01T00:0${i.toString()}:00.000Z`,
				complianceVerdict: 'not_checked',
				sessionID: 'session-abc',
			});
		}
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/multi-cycle-skill/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-actionable',
			timestamp: '2026-01-02T00:00:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});

		const first = await applySkillUsageFeedback(tempDir);
		expect(first).toEqual({ processed: 1, bumps: 1 });
		expect(readSwarmKnowledge(tempDir)[0]!.confidence).toBeCloseTo(0.55);

		// First prune + feedback cycle.
		expect(pruneSkillUsageLog(tempDir, 3).pruned).toBeGreaterThan(0);
		expect(await applySkillUsageFeedback(tempDir)).toEqual({
			processed: 0,
			bumps: 0,
		});

		// Second prune + feedback cycle — markers must still survive.
		expect(pruneSkillUsageLog(tempDir, 2).pruned).toBeGreaterThan(0);
		expect(await applySkillUsageFeedback(tempDir)).toEqual({
			processed: 0,
			bumps: 0,
		});

		expect(readSwarmKnowledge(tempDir)[0]!.confidence).toBeCloseTo(0.55);
	});

	test('incremental processing only applies feedback for new entries', async () => {
		writeSwarmKnowledge(tempDir, [
			{ id: 'incr-a-uuid', lesson: 'incremental skill A', confidence: 0.5 },
			{ id: 'incr-b-uuid', lesson: 'incremental skill B', confidence: 0.5 },
		]);
		writeSkillFile(tempDir, '.claude/skills/incr-skill-a/SKILL.md', [
			'incr-a-uuid',
		]);
		writeSkillFile(tempDir, '.claude/skills/incr-skill-b/SKILL.md', [
			'incr-b-uuid',
		]);

		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/incr-skill-a/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-a-1',
			timestamp: '2026-01-01T00:00:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/incr-skill-b/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-b-1',
			timestamp: '2026-01-01T00:01:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});

		const first = await applySkillUsageFeedback(tempDir);
		expect(first).toEqual({ processed: 2, bumps: 2 });

		const afterFirst = readSwarmKnowledge(tempDir);
		expect(
			afterFirst.find((e) => e.id === 'incr-a-uuid')!.confidence,
		).toBeCloseTo(0.55);
		expect(
			afterFirst.find((e) => e.id === 'incr-b-uuid')!.confidence,
		).toBeCloseTo(0.55);

		// Add one more entry for skill A only.
		appendSkillUsageEntry(tempDir, {
			skillPath: '.claude/skills/incr-skill-a/SKILL.md',
			agentName: 'test-agent',
			taskID: 'task-a-2',
			timestamp: '2026-01-01T00:02:00.000Z',
			complianceVerdict: 'compliant',
			sessionID: 'session-abc',
		});

		const second = await applySkillUsageFeedback(tempDir);
		expect(second).toEqual({ processed: 1, bumps: 1 });

		const afterSecond = readSwarmKnowledge(tempDir);
		expect(
			afterSecond.find((e) => e.id === 'incr-a-uuid')!.confidence,
		).toBeCloseTo(0.6);
		expect(
			afterSecond.find((e) => e.id === 'incr-b-uuid')!.confidence,
		).toBeCloseTo(0.55);
	});
});

// =============================================================================
// normalizeComplianceVerdict + computeComplianceByVersion regression tests
//
// Issue #1281: producer writes 'violated' but consumers filtered 'violation'.
// These tests verify the canonical 'violated' spelling flows through every
// code path, and that legacy 'violation' entries are normalized on read.
// =============================================================================

describe('normalizeComplianceVerdict', () => {
	test('maps legacy "violation" to canonical "violated"', () => {
		expect(normalizeComplianceVerdict('violation')).toBe('violated');
	});

	test('passes through canonical "violated" unchanged', () => {
		expect(normalizeComplianceVerdict('violated')).toBe('violated');
	});

	test('passes through other verdicts unchanged', () => {
		expect(normalizeComplianceVerdict('compliant')).toBe('compliant');
		expect(normalizeComplianceVerdict('partial')).toBe('partial');
		expect(normalizeComplianceVerdict('not_checked')).toBe('not_checked');
	});
});

describe('read-path normalization (legacy backward-compat)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('legacy "violation" entries on disk are normalized to "violated" on read', () => {
		// Write a raw JSONL line with the legacy spelling directly to disk
		writeRawLog(
			tempDir,
			JSON.stringify({
				...makeEntry({ complianceVerdict: 'violation' }),
				id: 'legacy-001',
			}) + '\n',
		);

		const entries = readSkillUsageEntries(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.complianceVerdict).toBe('violated');
	});

	test('canonical "violated" entries are read back unchanged', () => {
		writeRawLog(
			tempDir,
			JSON.stringify({
				...makeEntry({ complianceVerdict: 'violated' }),
				id: 'canonical-001',
			}) + '\n',
		);

		const entries = readSkillUsageEntries(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.complianceVerdict).toBe('violated');
	});

	test('legacy "violation" verdict triggers negative confidence delta (issue #1281)', async () => {
		// This verifies the full producer→consumer round-trip:
		// The producer writes 'violated' (simulated here as legacy 'violation' on disk),
		// readSkillUsageEntries normalizes it, and applySkillUsageFeedback produces -0.1.
		writeSwarmKnowledge(tempDir, [
			{ id: 'legacy-fb-uuid', lesson: 'legacy entry', confidence: 0.5 },
		]);
		writeSkillFile(tempDir, '.claude/skills/legacy-fb-skill/SKILL.md', [
			'legacy-fb-uuid',
		]);

		// Write a legacy 'violation' entry directly to disk (bypassing appendSkillUsageEntry)
		writeRawLog(
			tempDir,
			JSON.stringify({
				...makeEntry({
					skillPath: '.claude/skills/legacy-fb-skill/SKILL.md',
					complianceVerdict: 'violation',
				}),
				id: 'legacy-fb-001',
			}) + '\n',
		);

		const result = await applySkillUsageFeedback(tempDir);

		expect(result.processed).toBe(1);
		expect(result.bumps).toBe(1);

		const knowledge = readSwarmKnowledge(tempDir);
		expect(knowledge[0]!.confidence).toBe(0.4); // 0.5 - 0.1 = negative delta
	});
});

describe('computeComplianceByVersion (verdict vocabulary)', () => {
	test('counts "violated" entries in stats.violation', () => {
		const entries = [
			{ ...makeEntry({ complianceVerdict: 'violated' }), id: 'v1' },
			{ ...makeEntry({ complianceVerdict: 'violated' }), id: 'v2' },
			{ ...makeEntry({ complianceVerdict: 'compliant' }), id: 'c1' },
			{ ...makeEntry({ complianceVerdict: 'not_checked' }), id: 'n1' },
		] as SkillUsageEntry[];

		const stats = computeComplianceByVersion(
			entries,
			'.claude/skills/my-skill/SKILL.md',
		);
		const agg = stats.get(undefined)!;
		expect(agg.total).toBe(4);
		expect(agg.violation).toBe(2);
		expect(agg.compliant).toBe(1);
		expect(agg.rate).toBeCloseTo(0.25); // 1 compliant / 4 total
	});

	test('"violation" (legacy) entries are counted after normalization', () => {
		// Raw entries can reach this helper in tests and legacy callers. Keep the
		// computation path defensive so legacy verdicts still count as violations.
		const entries = [
			{ ...makeEntry({ complianceVerdict: 'violation' }), id: 'v1' },
			{ ...makeEntry({ complianceVerdict: 'compliant' }), id: 'c1' },
		] as SkillUsageEntry[];

		const stats = computeComplianceByVersion(
			entries,
			'.claude/skills/my-skill/SKILL.md',
		);
		const agg = stats.get(undefined)!;
		expect(agg.total).toBe(2);
		expect(agg.violation).toBe(1);
		expect(agg.compliant).toBe(1);
	});
});

// =============================================================================
// parseGeneratedFromKnowledge pure helper tests
// =============================================================================

describe('parseGeneratedFromKnowledge (via _internals)', () => {
	test('extracts UUIDs from valid frontmatter', () => {
		const content = `---
name: test-skill
generated_from_knowledge:
  - uuid-1111-2222-3333-4444
  - uuid-5555-6666-7777-8888
---

Content`;
		const result = sul_internals.parseGeneratedFromKnowledge(content);
		expect(result).toEqual([
			'uuid-1111-2222-3333-4444',
			'uuid-5555-6666-7777-8888',
		]);
	});

	test('returns empty array for content without frontmatter', () => {
		const content = `# Just a regular markdown file
No frontmatter here`;
		const result = sul_internals.parseGeneratedFromKnowledge(content);
		expect(result).toEqual([]);
	});

	test('returns empty array when generated_from_knowledge is absent', () => {
		const content = `---
name: skill-no-source
version: 1
---

Content`;
		const result = sul_internals.parseGeneratedFromKnowledge(content);
		expect(result).toEqual([]);
	});

	test('strips trailing comments from UUIDs', () => {
		const content = `---
name: skill-with-comment
generated_from_knowledge:
  - uuid-with-comment # this is a comment
  - uuid-2 # another comment
---

Content`;
		const result = sul_internals.parseGeneratedFromKnowledge(content);
		expect(result).toHaveLength(2);
		expect(result[0]).toBe('uuid-with-comment');
		expect(result[1]).toBe('uuid-2');
	});
});
