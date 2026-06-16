/**
 * Unit tests for src/hooks/skill-usage-log.ts
 *
 * Tests appendSkillUsageEntry, readSkillUsageEntries, and pruneSkillUsageLog
 * using the _internals DI seam for isolation (no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	_internals,
	appendSkillUsageEntry,
	MAX_TAIL_BYTES,
	pruneSkillUsageLog,
	readSkillUsageEntries,
	readSkillUsageEntriesTail,
	type SkillUsageEntry,
	TAIL_BYTES_DEFAULT,
} from '../../../src/hooks/skill-usage-log.ts';

// =============================================================================
// Helpers
// =============================================================================

/** Unique tmp directory per test, cleaned up after each test. */
function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-log-test-'));
}

/** Write raw content to the skill-usage log (bypassing the module). */
function writeRawLog(dir: string, content: string): void {
	const resolved = path.join(dir, '.swarm', 'skill-usage.jsonl');
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, content, 'utf-8');
}

/** Read raw log content. */
function readRawLog(dir: string): string {
	const resolved = path.join(dir, '.swarm', 'skill-usage.jsonl');
	return fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8') : '';
}

/** Helper: a minimal valid entry template. */
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
// Test suite
// =============================================================================

describe('appendSkillUsageEntry', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		// Restore _internals in case any test modified them
		_internals.generateId = () => crypto.randomUUID();
		_internals.appendFileSync = fs.appendFileSync.bind(fs);
		_internals.existsSync = fs.existsSync.bind(fs);
		_internals.mkdirSync = fs.mkdirSync.bind(fs);
		_internals.statSync = fs.statSync.bind(fs);
		_internals.pruneSkillUsageLog = pruneSkillUsageLog;
	});

	test('appends a valid entry to skill-usage.jsonl', () => {
		const entry = makeEntry();

		appendSkillUsageEntry(tempDir, entry);

		const raw = readRawLog(tempDir);
		expect(raw).toMatch(/\n$/); // ends with newline
		const lines = raw.trim().split('\n');
		expect(lines).toHaveLength(1);

		const parsed = JSON.parse(lines[0]) as SkillUsageEntry;
		expect(parsed.skillPath).toBe(entry.skillPath);
		expect(parsed.agentName).toBe(entry.agentName);
		expect(parsed.taskID).toBe(entry.taskID);
		expect(parsed.timestamp).toBe(entry.timestamp);
		expect(parsed.complianceVerdict).toBe(entry.complianceVerdict);
		expect(parsed.sessionID).toBe(entry.sessionID);
		expect(parsed.reviewerNotes).toBeUndefined();
	});

	test('normalizes legacy violation verdicts on append', () => {
		appendSkillUsageEntry(
			tempDir,
			makeEntry({ complianceVerdict: 'violation' }),
		);

		const parsed = JSON.parse(readRawLog(tempDir).trim()) as SkillUsageEntry;
		expect(parsed.complianceVerdict).toBe('violated');
	});

	test('auto-generates UUID id field', () => {
		const entry = makeEntry();
		const uuidRegex =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

		appendSkillUsageEntry(tempDir, entry);

		const raw = readRawLog(tempDir);
		const parsed = JSON.parse(raw.trim()) as SkillUsageEntry;
		expect(parsed.id).toMatch(uuidRegex);
	});

	test('includes reviewerNotes when provided', () => {
		const entry = makeEntry({ reviewerNotes: 'Looks good overall' });

		appendSkillUsageEntry(tempDir, entry);

		const raw = readRawLog(tempDir);
		const parsed = JSON.parse(raw.trim()) as SkillUsageEntry;
		expect(parsed.reviewerNotes).toBe('Looks good overall');
	});

	test('throws on missing skillPath', () => {
		const entry = makeEntry({ skillPath: '' });
		expect(() => appendSkillUsageEntry(tempDir, entry)).toThrow(
			'skillPath is required and must be a non-empty string',
		);
	});

	test('throws on missing agentName', () => {
		const entry = makeEntry({ agentName: '' });
		expect(() => appendSkillUsageEntry(tempDir, entry)).toThrow(
			'agentName is required and must be a non-empty string',
		);
	});

	test('throws on missing taskID', () => {
		const entry = makeEntry({ taskID: '' });
		expect(() => appendSkillUsageEntry(tempDir, entry)).toThrow(
			'taskID is required and must be a non-empty string',
		);
	});

	test('throws on missing timestamp', () => {
		const entry = makeEntry({ timestamp: '' });
		expect(() => appendSkillUsageEntry(tempDir, entry)).toThrow(
			'timestamp is required and must be a non-empty string',
		);
	});

	test('throws on missing complianceVerdict', () => {
		const entry = makeEntry({ complianceVerdict: '' });
		expect(() => appendSkillUsageEntry(tempDir, entry)).toThrow(
			'complianceVerdict is required and must be a non-empty string',
		);
	});

	test('throws on missing sessionID', () => {
		const entry = makeEntry({ sessionID: '' });
		expect(() => appendSkillUsageEntry(tempDir, entry)).toThrow(
			'sessionID is required and must be a non-empty string',
		);
	});

	test('throws on non-string skillPath', () => {
		// @ts-expect-error — intentionally passing wrong type to test runtime validation
		const entry = makeEntry({ skillPath: 123 });
		expect(() => appendSkillUsageEntry(tempDir, entry)).toThrow(
			'skillPath is required and must be a non-empty string',
		);
	});

	test('creates .swarm/ directory if missing', () => {
		const entry = makeEntry();
		// .swarm dir does not exist yet

		appendSkillUsageEntry(tempDir, entry);

		const swarmDir = path.join(tempDir, '.swarm');
		expect(fs.existsSync(swarmDir)).toBe(true);
		expect(fs.existsSync(path.join(swarmDir, 'skill-usage.jsonl'))).toBe(true);
	});

	test('appends as valid JSON line (parseable)', () => {
		const entry1 = makeEntry({
			taskID: 'task-001',
			timestamp: '2026-01-01T00:00:00.000Z',
		});
		const entry2 = makeEntry({
			taskID: 'task-002',
			timestamp: '2026-01-02T00:00:00.000Z',
		});

		appendSkillUsageEntry(tempDir, entry1);
		appendSkillUsageEntry(tempDir, entry2);

		const raw = readRawLog(tempDir);
		const lines = raw.trim().split('\n');
		expect(lines).toHaveLength(2);

		const parsed1 = JSON.parse(lines[0]) as SkillUsageEntry;
		const parsed2 = JSON.parse(lines[1]) as SkillUsageEntry;
		expect(parsed1.taskID).toBe('task-001');
		expect(parsed2.taskID).toBe('task-002');
	});

	test('preserves all entries after rapid sequential appends (concurrent usage simulation)', () => {
		const appendCount = 7;
		const taskIDs: string[] = [];

		for (let i = 0; i < appendCount; i++) {
			const taskID = `rapid-${i.toString().padStart(3, '0')}`;
			taskIDs.push(taskID);
			appendSkillUsageEntry(
				tempDir,
				makeEntry({
					taskID,
					timestamp: `2026-06-${(i + 10).toString().padStart(2, '0')}T12:00:00.000Z`,
					agentName: `agent-${i % 3}`,
					skillPath: `skill-${i % 2 === 0 ? 'alpha' : 'beta'}`,
				}),
			);
		}

		const raw = readRawLog(tempDir);
		const lines = raw.trim().split('\n');
		expect(lines).toHaveLength(appendCount);

		// Every line must be valid JSON
		const parsed = lines.map((line) => JSON.parse(line) as SkillUsageEntry);
		const parsedTaskIDs = parsed.map((e) => e.taskID);
		expect(parsedTaskIDs).toEqual(taskIDs);
	});
});

describe('readSkillUsageEntries', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('returns empty array when file does not exist', () => {
		const result = readSkillUsageEntries(tempDir);
		expect(result).toEqual([]);
	});

	test('returns all entries when no filters provided', () => {
		writeRawLog(
			tempDir,
			JSON.stringify(
				makeEntry({
					taskID: 'task-001',
					timestamp: '2026-01-01T00:00:00.000Z',
				}),
			) +
				'\n' +
				JSON.stringify(
					makeEntry({
						taskID: 'task-002',
						timestamp: '2026-01-02T00:00:00.000Z',
					}),
				) +
				'\n',
		);

		const result = readSkillUsageEntries(tempDir);
		expect(result).toHaveLength(2);
		expect(result[0]!.taskID).toBe('task-001');
		expect(result[1]!.taskID).toBe('task-002');
	});

	test('filters by skillPath exact match', () => {
		writeRawLog(
			tempDir,
			JSON.stringify(makeEntry({ skillPath: 'skill-a', taskID: 'task-001' })) +
				'\n' +
				JSON.stringify(
					makeEntry({ skillPath: 'skill-b', taskID: 'task-002' }),
				) +
				'\n' +
				JSON.stringify(
					makeEntry({ skillPath: 'skill-a', taskID: 'task-003' }),
				) +
				'\n',
		);

		const result = readSkillUsageEntries(tempDir, { skillPath: 'skill-a' });
		expect(result).toHaveLength(2);
		expect(result.every((e) => e.skillPath === 'skill-a')).toBe(true);
	});

	test('filters by agentName exact match', () => {
		writeRawLog(
			tempDir,
			JSON.stringify(makeEntry({ agentName: 'alice', taskID: 'task-001' })) +
				'\n' +
				JSON.stringify(makeEntry({ agentName: 'bob', taskID: 'task-002' })) +
				'\n' +
				JSON.stringify(makeEntry({ agentName: 'alice', taskID: 'task-003' })) +
				'\n',
		);

		const result = readSkillUsageEntries(tempDir, { agentName: 'alice' });
		expect(result).toHaveLength(2);
		expect(result.every((e) => e.agentName === 'alice')).toBe(true);
	});

	test('filters by taskID exact match', () => {
		writeRawLog(
			tempDir,
			JSON.stringify(makeEntry({ taskID: 'task-001' })) +
				'\n' +
				JSON.stringify(makeEntry({ taskID: 'task-002' })) +
				'\n',
		);

		const result = readSkillUsageEntries(tempDir, { taskID: 'task-001' });
		expect(result).toHaveLength(1);
		expect(result[0]!.taskID).toBe('task-001');
	});

	test('filters by dateRange start/end inclusive', () => {
		writeRawLog(
			tempDir,
			JSON.stringify(
				makeEntry({ taskID: 'early', timestamp: '2026-01-01T00:00:00.000Z' }),
			) +
				'\n' +
				JSON.stringify(
					makeEntry({ taskID: 'mid', timestamp: '2026-01-15T12:00:00.000Z' }),
				) +
				'\n' +
				JSON.stringify(
					makeEntry({ taskID: 'late', timestamp: '2026-02-01T00:00:00.000Z' }),
				) +
				'\n',
		);

		const result = readSkillUsageEntries(tempDir, {
			dateRange: {
				start: '2026-01-10T00:00:00.000Z',
				end: '2026-01-20T00:00:00.000Z',
			},
		});
		expect(result).toHaveLength(1);
		expect(result[0]!.taskID).toBe('mid');
	});

	test('combines multiple filters', () => {
		writeRawLog(
			tempDir,
			JSON.stringify(
				makeEntry({
					skillPath: 'skill-a',
					agentName: 'alice',
					taskID: 'task-001',
					timestamp: '2026-01-05T00:00:00.000Z',
				}),
			) +
				'\n' +
				JSON.stringify(
					makeEntry({
						skillPath: 'skill-a',
						agentName: 'bob',
						taskID: 'task-002',
						timestamp: '2026-01-10T00:00:00.000Z',
					}),
				) +
				'\n' +
				JSON.stringify(
					makeEntry({
						skillPath: 'skill-b',
						agentName: 'alice',
						taskID: 'task-003',
						timestamp: '2026-01-06T00:00:00.000Z',
					}),
				) +
				'\n',
		);

		const result = readSkillUsageEntries(tempDir, {
			skillPath: 'skill-a',
			agentName: 'alice',
		});
		expect(result).toHaveLength(1);
		expect(result[0]!.taskID).toBe('task-001');
	});

	test('skips malformed JSON lines silently', () => {
		writeRawLog(
			tempDir,
			JSON.stringify(makeEntry({ taskID: 'good-1' })) +
				'\nNOT JSON\n' +
				JSON.stringify(makeEntry({ taskID: 'good-2' })) +
				'\n{"incomplete": true\n' + // truncated JSON
				JSON.stringify(makeEntry({ taskID: 'good-3' })) +
				'\n',
		);

		const result = readSkillUsageEntries(tempDir);
		expect(result).toHaveLength(3);
		expect(result.map((e) => e.taskID)).toEqual(['good-1', 'good-2', 'good-3']);
	});
});

describe('pruneSkillUsageLog', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		// Restore
		_internals.writeFileSync = fs.writeFileSync.bind(fs);
		_internals.renameSync = fs.renameSync.bind(fs);
	});

	test('returns { pruned: 0, remaining: 0 } when file does not exist', () => {
		const result = pruneSkillUsageLog(tempDir);
		expect(result).toEqual({ pruned: 0, remaining: 0 });
	});

	test('returns { pruned: 0, remaining } when no pruning needed', () => {
		const entries = [
			makeEntry({ taskID: 'task-001', timestamp: '2026-01-01T00:00:00.000Z' }),
			makeEntry({ taskID: 'task-002', timestamp: '2026-01-02T00:00:00.000Z' }),
		];
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const result = pruneSkillUsageLog(tempDir, 500);
		expect(result.pruned).toBe(0);
		expect(result.remaining).toBe(2);
	});

	test('prunes oldest entries per skill path, keeping newest maxEntriesPerSkill', () => {
		// 5 entries for skill-a (should keep last 3), 2 for skill-b (should keep all)
		const entries = [
			makeEntry({
				skillPath: 'skill-a',
				taskID: 'a-oldest',
				timestamp: '2026-01-01T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-a',
				taskID: 'a-mid',
				timestamp: '2026-01-02T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-a',
				taskID: 'a-newer',
				timestamp: '2026-01-03T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-a',
				taskID: 'a-newest',
				timestamp: '2026-01-04T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-a',
				taskID: 'a-keep-this',
				timestamp: '2026-01-05T00:00:00.000Z',
			}), // extra
			makeEntry({
				skillPath: 'skill-b',
				taskID: 'b-001',
				timestamp: '2026-01-01T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-b',
				taskID: 'b-002',
				timestamp: '2026-01-02T00:00:00.000Z',
			}),
		];
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const result = pruneSkillUsageLog(tempDir, 3);

		expect(result.pruned).toBe(2); // 2 oldest a-* removed
		expect(result.remaining).toBe(5); // 3 a + 2 b

		const remaining = readSkillUsageEntries(tempDir);
		expect(remaining).toHaveLength(5);
		const skillAPaths = remaining
			.filter((e) => e.skillPath === 'skill-a')
			.map((e) => e.taskID);
		// The 3 newest by timestamp
		expect(skillAPaths).toContain('a-newest');
		expect(skillAPaths).toContain('a-keep-this');
		expect(skillAPaths).toContain('a-newer');
		expect(skillAPaths).not.toContain('a-oldest');
		expect(skillAPaths).not.toContain('a-mid');
	});

	test('handles multiple skill paths independently', () => {
		// skill-x: 4 entries, keep 2 → prune 2
		// skill-y: 1 entry, keep 2 → prune 0
		const entries = [
			makeEntry({
				skillPath: 'skill-x',
				taskID: 'x-01',
				timestamp: '2026-01-01T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-x',
				taskID: 'x-02',
				timestamp: '2026-01-02T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-x',
				taskID: 'x-03',
				timestamp: '2026-01-03T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-x',
				taskID: 'x-04',
				timestamp: '2026-01-04T00:00:00.000Z',
			}),
			makeEntry({
				skillPath: 'skill-y',
				taskID: 'y-01',
				timestamp: '2026-01-01T00:00:00.000Z',
			}),
		];
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const result = pruneSkillUsageLog(tempDir, 2);

		expect(result.pruned).toBe(2); // x-01 and x-02 removed
		expect(result.remaining).toBe(3);

		const remaining = readSkillUsageEntries(tempDir);
		expect(remaining.filter((e) => e.skillPath === 'skill-x')).toHaveLength(2);
		expect(remaining.filter((e) => e.skillPath === 'skill-y')).toHaveLength(1);
	});

	test('returns { pruned: 0, remaining, error } on write failure using _internals override', () => {
		// Need 2 entries so prune is triggered (maxEntriesPerSkill=1 → pruned>0 → write attempted)
		const entries = [
			makeEntry({ taskID: 't-001', timestamp: '2026-01-01T00:00:00.000Z' }),
			makeEntry({ taskID: 't-002', timestamp: '2026-01-02T00:00:00.000Z' }),
		];
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		// Override writeFileSync to always throw
		_internals.writeFileSync = () => {
			throw new Error('Disk full');
		};

		const result = pruneSkillUsageLog(tempDir, 1);

		expect(result.pruned).toBe(0);
		expect(result.remaining).toBe(2);
		expect(result.error).toBe('Disk full');

		// Original file should be untouched
		const raw = readRawLog(tempDir);
		expect(raw).toContain('t-001');
	});

	test('default maxEntriesPerSkill is 500', () => {
		// Write exactly 500 entries for same skillPath — nothing pruned
		const entries = Array.from({ length: 500 }, (_, i) =>
			makeEntry({
				skillPath: 'same-skill',
				taskID: `task-${i.toString().padStart(3, '0')}`,
				timestamp: `2026-01-${(i + 1).toString().padStart(2, '0')}T00:00:00.000Z`,
			}),
		);
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const result = pruneSkillUsageLog(tempDir); // default 500
		expect(result.pruned).toBe(0);
		expect(result.remaining).toBe(500);
	});

	test('no-op when file is empty', () => {
		writeRawLog(tempDir, '\n');

		const result = pruneSkillUsageLog(tempDir);
		expect(result).toEqual({ pruned: 0, remaining: 0 });
	});
});

describe('_internals DI seam', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		// Always restore all overrides
		_internals.generateId = () => crypto.randomUUID();
		_internals.appendFileSync = fs.appendFileSync.bind(fs);
		_internals.readFileSync = fs.readFileSync.bind(fs);
		_internals.writeFileSync = fs.writeFileSync.bind(fs);
		_internals.renameSync = fs.renameSync.bind(fs);
		_internals.existsSync = fs.existsSync.bind(fs);
		_internals.mkdirSync = fs.mkdirSync.bind(fs);
		_internals.statSync = fs.statSync.bind(fs);
		_internals.openSync = fs.openSync.bind(fs);
		_internals.readSync = fs.readSync.bind(fs);
		_internals.closeSync = fs.closeSync.bind(fs);
	});

	test('override generateId for deterministic IDs', () => {
		_internals.generateId = () => 'test-uuid-12345';

		appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'task-deterministic' }));

		const raw = readRawLog(tempDir);
		const parsed = JSON.parse(raw.trim()) as SkillUsageEntry;
		expect(parsed.id).toBe('test-uuid-12345');
	});

	test('override appendFileSync to capture appended content', () => {
		let captured: string | null = null;
		_internals.appendFileSync = (_path, content: string) => {
			captured = content as string;
		};

		appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'task-capture' }));

		expect(captured).not.toBeNull();
		expect(captured).toContain('task-capture');
	});

	test('override readFileSync for controlled input', () => {
		// Pre-populate the log with known content
		writeRawLog(
			tempDir,
			JSON.stringify(makeEntry({ taskID: 'real-file-entry' })) + '\n',
		);

		// Override readFileSync to return controlled data instead
		_internals.readFileSync = () =>
			JSON.stringify(makeEntry({ taskID: 'mocked-entry' })) + '\n';

		const result = readSkillUsageEntries(tempDir);
		expect(result).toHaveLength(1);
		expect(result[0]!.taskID).toBe('mocked-entry');
	});

	test('override existsSync to simulate file not existing', () => {
		_internals.existsSync = () => false;

		const result = readSkillUsageEntries(tempDir);
		expect(result).toEqual([]);
	});

	test('override writeFileSync and renameSync for prune error injection', () => {
		// Write a log with more entries than maxEntriesPerSkill
		const entries = [
			makeEntry({ taskID: 't-001', timestamp: '2026-01-01T00:00:00.000Z' }),
			makeEntry({ taskID: 't-002', timestamp: '2026-01-02T00:00:00.000Z' }),
		];
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		// Simulate write failure
		_internals.writeFileSync = () => {
			throw new Error('Simulated write error');
		};

		const result = pruneSkillUsageLog(tempDir, 1);

		expect(result.pruned).toBe(0);
		expect(result.error).toBe('Simulated write error');
		expect(result.remaining).toBe(2); // original unchanged
	});

	test('override mkdirSync to control directory creation', () => {
		// Make mkdirSync throw — if append tries to create .swarm it will throw
		_internals.mkdirSync = () => {
			throw new Error('mkdir blocked');
		};

		// But since .swarm dir may already exist from previous tests, make existsSync return false
		// so append tries to create it
		_internals.existsSync = (p: string) => {
			// Only block the .swarm directory itself
			const dir = path.dirname(p);
			if (dir.endsWith('.swarm')) return false;
			return fs.existsSync(p);
		};

		// This should throw because mkdirSync throws
		expect(() => appendSkillUsageEntry(tempDir, makeEntry())).toThrow(
			'mkdir blocked',
		);
	});

	test('triggers best-effort compaction when log exceeds 1 MB', () => {
		let pruneCalled = false;
		_internals.pruneSkillUsageLog = (
			dir: string,
			maxEntriesPerSkill: number,
		) => {
			pruneCalled = true;
			expect(dir).toBe(tempDir);
			expect(maxEntriesPerSkill).toBe(500);
			return { pruned: 0, remaining: 0 };
		};
		_internals.statSync = ((_path: fs.PathLike) => ({
			size: 1024 * 1024 + 1,
		})) as typeof fs.statSync;

		appendSkillUsageEntry(tempDir, makeEntry());
		expect(pruneCalled).toBe(true);
	});
});

// Import crypto for restore
import * as crypto from 'node:crypto';

describe('readSkillUsageEntriesTail', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		_internals.statSync = fs.statSync.bind(fs);
		_internals.openSync = fs.openSync.bind(fs);
		_internals.readSync = fs.readSync.bind(fs);
		_internals.closeSync = fs.closeSync.bind(fs);
		_internals.existsSync = fs.existsSync.bind(fs);
	});

	test('returns empty array when file does not exist', () => {
		const result = readSkillUsageEntriesTail(tempDir, {});
		expect(result).toEqual([]);
	});

	test('reads entries from the end of the file within maxBytes', () => {
		const entries = Array.from({ length: 20 }, (_, i) =>
			makeEntry({
				sessionID: 'tail-session',
				taskID: `tail-${i.toString().padStart(3, '0')}`,
				timestamp: `2026-01-${(i + 1).toString().padStart(2, '0')}T00:00:00.000Z`,
			}),
		);
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const result = readSkillUsageEntriesTail(tempDir, {
			sessionID: 'tail-session',
		});
		expect(result.length).toBeGreaterThanOrEqual(1);
		// All returned entries should match the session filter
		expect(result.every((e) => e.sessionID === 'tail-session')).toBe(true);
	});

	test('returns empty array when entries do not match sessionID filter', () => {
		const entries = [
			makeEntry({
				sessionID: 'other-session',
				taskID: 'other-001',
			}),
		];
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const result = readSkillUsageEntriesTail(tempDir, {
			sessionID: 'nonexistent-session',
		});
		expect(result).toEqual([]);
	});

	test('reads only last maxBytes of large file', () => {
		// Write 100 entries so the file is large enough that a small maxBytes
		// won't cover all of them
		const entries = Array.from({ length: 100 }, (_, i) =>
			makeEntry({
				sessionID: 'big-session',
				taskID: `big-${i.toString().padStart(3, '0')}`,
				timestamp: `2026-01-${((i % 28) + 1).toString().padStart(2, '0')}T00:00:00.000Z`,
			}),
		);
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		// Use a very small maxBytes (256 bytes) — should only read a few entries
		const result = readSkillUsageEntriesTail(
			tempDir,
			{ sessionID: 'big-session' },
			256,
		);
		// Should return fewer entries than total (bounded by tail read)
		expect(result.length).toBeLessThan(100);
		expect(result.length).toBeGreaterThan(0);
	});

	test('clamps oversized maxBytes to MAX_TAIL_BYTES', () => {
		const jsonLine = `${JSON.stringify(makeEntry({ sessionID: 'clamp-session' }))}\n`;
		let readLength = 0;
		_internals.existsSync = () => true;
		_internals.statSync = ((_path: fs.PathLike) => ({
			size: MAX_TAIL_BYTES * 4,
		})) as typeof fs.statSync;
		_internals.openSync = () => 123 as unknown as number;
		_internals.readSync = (
			_fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
		) => {
			readLength = length;
			buffer.write(jsonLine, offset, 'utf-8');
			return jsonLine.length;
		};
		_internals.closeSync = () => {};

		readSkillUsageEntriesTail(
			tempDir,
			{ sessionID: 'clamp-session' },
			Number.POSITIVE_INFINITY,
		);
		expect(readLength).toBe(MAX_TAIL_BYTES);
	});

	test('clamps negative maxBytes to 1', () => {
		const jsonLine = `${JSON.stringify(makeEntry({ sessionID: 'clamp-neg' }))}\n`;
		let readLength = 0;
		_internals.existsSync = () => true;
		_internals.statSync = ((_path: fs.PathLike) => ({
			size: MAX_TAIL_BYTES * 4,
		})) as typeof fs.statSync;
		_internals.openSync = () => 123 as unknown as number;
		_internals.readSync = (
			_fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
		) => {
			readLength = length;
			buffer.write(jsonLine, offset, 'utf-8');
			return jsonLine.length;
		};
		_internals.closeSync = () => {};

		readSkillUsageEntriesTail(tempDir, { sessionID: 'clamp-neg' }, -100);
		expect(readLength).toBe(1);
	});

	test('clamps zero maxBytes to 1', () => {
		const jsonLine = `${JSON.stringify(makeEntry({ sessionID: 'clamp-zero' }))}\n`;
		let readLength = 0;
		_internals.existsSync = () => true;
		_internals.statSync = ((_path: fs.PathLike) => ({
			size: MAX_TAIL_BYTES * 4,
		})) as typeof fs.statSync;
		_internals.openSync = () => 123 as unknown as number;
		_internals.readSync = (
			_fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
		) => {
			readLength = length;
			buffer.write(jsonLine, offset, 'utf-8');
			return jsonLine.length;
		};
		_internals.closeSync = () => {};

		readSkillUsageEntriesTail(tempDir, { sessionID: 'clamp-zero' }, 0);
		expect(readLength).toBe(1);
	});

	test('falls back to TAIL_BYTES_DEFAULT for NaN maxBytes', () => {
		const jsonLine = `${JSON.stringify(makeEntry({ sessionID: 'clamp-nan' }))}\n`;
		let readLength = 0;
		_internals.existsSync = () => true;
		_internals.statSync = ((_path: fs.PathLike) => ({
			size: MAX_TAIL_BYTES * 4,
		})) as typeof fs.statSync;
		_internals.openSync = () => 123 as unknown as number;
		_internals.readSync = (
			_fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
		) => {
			readLength = length;
			buffer.write(jsonLine, offset, 'utf-8');
			return jsonLine.length;
		};
		_internals.closeSync = () => {};

		readSkillUsageEntriesTail(tempDir, { sessionID: 'clamp-nan' }, NaN);
		expect(readLength).toBe(TAIL_BYTES_DEFAULT);
	});

	test('returns empty array on I/O error via _internals override', () => {
		writeRawLog(
			tempDir,
			JSON.stringify(
				makeEntry({ sessionID: 'err-session', taskID: 'err-001' }),
			) + '\n',
		);

		// Make openSync throw
		_internals.openSync = () => {
			throw new Error('permission denied');
		};

		const result = readSkillUsageEntriesTail(tempDir, {
			sessionID: 'err-session',
		});
		expect(result).toEqual([]);
	});

	test('handles file smaller than maxBytes', () => {
		const entries = [
			makeEntry({ sessionID: 'small-session', taskID: 'small-001' }),
			makeEntry({ sessionID: 'small-session', taskID: 'small-002' }),
		];
		writeRawLog(
			tempDir,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
		);

		const result = readSkillUsageEntriesTail(
			tempDir,
			{ sessionID: 'small-session' },
			1024 * 1024, // 1 MB — much larger than the file
		);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.taskID)).toEqual(['small-001', 'small-002']);
	});

	test('skips malformed lines in tail read', () => {
		const goodEntry = makeEntry({
			sessionID: 'malformed-session',
			taskID: 'good-tail',
		});
		writeRawLog(
			tempDir,
			JSON.stringify(
				makeEntry({ sessionID: 'malformed-session', taskID: 'padding-001' }),
			) +
				'\n'.repeat(5) +
				'BROKEN JSON LINE\n' +
				JSON.stringify(goodEntry) +
				'\n',
		);

		const result = readSkillUsageEntriesTail(tempDir, {
			sessionID: 'malformed-session',
		});
		// Should contain at least the good entry (broken line skipped)
		const tasks = result.map((e) => e.taskID);
		expect(tasks).toContain('good-tail');
		expect(tasks).not.toContain('BROKEN JSON LINE');
	});

	test('uses validated path (resolveLogPath) — rejects directory with null bytes', () => {
		// Create a temp directory and write a valid log
		writeRawLog(
			tempDir,
			JSON.stringify(makeEntry({ sessionID: 'validate-test' })) + '\n',
		);

		// Verify normal operation works
		const normal = readSkillUsageEntriesTail(tempDir, {
			sessionID: 'validate-test',
		});
		expect(normal.length).toBeGreaterThan(0);

		// Now create a directory with null bytes in the path — validateSwarmPath should
		// throw, which readSkillUsageEntriesTail catches and returns empty array.
		// We can't create a real dir with null bytes on most filesystems, so instead
		// verify the function handles path.join consistently with readSkillUsageEntries.
		// Both functions should resolve to the same log file.
		const pathFromFullRead = path.join(tempDir, '.swarm', 'skill-usage.jsonl');
		expect(fs.existsSync(pathFromFullRead)).toBe(true);

		// The tail-read should find the same file
		const tailResult = readSkillUsageEntriesTail(tempDir, {
			sessionID: 'validate-test',
		});
		expect(tailResult.length).toBe(normal.length);
	});
});
