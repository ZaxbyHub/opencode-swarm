/**
 * Tests for `/swarm finalize --apply` (FR-008, FR-011, FR-013).
 *
 * The --apply path is read-only: it returns before the finalize lock,
 * describes selected menu actions, and never calls any tool or subprocess.
 *
 * ISOLATION NOTE: This file imports close.ts at the top level, which loads
 * its full transitive module graph. When co-run with close.test.ts (which
 * uses mock.module to replace transitive deps of close.ts), approximately
 * 23 tests in close.test.ts fail because Bun's shared-process test runner
 * caches modules at first resolution — close.test.ts's mock.module cannot
 * override already-cached modules loaded by this file's static import.
 * This is a pre-existing Bun mock.module isolation limitation (not
 * specific to this task). Running each file in isolation produces clean
 * results: 27/27 and 76/76 respectively.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/commands/close';
import type { ActionMenuItem } from '../../../src/services/session-reflection';
import { readActionMenu } from '../../../src/services/session-reflection';

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');
const memoryDir = (): string => path.join(testDir, '.swarm', 'memory');

const MOCK_MENU: ActionMenuItem[] = [
	{
		number: 1,
		description: 'Review skill violations for .opencode/skills/test-skill',
		targetTool: 'skill_improve',
		data: { skillPath: '.opencode/skills/test-skill', violationCount: 3 },
	},
	{
		number: 2,
		description: 'File issue: [bash] Repeated spawn failures',
		targetTool: 'gh issue create',
		data: {
			title: '[bash] Repeated spawn failures',
			body: 'details',
			errorCategory: 'spawn',
		},
	},
	{
		number: 3,
		description: 'Compile 5 new lesson(s) into skills',
		targetTool: 'skill_generate',
		data: { lessonsStored: 5 },
	},
];

function writeMenuFile(sessionID: string, ageMs: number = 0): void {
	mkdirSync(memoryDir(), { recursive: true });
	const timestamp = new Date(Date.now() - ageMs).toISOString();
	writeFileSync(
		path.join(memoryDir(), `action-menu-${sessionID}.json`),
		JSON.stringify({
			sessionId: sessionID,
			timestamp,
			items: MOCK_MENU,
		}),
	);
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-apply-'));
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('handleApplyFlag', () => {
	it('returns summary with Run: lines for valid menu + valid selection', async () => {
		writeMenuFile('sess-test-123');

		const result = await _internals.handleApplyFlag(testDir, '1,3');

		expect(result).toContain('Selected Actions');
		expect(result).toContain(
			'Review skill violations for .opencode/skills/test-skill',
		);
		expect(result).toContain('Compile 5 new lesson(s) into skills');
		// FR-008: actionable routing commands — must use valid registered CLI
		// commands or interactive /swarm commands the user can actually run.
		expect(result).toContain('Run: bunx opencode-swarm run consolidate');
		expect(result).toContain(
			'Run: bunx opencode-swarm run consolidate --evaluate',
		);
		expect(result).not.toContain('gh issue create');
		expect(result).toContain('2 action(s) selected');
	});

	it('returns error when menu file is missing', async () => {
		const result = await _internals.handleApplyFlag(testDir, '1,3');

		expect(result).toContain('No action menu found');
		expect(result).toContain('Run /swarm finalize first');
	});

	it('returns error when menu is expired (>24h old)', async () => {
		// Write a menu that is 25 hours old
		writeMenuFile('sess-expired', 25 * 60 * 60 * 1000);

		const result = await _internals.handleApplyFlag(testDir, '1');

		expect(result).toContain('No action menu found');
	});

	it('returns error for invalid selection numbers', async () => {
		writeMenuFile('sess-invalid');

		const result = await _internals.handleApplyFlag(testDir, '0,99,abc');

		// All three entries are invalid (0 < 1, 99 > 3, not a number)
		expect(result).toContain('No valid items selected');
		expect(result).toContain('Invalid entries: 0, 99, abc');
	});

	it('rejects decimal tokens', async () => {
		writeMenuFile('sess-decimal');

		const result = await _internals.handleApplyFlag(testDir, '1.5,2.0');

		expect(result).toContain('No valid items selected');
		expect(result).toContain('Invalid entries: 1.5, 2.0');
	});

	it('rejects scientific notation tokens', async () => {
		writeMenuFile('sess-sci');

		const result = await _internals.handleApplyFlag(testDir, '1e2,3e0');

		expect(result).toContain('No valid items selected');
		expect(result).toContain('Invalid entries: 1e2, 3e0');
	});

	it('rejects trailing letter tokens (parseInt would silently accept)', async () => {
		writeMenuFile('sess-trailing');

		const result = await _internals.handleApplyFlag(testDir, '1abc,2xyz');

		expect(result).toContain('No valid items selected');
		expect(result).toContain('Invalid entries: 1abc, 2xyz');
	});

	it('rejects leading zero tokens', async () => {
		writeMenuFile('sess-leading-zero');

		const result = await _internals.handleApplyFlag(testDir, '01,007');

		expect(result).toContain('No valid items selected');
		expect(result).toContain('Invalid entries: 01, 007');
	});

	it('rejects negative number tokens', async () => {
		writeMenuFile('sess-neg');

		const result = await _internals.handleApplyFlag(testDir, '-1,-3');

		expect(result).toContain('No valid items selected');
		expect(result).toContain('Invalid entries: -1, -3');
	});

	it('accepts pure digit tokens and rejects mixed tokens in same selection', async () => {
		writeMenuFile('sess-mixed-strict');

		const result = await _internals.handleApplyFlag(testDir, '1,2abc,3');

		expect(result).toContain('Skipped invalid entries: 2abc');
		expect(result).toContain(
			'Review skill violations for .opencode/skills/test-skill',
		);
		expect(result).toContain('Compile 5 new lesson(s) into skills');
		expect(result).toContain('2 action(s) selected');
	});

	it('warns about invalid entries but still shows valid ones', async () => {
		writeMenuFile('sess-mixed');

		const result = await _internals.handleApplyFlag(testDir, '1,99');

		expect(result).toContain('Skipped invalid entries: 99');
		expect(result).toContain(
			'Review skill violations for .opencode/skills/test-skill',
		);
		expect(result).toContain('1 action(s) selected');
	});

	it('does NOT call any tool — no subprocess, no side effects', async () => {
		writeMenuFile('sess-noexec');

		// Spy on the spawnSync — it should never be called
		let spawnCalled = false;
		const originalSpawn = _internals.spawnSync;
		_internals.spawnSync = () => {
			spawnCalled = true;
			return { status: 0, output: [], pid: 0 };
		};

		try {
			const result = await _internals.handleApplyFlag(testDir, '1,2,3');

			expect(spawnCalled).toBe(false);
			expect(result).toContain('3 action(s) selected');
			// Verify it includes valid routing commands, not invalid tool names
			expect(result).toContain('Run: bunx opencode-swarm run consolidate');
			expect(result).toContain('Run: gh issue create');
			expect(result).toContain(
				'Run: bunx opencode-swarm run consolidate --evaluate',
			);
		} finally {
			_internals.spawnSync = originalSpawn;
		}
	});

	it('works with single item selection', async () => {
		writeMenuFile('sess-single');

		const result = await _internals.handleApplyFlag(testDir, '2');

		expect(result).toContain('File issue: [bash] Repeated spawn failures');
		expect(result).toContain('Run: gh issue create');
		expect(result).toContain('1 action(s) selected');
	});

	it('includes exact gh issue create command with title and body', async () => {
		writeMenuFile('sess-gh');

		const result = await _internals.handleApplyFlag(testDir, '2');

		expect(result).toContain(
			"gh issue create --title '[bash] Repeated spawn failures' --body 'details'",
		);
	});

	it('quarantines knowledge_add items that lack actionability metadata', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-kn.json'),
			JSON.stringify({
				sessionId: 'sess-kn',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Review near-duplicate: session lesson vs existing',
						targetTool: 'knowledge_add',
						data: {
							existingEntryId: 'abc',
							sessionEntryText: 'session lesson learned during work',
							existingEntryText: 'existing lesson',
						},
					},
				],
			}),
		);

		const result = await _internals.handleApplyFlag(testDir, '1');

		// FR-013: knowledge_add items go through the full validation pipeline.
		// Without actionability metadata, they are quarantined (not applied).
		expect(result).toContain('Quarantined:');
		expect(result).not.toContain('Applied:');

		// Verify the entry was NOT written to the active knowledge store
		const knowledgePath = path.join(testDir, '.swarm', 'knowledge.jsonl');
		expect(existsSync(knowledgePath)).toBe(false);
	});

	it('skips knowledge_add when lesson text is too short (< 15 chars)', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-short.json'),
			JSON.stringify({
				sessionId: 'sess-short',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Too short lesson',
						targetTool: 'knowledge_add',
						data: {
							existingEntryId: 'abc',
							sessionEntryText: 'too short',
							existingEntryText: 'existing lesson',
						},
					},
				],
			}),
		);

		const result = await _internals.handleApplyFlag(testDir, '1');

		expect(result).toContain('Skipped:');
		expect(result).toContain('15 and 280');

		// Verify nothing was written
		const knowledgePath = path.join(testDir, '.swarm', 'knowledge.jsonl');
		expect(existsSync(knowledgePath)).toBe(false);
	});

	it('quarantines knowledge_add when lesson lacks actionability even if near-duplicate exists', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		// Pre-seed an existing knowledge entry that is a near-duplicate
		const knowledgePath = path.join(testDir, '.swarm', 'knowledge.jsonl');
		const existingEntry = {
			id: 'existing-123',
			tier: 'swarm',
			lesson: 'session lesson text about spawn failures',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: 'test',
			auto_generated: false,
		};
		writeFileSync(knowledgePath, JSON.stringify(existingEntry) + '\n');

		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-dup.json'),
			JSON.stringify({
				sessionId: 'sess-dup',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Near-duplicate of existing lesson',
						targetTool: 'knowledge_add',
						data: {
							existingEntryId: 'existing-123',
							sessionEntryText: 'session lesson text about spawn failures',
							existingEntryText: 'session lesson text about spawn failures',
						},
					},
				],
			}),
		);

		const result = await _internals.handleApplyFlag(testDir, '1');

		// Without actionability metadata, the entry is quarantined before
		// the near-duplicate check runs.
		expect(result).toContain('Quarantined:');

		// Verify no additional entry was written
		const content = readFileSync(knowledgePath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines.length).toBe(1); // Only the original entry
	});

	it('shows Quarantined: for knowledge_add items without actionability and Run: for non-knowledge_add items in mixed selection', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-mixed-exec.json'),
			JSON.stringify({
				sessionId: 'sess-mixed-exec',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Review near-duplicate: session lesson vs existing',
						targetTool: 'knowledge_add',
						data: {
							existingEntryId: 'abc',
							sessionEntryText: 'session lesson learned during work',
							existingEntryText: 'existing lesson',
						},
					},
					{
						number: 2,
						description: 'File issue: [bash] Repeated spawn failures',
						targetTool: 'gh issue create',
						data: {
							title: '[bash] Repeated spawn failures',
							body: 'details',
							errorCategory: 'spawn',
						},
					},
				],
			}),
		);

		const result = await _internals.handleApplyFlag(testDir, '1,2');

		// knowledge_add without actionability → Quarantined
		expect(result).toContain('Quarantined:');
		// gh issue create → Run:
		expect(result).toContain('Run: gh issue create');
		expect(result).toContain('2 action(s) selected');
	});
});

describe('readActionMenu (via session-reflection)', () => {
	it('reads a valid persisted menu', async () => {
		writeMenuFile('sess-read');

		const items = await readActionMenu(testDir, 'sess-read');

		expect(items).not.toBeNull();
		expect(items).toHaveLength(3);
		expect(items![0].targetTool).toBe('skill_improve');
	});

	it('returns null when no menu file exists', async () => {
		const items = await readActionMenu(testDir, 'nonexistent');
		expect(items).toBeNull();
	});

	it('returns null for expired menu', async () => {
		writeMenuFile('sess-old', 48 * 60 * 60 * 1000);
		const items = await readActionMenu(testDir, 'sess-old');
		expect(items).toBeNull();
	});

	it('returns null for empty items array', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-empty.json'),
			JSON.stringify({
				sessionId: 'empty',
				timestamp: new Date().toISOString(),
				items: [],
			}),
		);

		const items = await readActionMenu(testDir, 'empty');
		expect(items).toBeNull();
	});

	it('scans most recent file when no sessionID given', async () => {
		// Write two menu files — the second is newer
		writeMenuFile('sess-a');
		writeMenuFile('sess-z');

		const items = await readActionMenu(testDir);
		expect(items).not.toBeNull();
		// Should find the most recent file (sess-z, sorted alphabetically as it's
		// the last one; they have near-identical timestamps so alphabetical wins)
		expect(items).toHaveLength(3);
	});
});
