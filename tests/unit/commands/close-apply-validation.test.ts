/**
 * Tests for the full validation pipeline used by /swarm finalize --apply
 * when applying knowledge_add items. Verifies that the shared
 * applyKnowledgeEntry function runs the same validation as the knowledge_add
 * tool: 15-280 char bounds, actionability gate, near-duplicate dedup.
 *
 * ISOLATION NOTE: This file imports close.ts at the top level, which loads
 * its full transitive module graph. See close-apply-flag.test.ts for details.
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
import { _internals, handleCloseCommand } from '../../../src/commands/close';

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');
const memoryDir = (): string => path.join(testDir, '.swarm', 'memory');

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-apply-val-'));
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('handleApplyFlag --apply full validation pipeline', () => {
	it('skips knowledge_add when lesson text exceeds 280 chars', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		const longLesson = 'A'.repeat(281);
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-long.json'),
			JSON.stringify({
				sessionId: 'sess-long',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Too long lesson',
						targetTool: 'knowledge_add',
						data: {
							existingEntryId: 'abc',
							sessionEntryText: longLesson,
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

	it('quarantines knowledge_add when lesson lacks actionability metadata', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-valid.json'),
			JSON.stringify({
				sessionId: 'sess-valid',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Valid lesson from session reflection',
						targetTool: 'knowledge_add',
						data: {
							existingEntryId: 'abc',
							sessionEntryText:
								'Always use path.join for cross-platform file paths in scripts',
							existingEntryText: 'existing lesson',
						},
					},
				],
			}),
		);

		const result = await _internals.handleApplyFlag(testDir, '1');

		// Without actionability metadata, applyKnowledgeEntry quarantines the lesson
		expect(result).toContain('Quarantined:');
		expect(result).not.toContain('Applied:');

		// Verify the entry was NOT written to the active knowledge store
		const knowledgePath = path.join(testDir, '.swarm', 'knowledge.jsonl');
		expect(existsSync(knowledgePath)).toBe(false);
	});

	it('persists knowledge entry to knowledge.jsonl via --apply with actionability metadata', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		const lesson =
			'Always use path.join for cross-platform file paths in scripts';
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-persist.json'),
			JSON.stringify({
				sessionId: 'sess-persist',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: `Review near-duplicate: ${lesson}`,
						targetTool: 'knowledge_add',
						data: {
							existingEntryId: 'abc-123',
							sessionEntryText: lesson,
							existingEntryText: 'existing lesson about paths',
							required_actions: [
								'compare knowledge entry abc-123 against new session lesson for semantic overlap',
							],
							applies_to_agents: ['coder'],
							verification_checks: [
								'knowledge.jsonl contains an entry referencing abc-123',
							],
						},
					},
				],
			}),
		);

		const result = await _internals.handleApplyFlag(testDir, '1');

		expect(result).toContain('Applied:');
		expect(result).toContain('lesson written to knowledge.jsonl');

		// Verify the entry was persisted to knowledge.jsonl
		const knowledgePath = path.join(testDir, '.swarm', 'knowledge.jsonl');
		expect(existsSync(knowledgePath)).toBe(true);

		const content = readFileSync(knowledgePath, 'utf-8');
		const lines = content.trim().split('\n');
		expect(lines.length).toBe(1);

		const entry = JSON.parse(lines[0]);
		expect(entry.lesson).toBe(lesson);
		expect(entry.category).toBe('process');
		expect(entry.status).toBe('candidate');
		expect(entry.required_actions).toEqual([
			'compare knowledge entry abc-123 against new session lesson for semantic overlap',
		]);
		expect(entry.applies_to_agents).toEqual(['coder']);
		expect(entry.verification_checks).toEqual([
			'knowledge.jsonl contains an entry referencing abc-123',
		]);
	});
});

describe('handleCloseCommand --apply routing', () => {
	it('routes --apply before lock acquisition', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-route.json'),
			JSON.stringify({
				sessionId: 'sess-route',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Review skill violations',
						targetTool: 'skill_improve',
						data: {
							skillPath: '.opencode/skills/test-skill',
							violationCount: 3,
						},
					},
					{
						number: 2,
						description: 'File issue',
						targetTool: 'gh issue create',
						data: { title: 'Test issue', body: 'details' },
					},
					{
						number: 3,
						description: 'Compile lessons',
						targetTool: 'skill_generate',
						data: { lessonsStored: 2 },
					},
				],
			}),
		);

		let lockAcquired = false;
		const originalLock = _internals.acquireFinalizeLock;
		_internals.acquireFinalizeLock = async () => {
			lockAcquired = true;
			return { acquired: true };
		};

		try {
			const result = await handleCloseCommand(testDir, ['--apply', '1,3']);

			expect(lockAcquired).toBe(false);
			expect(result).toContain('Selected Actions');
			expect(result).toContain('Run: bunx opencode-swarm run consolidate');
		} finally {
			_internals.acquireFinalizeLock = originalLock;
		}
	});

	it('returns error for bare --apply with no selection arg', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-bare2.json'),
			JSON.stringify({
				sessionId: 'sess-bare2',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Test action',
						targetTool: 'skill_improve',
						data: { skillPath: '.opencode/skills/test' },
					},
				],
			}),
		);

		let lockAcquired = false;
		const originalLock = _internals.acquireFinalizeLock;
		_internals.acquireFinalizeLock = async () => {
			lockAcquired = true;
			return { acquired: true };
		};

		try {
			const result = await handleCloseCommand(testDir, ['--apply']);

			expect(lockAcquired).toBe(false);
			expect(result).toContain('Error: --apply requires a selection');
		} finally {
			_internals.acquireFinalizeLock = originalLock;
		}
	});

	it('returns error for --apply with empty string selection', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-empty2.json'),
			JSON.stringify({
				sessionId: 'sess-empty2',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Test action',
						targetTool: 'skill_improve',
						data: { skillPath: '.opencode/skills/test' },
					},
				],
			}),
		);

		let lockAcquired = false;
		const originalLock = _internals.acquireFinalizeLock;
		_internals.acquireFinalizeLock = async () => {
			lockAcquired = true;
			return { acquired: true };
		};

		try {
			const result = await handleCloseCommand(testDir, ['--apply', '']);

			expect(lockAcquired).toBe(false);
			expect(result).toContain('Error: --apply requires a selection');
		} finally {
			_internals.acquireFinalizeLock = originalLock;
		}
	});

	it('returns error for --apply with whitespace-only selection', async () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(
			path.join(memoryDir(), 'action-menu-sess-ws.json'),
			JSON.stringify({
				sessionId: 'sess-ws',
				timestamp: new Date().toISOString(),
				items: [
					{
						number: 1,
						description: 'Test action',
						targetTool: 'skill_improve',
						data: { skillPath: '.opencode/skills/test' },
					},
				],
			}),
		);

		let lockAcquired = false;
		const originalLock = _internals.acquireFinalizeLock;
		_internals.acquireFinalizeLock = async () => {
			lockAcquired = true;
			return { acquired: true };
		};

		try {
			const result = await handleCloseCommand(testDir, ['--apply', '   ']);

			expect(lockAcquired).toBe(false);
			expect(result).toContain('Error: --apply requires a selection');
		} finally {
			_internals.acquireFinalizeLock = originalLock;
		}
	});
});
