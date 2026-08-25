/**
 * Issue #2038 (Observability PR 10/23) — hard global byte/age/count ceiling
 * for `.swarm/skill-usage.jsonl` across ALL skills, usage records, and marker
 * types, plus pressure semantics and legacy migration.
 *
 * Marker-lifecycle and crash/edge coverage lives in
 * skill-usage-marker-lifecycle.test.ts (FR-006 file split).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	_resetMaintenanceState,
	appendSkillUsageEntry,
	getSkillUsageCoverage,
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
		skillPath: '.claude/skills/global-bound-skill/SKILL.md',
		agentName: 'test-agent',
		taskID: 'task-001',
		timestamp: new Date().toISOString(),
		complianceVerdict: 'not_checked',
		sessionID: 'session-gb',
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

function manifestOf(dir: string): { pressure: boolean; [k: string]: unknown } {
	return JSON.parse(firstLine(dir));
}

describe('skill-usage global bound (issue #2038)', () => {
	let tempDir: string;
	let restoreClock: Restore;

	beforeEach(() => {
		// Test-clock adoption (issue #1782 gate): freeze at the real
		// now captured before the spy installs, so relative timestamps and
		// age-budget checks stay deterministic per test.
		restoreClock = freezeClock({ fixedNow: Date.now() });
		tempDir = canonicalMkdtemp('skill-usage-global-bound-');
	});

	afterEach(() => {
		restoreClock();
		_internals.limits = SKILL_USAGE_LIMITS;
		_resetMaintenanceState();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ------------------------------------------------------------------
	// Global envelope
	// ------------------------------------------------------------------

	describe('global envelope', () => {
		test('thousands of one-off skills cannot exceed the envelope beyond the rollover allowance', () => {
			const throttled = { ...SMALL_LIMITS, checkInterval: 4 };
			const savedLimits = _internals.limits;
			_internals.limits = throttled;
			try {
				// 160 distinct skills × 4 entries ≈ 40 KB unbounded with no
				// per-skill cap binding; the 8 KiB byte ceiling must bind.
				// (Load kept small — each maintenance is a real compaction
				// rewrite; checkInterval=4 amortizes without weakening the
				// envelope beyond the documented rollover allowance.)
				for (let i = 0; i < 160; i++) {
					for (let j = 0; j < 4; j++) {
						appendSkillUsageEntry(
							tempDir,
							makeEntry({
								skillPath: `.opencode/skills/one-off-${i}/SKILL.md`,
								taskID: `t-${i}-${j}`,
							}),
						);
					}
				}
			} finally {
				_internals.limits = savedLimits;
			}
			const size = fs.statSync(logPath(tempDir)).size;
			// Rollover allowance: checkInterval in-flight appends + manifest.
			expect(size).toBeLessThanOrEqual(
				throttled.activeMaxBytes + throttled.checkInterval * 4096 + 1024,
			);
			expect(size).toBeGreaterThan(0);
			// Manifest is materialized and the retained window is capped.
			expect(firstLine(tempDir)).toContain('skill-usage-manifest');
			expect(readSkillUsageEntries(tempDir).length).toBeLessThanOrEqual(
				SMALL_LIMITS.activeMaxEntries,
			);
		}, 20_000);

		test('byte ceiling binds independently of the count ceiling', () => {
			// Count ceiling deliberately loose (500): only the 8 KiB byte
			// ceiling can bound this store. 60 entries ≈ 15 KB unbounded.
			const byteBound = { ...SMALL_LIMITS, activeMaxEntries: 500 };
			const savedLimits = _internals.limits;
			_internals.limits = byteBound;
			try {
				for (let i = 0; i < 60; i++) {
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: `byte-${i}` }));
				}
			} finally {
				_internals.limits = savedLimits;
			}
			const size = fs.statSync(logPath(tempDir)).size;
			expect(size).toBeLessThanOrEqual(byteBound.activeMaxBytes + 4096);
			const retained = readSkillUsageEntries(tempDir).length;
			expect(retained).toBeLessThan(60);
			expect(retained).toBeGreaterThan(0);
		}, 10_000);

		test('global count ceiling binds before bytes for tiny entries', () => {
			withSmallLimits(() => {
				for (let i = 0; i < 120; i++) {
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: `tiny-${i}` }));
				}
			});
			expect(readSkillUsageEntries(tempDir).length).toBeLessThanOrEqual(
				SMALL_LIMITS.activeMaxEntries,
			);
		}, 10_000);

		test('one hot skill is bounded by the per-skill policy inside the ceiling', () => {
			withSmallLimits(() => {
				for (let i = 0; i < 120; i++) {
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: `hot-${i}` }));
				}
			});
			const entries = readSkillUsageEntries(tempDir);
			expect(entries.length).toBeLessThanOrEqual(SMALL_LIMITS.activeMaxEntries);
			// Newest retained: the last-appended task survives.
			expect(entries.some((e) => e.taskID === 'hot-119')).toBe(true);
			expect(entries.some((e) => e.taskID === 'hot-0')).toBe(false);
		}, 10_000);

		test('age budget evicts old operational entries and keeps newest', () => {
			const oldTs = new Date(Date.now() - 120 * 86_400_000).toISOString();
			const recentTs = new Date(Date.now() - 86_400_000).toISOString();
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			fs.writeFileSync(
				logPath(tempDir),
				[
					JSON.stringify(
						makeEntry({
							taskID: 'old-1',
							timestamp: oldTs,
							complianceVerdict: 'not_checked',
						}),
					),
					JSON.stringify(
						makeEntry({
							taskID: 'old-2',
							timestamp: oldTs,
							complianceVerdict: 'ignored',
						}),
					),
					JSON.stringify(
						makeEntry({
							taskID: 'recent-1',
							timestamp: recentTs,
							complianceVerdict: 'not_checked',
						}),
					),
				].join('\n') + '\n',
				'utf-8',
			);

			const result = pruneSkillUsageLog(tempDir, 500);
			expect(result.pruned).toBe(2);
			const remaining = readSkillUsageEntries(tempDir).map((e) => e.taskID);
			expect(remaining).toEqual(['recent-1']);
		});

		test('future-dated entries (clock skew) are retained, not dropped', () => {
			const futureTs = new Date(Date.now() + 86_400_000).toISOString();
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			fs.writeFileSync(
				logPath(tempDir),
				JSON.stringify(makeEntry({ taskID: 'future', timestamp: futureTs })) +
					'\n',
				'utf-8',
			);
			const result = pruneSkillUsageLog(tempDir, 500);
			expect(result.pruned).toBe(0);
			expect(readSkillUsageEntries(tempDir).map((e) => e.taskID)).toEqual([
				'future',
			]);
		});
	});

	// ------------------------------------------------------------------
	// Pressure
	// ------------------------------------------------------------------

	describe('pressure', () => {
		test('correctness backlog above the envelope keeps entries, flags pressure, and rejects operational appends', () => {
			fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
			const lines = [];
			for (let i = 0; i < 30; i++) {
				lines.push(
					JSON.stringify(
						makeEntry({
							skillPath: `.opencode/skills/backlog-${i}/SKILL.md`,
							taskID: `backlog-${i}`,
							complianceVerdict: 'compliant',
						}),
					),
				);
			}
			fs.writeFileSync(logPath(tempDir), lines.join('\n') + '\n', 'utf-8');

			const squeezed = {
				...SKILL_USAGE_LIMITS,
				compactTriggerBytes: 512,
				activeMaxBytes: 1024,
				activeMaxEntries: 5,
				readMaxBytes: 2 * 1024,
				legacyCompactMaxBytes: 64 * 1024,
				warnCooldownMs: 0,
				checkInterval: 1,
			};
			_internals.limits = squeezed;
			try {
				// First append triggers maintenance → pressure (30 correctness
				// entries ≫ 1 KiB envelope) but the correctness write lands.
				expect(() =>
					appendSkillUsageEntry(
						tempDir,
						makeEntry({ taskID: 'verdict-new', complianceVerdict: 'violated' }),
					),
				).not.toThrow();

				// The next operational append is rejected with the typed error.
				expect(() =>
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'op-new' })),
				).toThrow(/under pressure/);

				// All 30+1 correctness entries are retained ON DISK (the
				// bounded reader sees only the tail window — that is the
				// truncated-coverage contract, asserted next).
				const rawEntryLines = readRaw(tempDir)
					.split('\n')
					.filter(
						(l) =>
							l.trim() !== '' &&
							!l.includes('skill-usage-manifest') &&
							!l.includes('"type":"feedback_applied"'),
					);
				expect(rawEntryLines.length).toBe(31);
				// Coverage discloses truncation (file beyond readMaxBytes).
				expect(getSkillUsageCoverage(tempDir).coverage).toBe('truncated');
				expect(manifestOf(tempDir).pressure).toBe(true);
			} finally {
				_internals.limits = SKILL_USAGE_LIMITS;
			}
		}, 10_000);

		test('pressure clears after feedback consumes the backlog and maintenance fits', async () => {
			// Seed: one skill whose SKILL.md maps to a knowledge entry, plus a
			// correctness backlog that overflows a tiny envelope.
			const knowledgePath = path.join(
				tempDir,
				'.swarm',
				'knowledge',
				'knowledge.jsonl',
			);
			fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
			fs.writeFileSync(
				knowledgePath,
				JSON.stringify({
					id: 'pressure-clear-uuid',
					lesson: 'pressure clear test',
					confidence: 0.5,
					status: 'active',
				}) + '\n',
				'utf-8',
			);
			const skillDir = path.join(
				tempDir,
				'.claude/skills/pressure-clear-skill',
			);
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(
				path.join(skillDir, 'SKILL.md'),
				[
					'---',
					'name: pressure-clear-skill',
					'generated_from_knowledge:',
					'  - pressure-clear-uuid',
					'---',
					'body',
				].join('\n'),
				'utf-8',
			);

			const squeezed = {
				...SKILL_USAGE_LIMITS,
				compactTriggerBytes: 512,
				activeMaxBytes: 2048,
				activeMaxEntries: 5,
				readMaxBytes: 2 * 1024,
				legacyCompactMaxBytes: 64 * 1024,
				warnCooldownMs: 0,
				checkInterval: 1,
			};
			_internals.limits = squeezed;
			try {
				fs.mkdirSync(path.dirname(logPath(tempDir)), { recursive: true });
				const lines = [];
				for (let i = 0; i < 20; i++) {
					lines.push(
						JSON.stringify(
							makeEntry({
								skillPath: '.claude/skills/pressure-clear-skill/SKILL.md',
								taskID: `pc-${i}`,
								complianceVerdict: 'compliant',
								timestamp: new Date(
									Date.now() - (25 - i) * 60_000,
								).toISOString(),
							}),
						),
					);
				}
				fs.writeFileSync(logPath(tempDir), lines.join('\n') + '\n', 'utf-8');
				// Materialize the manifest + pressure.
				pruneSkillUsageLog(tempDir, 500);
				expect(manifestOf(tempDir).pressure).toBe(true);
				expect(() =>
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'op-blocked' })),
				).toThrow(/under pressure/);

				// Feedback consumes the actionable entries → markers appended.
				const { applySkillUsageFeedback } = await import(
					'../../../src/hooks/skill-usage-log.js'
				);
				const feedback = await applySkillUsageFeedback(tempDir);
				expect(feedback.processed).toBe(1);

				// Maintenance now demotes the processed entries to operational
				// and drops them by age/count → the store fits → pressure clears.
				pruneSkillUsageLog(tempDir, 500);
				expect(manifestOf(tempDir).pressure).toBe(false);
				expect(() =>
					appendSkillUsageEntry(tempDir, makeEntry({ taskID: 'op-resumed' })),
				).not.toThrow();
				expect(
					readSkillUsageEntries(tempDir).some((e) => e.taskID === 'op-resumed'),
				).toBe(true);
			} finally {
				_internals.limits = SKILL_USAGE_LIMITS;
			}
		}, 15_000);
	});
});

/** Run `fn` with small budgets and full seam restoration. */
function withSmallLimits(fn: () => void): void {
	const savedLimits = _internals.limits;
	_internals.limits = SMALL_LIMITS;
	try {
		fn();
	} finally {
		_internals.limits = savedLimits;
	}
}
