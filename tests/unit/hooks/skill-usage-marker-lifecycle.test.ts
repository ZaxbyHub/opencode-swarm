/**
 * Issue #2038 (Observability PR 10/23) — marker lifecycle and crash/edge
 * coverage for `.swarm/skill-usage.jsonl` (FR-006 split from
 * skill-usage-global-bound.test.ts).
 *
 * Groups:
 *  - marker lifecycle (correctness class survives budgets; processed markers
 *    age out by reference liveness; dead references drop; duplicates dedup)
 *  - crash/edge (torn tail, corrupt lines, multi-project isolation,
 *    determinism, restart, manifest counter folding)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_resetMaintenanceState,
	appendSkillUsageEntry,
	pruneSkillUsageLog,
	readSkillUsageEntries,
	SKILL_USAGE_LIMITS,
	type SkillUsageEntry,
} from '../../../src/hooks/skill-usage-log.js';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SMALL_LIMITS = {
	...SKILL_USAGE_LIMITS,
	compactTriggerBytes: 4 * 1024,
	activeMaxBytes: 8 * 1024,
	activeMaxEntries: 40,
	ageMaxMs: 90 * 24 * 60 * 60 * 1000,
	readMaxBytes: 16 * 1024,
	maxEntriesPerSkill: 500,
	legacyCompactMaxBytes: 64 * 1024,
	warnCooldownMs: 0,
	headerMaxBytes: 8 * 1024,
	checkInterval: 1,
};

function makeEntry(
	overrides: Partial<Omit<SkillUsageEntry, 'id'>> = {},
): Omit<SkillUsageEntry, 'id'> {
	return {
		skillPath: '.claude/skills/marker-skill/SKILL.md',
		agentName: 'test-agent',
		taskID: 'task-001',
		timestamp: new Date().toISOString(),
		complianceVerdict: 'not_checked',
		sessionID: 'session-ml',
		...overrides,
	};
}

function logPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.jsonl');
}

function readRaw(dir: string): string {
	return fs.readFileSync(logPath(dir), 'utf-8');
}

function firstLine(dir: string): string {
	return (readRaw(dir).split('\n')[0] ?? '').trim();
}

function markerLine(
	ids: string[],
	timestamp = new Date().toISOString(),
): string {
	return JSON.stringify({
		type: 'feedback_applied',
		timestamp,
		processedEntryIds: ids,
	});
}

describe('skill-usage marker lifecycle and edges (issue #2038)', () => {
	let restoreClock: Restore;
	let tempDir: string;

	beforeEach(() => {
		// Test-clock adoption (issue #1782 gate): freeze at the real
		// now captured before the spy installs, so relative timestamps and
		// age-budget checks stay deterministic per test.
		restoreClock = freezeClock({ fixedNow: Date.now() });
		tempDir = canonicalMkdtemp('skill-usage-marker-lifecycle-');
	});

	afterEach(() => {
		restoreClock();
		_internals.limits = SKILL_USAGE_LIMITS;
		_resetMaintenanceState();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('marker lifecycle', () => {
		test('unprocessed compliant/violated entries survive every budget (correctness class)', () => {
			const oldTs = new Date(Date.now() - 365 * 86_400_000).toISOString();
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const lines = [];
			for (let i = 0; i < 30; i++) {
				lines.push(
					JSON.stringify(
						makeEntry({
							skillPath: `.opencode/skills/unacked-${i}/SKILL.md`,
							taskID: `unacked-${i}`,
							timestamp: oldTs,
							complianceVerdict: i % 2 ? 'compliant' : 'violated',
						}),
					),
				);
			}
			fs.writeFileSync(logPath(tempDir), lines.join('\n') + '\n', 'utf-8');

			// Squeeze every budget: correctness entries must STILL survive.
			const squeezed = {
				...SMALL_LIMITS,
				activeMaxEntries: 5,
				activeMaxBytes: 64 * 1024,
			};
			_internals.limits = squeezed;
			try {
				const result = pruneSkillUsageLog(tempDir, 2);
				expect(result.pruned).toBe(0);
				expect(result.remaining).toBe(30);
			} finally {
				_internals.limits = SKILL_USAGE_LIMITS;
			}
			expect(readSkillUsageEntries(tempDir)).toHaveLength(30);
		});

		test('processed markers age out with their entries; surviving IDs are kept', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const kept = makeEntry({
				taskID: 'kept',
				complianceVerdict: 'compliant',
			});
			const dropped = makeEntry({
				taskID: 'dropped',
				complianceVerdict: 'compliant',
				timestamp: new Date(Date.now() - 400 * 86_400_000).toISOString(),
			});
			fs.writeFileSync(
				logPath(tempDir),
				[
					JSON.stringify({ ...dropped, id: 'id-dropped' }),
					JSON.stringify({ ...kept, id: 'id-kept' }),
					markerLine(['id-dropped', 'id-kept']),
				].join('\n') + '\n',
				'utf-8',
			);

			const result = pruneSkillUsageLog(tempDir, 500);
			// dropped is processed AND ancient → age-evicted; kept survives.
			expect(result.pruned).toBe(1);
			const raw = readRaw(tempDir);
			expect(raw).toContain('id-kept');
			expect(raw).not.toContain('id-dropped');
			expect(raw).toContain('"type":"feedback_applied"');
		});

		test('marker-only file compacts to manifest-only (dead references pruned)', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			fs.writeFileSync(
				logPath(tempDir),
				[markerLine(['gone-1']), markerLine(['gone-2'])].join('\n') + '\n',
				'utf-8',
			);
			const result = pruneSkillUsageLog(tempDir, 500);
			expect(result.pruned).toBe(0);
			expect(readRaw(tempDir)).not.toContain('feedback_applied');
			expect(firstLine(tempDir)).toContain('skill-usage-manifest');
		});

		test('duplicate marker IDs union-dedup in the rebuild', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const entry = {
				...makeEntry({ taskID: 'e1', complianceVerdict: 'compliant' }),
				id: 'dup-id',
			} as SkillUsageEntry;
			fs.writeFileSync(
				logPath(tempDir),
				[
					JSON.stringify(entry),
					markerLine(['dup-id']),
					markerLine(['dup-id']),
				].join('\n') + '\n',
				'utf-8',
			);
			pruneSkillUsageLog(tempDir, 500);
			const markerLines = readRaw(tempDir)
				.split('\n')
				.filter((l) => l.includes('"type":"feedback_applied"'));
			expect(markerLines).toHaveLength(1);
		});

		test('out-of-order applied markers do not affect the processed set', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const e1 = {
				...makeEntry({ taskID: 'e1', complianceVerdict: 'compliant' }),
				id: 'o1',
			} as SkillUsageEntry;
			fs.writeFileSync(
				logPath(tempDir),
				[
					markerLine(['o1'], new Date(Date.now() + 60_000).toISOString()),
					JSON.stringify(e1),
				].join('\n') + '\n',
				'utf-8',
			);
			pruneSkillUsageLog(tempDir, 500);
			// e1 is processed (marker exists) → operational → recent → retained.
			// It must NOT be treated as unprocessed correctness data.
			expect(readSkillUsageEntries(tempDir).map((e) => e.taskID)).toContain(
				'e1',
			);
		});
	});

	describe('crash and edge cases', () => {
		test('torn tail is re-framed: the next append lands on its own line', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			fs.writeFileSync(
				logPath(tempDir),
				JSON.stringify(makeEntry({ taskID: 'torn' })).slice(0, 40), // no newline
				'utf-8',
			);
			appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'next' }));
			const lines = readRaw(tempDir)
				.split('\n')
				.filter((l) => l.trim());
			expect(lines.length).toBe(2);
			const parsed = readSkillUsageEntries(tempDir);
			expect(parsed.map((e) => e.taskID)).toContain('next');
		});

		test('corrupt lines are counted and dropped at compaction, valid ones kept', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			fs.writeFileSync(
				logPath(tempDir),
				[
					'BROKEN JSON',
					JSON.stringify(makeEntry({ taskID: 'ok-1' })),
					'{"valid":"json","unknown":"shape"}',
					JSON.stringify(makeEntry({ taskID: 'ok-2' })),
				].join('\n') + '\n',
				'utf-8',
			);
			const result = pruneSkillUsageLog(tempDir, 500);
			expect(result.remaining).toBe(2);
			const raw = readRaw(tempDir);
			expect(raw).not.toContain('BROKEN');
			expect(raw).not.toContain('"unknown"');
			// Manifest folded the corrupt counter.
			expect(firstLine(tempDir)).toMatch(/"corruptTotal":2/);
		});

		test('multi-project isolation: same skill names never cross projects', () => {
			const other = canonicalMkdtemp('skill-usage-marker-b-');
			try {
				for (let i = 0; i < 5; i++) {
					appendSkillUsageEntry(
						tempDir,
						makeEntry({ taskID: `a-${i}`, sessionID: 'sess-a' }),
					);
					appendSkillUsageEntry(
						other,
						makeEntry({ taskID: `b-${i}`, sessionID: 'sess-b' }),
					);
				}
				const a = readSkillUsageEntries(tempDir, { sessionID: 'sess-a' });
				const b = readSkillUsageEntries(other, { sessionID: 'sess-b' });
				expect(a).toHaveLength(5);
				expect(b).toHaveLength(5);
				expect(
					readSkillUsageEntries(tempDir, { sessionID: 'sess-b' }),
				).toHaveLength(0);
			} finally {
				fs.rmSync(other, { recursive: true, force: true });
			}
		});

		test('determinism: same input file compacts to the same output file', () => {
			const other = canonicalMkdtemp('skill-usage-marker-c-');
			try {
				const ts = new Date(Date.now() - 86_400_000).toISOString();
				const buildLines = () =>
					Array.from({ length: 12 }, (_, i) =>
						JSON.stringify(
							makeEntry({
								skillPath: `.opencode/skills/det-${i % 3}/SKILL.md`,
								taskID: `det-${i}`,
								timestamp: ts,
							}),
						),
					).join('\n') + '\n';
				for (const dir of [tempDir, other]) {
					fs.mkdirSync(path.dirname(logPath(dir)), { recursive: true });
					fs.writeFileSync(logPath(dir), buildLines(), 'utf-8');
				}
				const r1 = pruneSkillUsageLog(tempDir, 4);
				const r2 = pruneSkillUsageLog(other, 4);
				expect(r1).toEqual(r2);
				const stripUpdatedAt = (s: string) =>
					s.replace(/"updatedAt":"[^"]*"/g, '');
				expect(stripUpdatedAt(readRaw(tempDir))).toBe(
					stripUpdatedAt(readRaw(other)),
				);
			} finally {
				fs.rmSync(other, { recursive: true, force: true });
			}
		});

		test('restart: state is purely on disk (fresh maintenance continues)', () => {
			appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'pre-restart' }));
			_resetMaintenanceState();
			appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'post-restart' }));
			const ids = readSkillUsageEntries(tempDir).map((e) => e.taskID);
			expect(ids).toContain('pre-restart');
			expect(ids).toContain('post-restart');
		});

		test('manifest counters fold across compaction passes', () => {
			const savedLimits = _internals.limits;
			_internals.limits = SMALL_LIMITS;
			try {
				for (let i = 0; i < 100; i++) {
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: `fold-${i}` }));
				}
			} finally {
				_internals.limits = savedLimits;
			}
			const m1 = JSON.parse(firstLine(tempDir));
			expect(m1.compactedTotal).toBeGreaterThan(0);
			_internals.limits = SMALL_LIMITS;
			try {
				for (let i = 100; i < 160; i++) {
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: `fold-${i}` }));
				}
			} finally {
				_internals.limits = savedLimits;
			}
			const m2 = JSON.parse(firstLine(tempDir));
			expect(m2.compactedTotal).toBeGreaterThanOrEqual(m1.compactedTotal);
		}, 15_000);
	});
	// ------------------------------------------------------------------
	// Legacy migration
	// ------------------------------------------------------------------

	describe('legacy migration', () => {
		test('header-less files are upgraded at the first compaction, order preserved', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			fs.writeFileSync(
				logPath(tempDir),
				[
					JSON.stringify(makeEntry({ taskID: 'l-1' })),
					JSON.stringify(makeEntry({ taskID: 'l-2' })),
				].join('\n') + '\n',
				'utf-8',
			);
			const result = pruneSkillUsageLog(tempDir, 500);
			expect(result.pruned).toBe(0);
			expect(result.remaining).toBe(2);
			expect(firstLine(tempDir)).toContain('skill-usage-manifest');
			expect(readSkillUsageEntries(tempDir).map((e) => e.taskID)).toEqual([
				'l-1',
				'l-2',
			]);
		});

		test('markers in the head of a legacy file are honored for surviving entries', () => {
			const oldTs = new Date(Date.now() - 400 * 86_400_000).toISOString();
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const headProcessed = {
				...makeEntry({
					taskID: 'head-p',
					timestamp: oldTs,
					complianceVerdict: 'compliant',
				}),
				id: 'head-p-id',
			} as SkillUsageEntry;
			const tailProcessed = {
				...makeEntry({ taskID: 'tail-p', complianceVerdict: 'violated' }),
				id: 'tail-p-id',
			} as SkillUsageEntry;
			fs.writeFileSync(
				logPath(tempDir),
				[
					JSON.stringify({
						type: 'feedback_applied',
						timestamp: new Date().toISOString(),
						processedEntryIds: ['head-p-id', 'tail-p-id'],
					}),
					JSON.stringify(headProcessed),
					JSON.stringify(tailProcessed),
				].join('\n') + '\n',
				'utf-8',
			);
			const result = pruneSkillUsageLog(tempDir, 500);
			// head-p is processed + ancient → evicted; tail-p is processed but
			// recent → retained; the rebuilt marker keeps only tail-p-id (the
			// evicted entry's ID is dead and prunes with it).
			expect(result.pruned).toBe(1);
			const raw = readRaw(tempDir);
			expect(raw).toContain('tail-p-id');
			expect(raw).not.toContain('"head-p-id"');
			expect(raw).toContain('"type":"feedback_applied"');
		});

		test('append-path maintenance postpones oversized legacy migration', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const lines = [];
			for (let i = 0; i < 50; i++) {
				lines.push(
					JSON.stringify(
						makeEntry({
							taskID: `legacy-huge-${i}`,
							timestamp: new Date(Date.now() - i * 1000).toISOString(),
						}),
					),
				);
			}
			fs.writeFileSync(logPath(tempDir), lines.join('\n') + '\n', 'utf-8');
			const rawBefore = readRaw(tempDir);

			const tinyLegacy = {
				...SKILL_USAGE_LIMITS,
				compactTriggerBytes: 128,
				activeMaxBytes: 8 * 1024,
				activeMaxEntries: 500,
				readMaxBytes: 16 * 1024,
				legacyCompactMaxBytes: 256, // file is ~7 KB → above this
				warnCooldownMs: 0,
				checkInterval: 1,
			};
			_internals.limits = tinyLegacy;
			try {
				expect(() =>
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'post-legacy' })),
				).not.toThrow();
			} finally {
				_internals.limits = SKILL_USAGE_LIMITS;
			}
			// The legacy file is untouched by the append-path pass (entry was
			// still appended, but no migration/rewrite happened beyond that).
			const rawAfter = readRaw(tempDir);
			expect(rawAfter.startsWith(rawBefore.trim())).toBe(true);
			expect(rawAfter).toContain('post-legacy');

			// The phase-boundary pass migrates it.
			pruneSkillUsageLog(tempDir, 500);
			expect(firstLine(tempDir)).toContain('skill-usage-manifest');
		}, 10_000);
	});
});
