/**
 * Issue #2038 (Observability PR 10/23) — bounded deterministic readers and
 * coverage disclosure for `.swarm/skill-usage.jsonl`.
 *
 * Groups:
 *  - read instrumentation: byte-counted readSync proves reads ≤ readMaxBytes
 *  - coverage semantics (complete / truncated / empty; filter non-matches
 *    are NOT empty)
 *  - in-window equivalence: bounded read ≡ historical full read
 *  - consumer wiring: skill-index disclosure line; curator defers
 *    usage-derived decisions on truncated coverage
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_resetMaintenanceState,
	appendSkillUsageEntry,
	getSkillUsageCoverage,
	readSkillUsageEntries,
	SKILL_USAGE_LIMITS,
	type SkillUsageEntry,
} from '../../../src/hooks/skill-usage-log.js';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function makeEntry(
	overrides: Partial<Omit<SkillUsageEntry, 'id'>> = {},
): Omit<SkillUsageEntry, 'id'> {
	return {
		skillPath: '.claude/skills/bounded-read-skill/SKILL.md',
		agentName: 'test-agent',
		taskID: 'task-001',
		timestamp: new Date().toISOString(),
		complianceVerdict: 'not_checked',
		sessionID: 'session-br',
		...overrides,
	};
}

function logPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.jsonl');
}

describe('skill-usage bounded reads (issue #2038)', () => {
	let restoreClock: Restore;
	let tempDir: string;

	beforeEach(() => {
		// Test-clock adoption (issue #1782 gate): freeze at the real
		// now captured before the spy installs, so relative timestamps and
		// age-budget checks stay deterministic per test.
		restoreClock = freezeClock({ fixedNow: Date.now() });
		tempDir = canonicalMkdtemp('skill-usage-bounded-read-');
	});

	afterEach(() => {
		restoreClock();
		_internals.limits = SKILL_USAGE_LIMITS;
		_resetMaintenanceState();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('read instrumentation', () => {
		test('controlled input injects through the bounded-read seam (openSync/readSync)', () => {
			// Issue #2038: readSkillUsageEntries goes to disk through
			// readBoundedTail's seek seam — NOT readFileSync (which is the
			// maintenance/prune read seam, pinned in skill-usage-log.test.ts).
			appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'real-file-entry' }));

			const controlled = Buffer.from(
				JSON.stringify(makeEntry({ taskID: 'mocked-entry' })) + '\n',
				'utf-8',
			);
			const origOpen = _internals.openSync;
			const origRead = _internals.readSync;
			const origClose = _internals.closeSync;
			_internals.openSync = (() => 42) as typeof fs.openSync;
			_internals.readSync = ((_fd: number, buf: Buffer) => {
				controlled.copy(buf as Buffer);
				return controlled.length;
			}) as typeof fs.readSync;
			_internals.closeSync = (() => {}) as typeof fs.closeSync;
			try {
				const result = readSkillUsageEntries(tempDir);
				expect(result).toHaveLength(1);
				expect(result[0]!.taskID).toBe('mocked-entry');
			} finally {
				_internals.openSync = origOpen;
				_internals.readSync = origRead;
				_internals.closeSync = origClose;
			}
		});

		test('readSkillUsageEntries never reads more than readMaxBytes, whatever the file size', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const lines = [];
			for (let i = 0; i < 400; i++) {
				lines.push(
					JSON.stringify(
						makeEntry({
							taskID: `entry-${i}`,
							// not_checked → operational → readable via raw file
						}),
					),
				);
			}
			fs.writeFileSync(logPath(tempDir), lines.join('\n') + '\n', 'utf-8');
			const realSize = fs.statSync(logPath(tempDir)).size;
			expect(realSize).toBeGreaterThan(32 * 1024); // exercise a real tail cut

			const tinyRead = { ...SKILL_USAGE_LIMITS, readMaxBytes: 32 * 1024 };
			_internals.limits = tinyRead;

			let bytesRequested = 0;
			const realReadSync = _internals.readSync;
			_internals.readSync = ((
				fd: number,
				buf: Buffer,
				offset: number,
				length: number,
			) => {
				bytesRequested += length;
				return realReadSync(fd, buf, offset, length, 0);
			}) as typeof fs.readSync;

			try {
				const entries = readSkillUsageEntries(tempDir);
				expect(entries.length).toBeGreaterThan(0);
				expect(entries.length).toBeLessThan(400); // head truncated
				expect(bytesRequested).toBeLessThanOrEqual(32 * 1024);
			} finally {
				_internals.readSync = realReadSync;
			}
		});
	});

	describe('coverage semantics', () => {
		test('missing file → empty', () => {
			expect(getSkillUsageCoverage(tempDir)).toMatchObject({
				coverage: 'empty',
				onDiskBytes: 0,
			});
		});

		test('zero parsed entries on disk → empty (not a filter result)', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			fs.writeFileSync(logPath(tempDir), 'BROKEN\n', 'utf-8');
			expect(getSkillUsageCoverage(tempDir).coverage).toBe('empty');
		});

		test('file within the bound → complete; filter non-match is NOT empty', () => {
			appendSkillUsageEntry(tempDir, makeEntry({ sessionID: 'sess-1' }));
			const cov = getSkillUsageCoverage(tempDir);
			expect(cov.coverage).toBe('complete');
			expect(cov.retainedEntries).toBe(1);
			// A filtered read that matches nothing still ran over a complete file.
			const none = readSkillUsageEntries(tempDir, { sessionID: 'nope' });
			expect(none).toEqual([]);
			expect(getSkillUsageCoverage(tempDir).coverage).toBe('complete');
		});

		test('file beyond readMaxBytes → truncated', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const lines = [];
			for (let i = 0; i < 400; i++) {
				lines.push(JSON.stringify(makeEntry({ taskID: `x-${i}` })));
			}
			fs.writeFileSync(logPath(tempDir), lines.join('\n') + '\n', 'utf-8');
			_internals.limits = {
				...SKILL_USAGE_LIMITS,
				readMaxBytes: 16 * 1024,
			};
			expect(getSkillUsageCoverage(tempDir).coverage).toBe('truncated');
		});

		test('read failure on a non-empty file discloses truncated, never confident-empty', () => {
			// Issue #2038 uncertainty contract (final-critic finding): a
			// permission/AV/EBUSY read error must surface as partial coverage
			// so decision consumers defer and surfaces disclose — not as a
			// confident "no history".
			appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'on-disk' }));
			const origOpen = _internals.openSync;
			_internals.openSync = (() => {
				throw new Error('EBUSY: resource busy or locked');
			}) as typeof fs.openSync;
			try {
				const cov = getSkillUsageCoverage(tempDir);
				expect(cov.coverage).toBe('truncated');
				expect(cov.onDiskBytes).toBeGreaterThan(0);
			} finally {
				_internals.openSync = origOpen;
			}
			// Recovery: without the error the same file reads complete.
			expect(getSkillUsageCoverage(tempDir).coverage).toBe('complete');
		});
	});

	describe('in-window equivalence', () => {
		test('bounded read returns every entry when the file is within the envelope', () => {
			const expected: SkillUsageEntry[] = [];
			for (let i = 0; i < 25; i++) {
				appendSkillUsageEntry(
					tempDir,
					makeEntry({
						taskID: `eq-${i}`,
						complianceVerdict: i % 2 ? 'compliant' : 'not_checked',
					}),
				);
			}
			// A historical full read is emulated by a readMaxBytes far above
			// the file size — the bounded reader must return the same set,
			// in the same append order.
			const entries = readSkillUsageEntries(tempDir);
			expect(entries.map((e) => e.taskID)).toEqual(
				Array.from({ length: 25 }, (_, i) => `eq-${i}`),
			);
		});

		test('append order is preserved (deterministic, not re-sorted)', () => {
			// Deliberately out-of-order timestamps: the reader must return
			// APPEND order; consumers sort when they need recency.
			const stamps = [
				new Date(Date.now() - 5 * 86_400_000).toISOString(),
				new Date(Date.now() - 1 * 86_400_000).toISOString(),
				new Date(Date.now() - 9 * 86_400_000).toISOString(),
			];
			for (let i = 0; i < stamps.length; i++) {
				appendSkillUsageEntry(
					tempDir,
					makeEntry({ taskID: `ord-${i}`, timestamp: stamps[i] }),
				);
			}
			expect(readSkillUsageEntries(tempDir).map((e) => e.taskID)).toEqual([
				'ord-0',
				'ord-1',
				'ord-2',
			]);
		});
	});

	describe('consumer wiring', () => {
		test('formatSkillIndexWithContext discloses truncated coverage, silent when complete', async () => {
			const { formatSkillIndexWithContext } = await import(
				'../../../src/hooks/skill-scoring.js'
			);
			appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'disclosed' }));

			// Complete: no disclosure line.
			const completeIndex = formatSkillIndexWithContext(
				['.claude/skills/bounded-read-skill/SKILL.md'],
				tempDir,
			);
			expect(completeIndex).not.toContain('retained window');

			// Truncated: the disclosure line appears.
			fs.appendFileSync(
				logPath(tempDir),
				JSON.stringify(makeEntry({ taskID: 'pad', sessionID: 'sess-pad' })) +
					'\n',
				'utf-8',
			);
			_internals.limits = {
				...SKILL_USAGE_LIMITS,
				readMaxBytes: 64,
			};
			const truncatedIndex = formatSkillIndexWithContext(
				['.claude/skills/bounded-read-skill/SKILL.md'],
				tempDir,
			);
			expect(truncatedIndex).toContain('retained window');
		});

		test('curator auto-retire defers the violation-rate trigger on truncated coverage', async () => {
			const curator = await import('../../../src/hooks/curator.js');
			const retired: string[] = [];
			const origRetire = curator._internals.retireSkill;
			const origCoverage = curator._internals.getSkillUsageCoverage;
			const origList = curator._internals.listSkills;
			const origArchived = curator._internals.getArchivedKnowledgeIds;
			curator._internals.retireSkill = (async (_dir: string, slug: string) => {
				retired.push(slug);
			}) as typeof origRetire;
			curator._internals.getSkillUsageCoverage = (() => ({
				coverage: 'truncated',
				onDiskBytes: 999999,
				retainedEntries: 0,
				readMaxBytes: 1,
			})) as typeof origCoverage;
			curator._internals.listSkills = (async () => ({
				active: [
					{
						slug: 'would-retire',
						path: '.claude/skills/would-retire/SKILL.md',
					},
				],
				inactive: [],
			})) as typeof origList;
			curator._internals.getArchivedKnowledgeIds = (async () =>
				new Set<string>()) as typeof origArchived;

			try {
				const observations = await curator._internals.autoRetireSkills(
					tempDir,
					'',
				);
				expect(retired).toEqual([]); // deferred, not fired
				expect(observations.some((o) => o.includes('deferred'))).toBe(true);
			} finally {
				curator._internals.retireSkill = origRetire;
				curator._internals.getSkillUsageCoverage = origCoverage;
				curator._internals.listSkills = origList;
				curator._internals.getArchivedKnowledgeIds = origArchived;
			}
		});
	});
});
