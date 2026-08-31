/**
 * Issue #2038 — bounds, retention, compaction, and migration for the
 * skill-usage subsystem.
 *
 * Covers approved-plan §11 cases that belong to the "hard global ceiling"
 * half of the spec: the global entry/byte/age budget, per-skill floor
 * retention, global-timestamp-order compaction writes, corrupt-line
 * durability, and legacy-log migration (set, trigger, boundedness).
 *
 * Uses the `_internals` DI seams (never `mock.module`) and restores them in
 * `afterEach`. Each test owns a private `canonicalMkdtemp` temp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	_resetSkillUsageMaintenanceState,
	appendSkillUsageEntry,
	pruneSkillUsageLog,
	readSkillUsageEntries,
	type SkillUsageEntry,
	_internals as sul_internals,
} from '../../../src/hooks/skill-usage-log.js';
import {
	_resetSkillUsagePendingState,
	createPendingDocument,
	loadPendingDocument,
	SKILL_USAGE_LIMITS,
	type SkillUsagePendingDocument,
	savePendingDocument,
} from '../../../src/hooks/skill-usage-pending.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function logPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.jsonl');
}

function pendingPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage-pending.json');
}

function writeRawLog(dir: string, content: string): void {
	const resolved = logPath(dir);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, content, 'utf-8');
}

function readRawLogLines(dir: string): string[] {
	const resolved = logPath(dir);
	if (!fs.existsSync(resolved)) return [];
	return fs
		.readFileSync(resolved, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0);
}

/** Mark the sidecar migrated (no legacy log involved) so compaction actually rewrites. */
function markMigrated(dir: string): void {
	const doc = createPendingDocument();
	doc.migrated = true;
	savePendingDocument(dir, doc);
}

function rawEntry(overrides: Partial<SkillUsageEntry>): string {
	const entry: SkillUsageEntry = {
		id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
		skillPath: overrides.skillPath ?? 'skill-a',
		agentName: overrides.agentName ?? 'agent',
		taskID: overrides.taskID ?? 'task-1',
		timestamp: overrides.timestamp ?? '2026-01-01T00:00:00.000Z',
		complianceVerdict: overrides.complianceVerdict ?? 'compliant',
		sessionID: overrides.sessionID ?? 'session-1',
	};
	return JSON.stringify(entry);
}

describe('skill-usage bounds (issue #2038)', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('skill-usage-bounds-');
	});

	afterEach(() => {
		_resetSkillUsageMaintenanceState();
		_resetSkillUsagePendingState();
		sul_internals.readFileSync = fs.readFileSync.bind(fs);
		sul_internals.existsSync = fs.existsSync.bind(fs);
		sul_internals.readSync = fs.readSync.bind(fs);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('global entry ceiling', () => {
		test('thousands of one-off skill IDs: ceiling holds and skills_dropped is counted', () => {
			markMigrated(dir);
			// 6,000 distinct skills, one entry each — no group ever reaches the
			// per-skill floor share individually, so reservedTotal (6000*1) is
			// under maxEntries here; force the over-budget branch by inflating
			// the per-skill reserved share instead: give each skill 20 entries
			// (== floorPerSkill), so reservedTotal = 6000 * 20 >> maxEntries.
			const lines: string[] = [];
			for (let i = 0; i < 6_000; i++) {
				const ts = `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00.${String(i).padStart(3, '0')}Z`;
				lines.push(
					rawEntry({
						id: `oneoff-${i}`,
						skillPath: `skill-oneoff-${i}`,
						timestamp: ts,
					}),
				);
			}
			writeRawLog(dir, `${lines.join('\n')}\n`);

			const result = pruneSkillUsageLog(dir);

			// Ceiling HOLDS: never more than the global entry budget survives.
			expect(result.remaining).toBeLessThanOrEqual(
				SKILL_USAGE_LIMITS.maxEntries,
			);
			const { doc } = loadPendingDocument(dir);
			expect(doc.counters.skills_dropped).toBeGreaterThan(0);
			expect(doc.coverage.skillsDropped).toBeGreaterThan(0);
			// Deliberately NOT asserting "no skill starved to zero" — arithmetically
			// impossible for N=6000 skills > maxEntries=5000 with any positive floor.
		}, 30_000);

		test('one hot skill is not gutted by thousands of one-off competitors', () => {
			markMigrated(dir);
			const lines: string[] = [];
			// The hot skill has the newest timestamps so it wins most-recent-use
			// admission, but under the over-budget branch every admitted skill is
			// capped at `floorPerSkill` regardless of how many entries it has.
			for (let i = 0; i < 30; i++) {
				lines.push(
					rawEntry({
						id: `hot-${i}`,
						skillPath: 'skill-hot',
						timestamp: `2026-06-01T00:${String(i).padStart(2, '0')}:00.000Z`,
					}),
				);
			}
			for (let i = 0; i < 5_500; i++) {
				lines.push(
					rawEntry({
						id: `cold-${i}`,
						skillPath: `skill-cold-${i}`,
						// Within the maxAgeMs (90d) window of the hot skill's newest
						// entry, so the age budget does not remove them before the
						// entry-count budget gets a chance to (which is what this
						// test is exercising).
						timestamp: `2026-05-25T00:${String(i % 60).padStart(2, '0')}:00.${String(i % 1000).padStart(3, '0')}Z`,
					}),
				);
			}
			writeRawLog(dir, `${lines.join('\n')}\n`);

			pruneSkillUsageLog(dir);
			const survivors = readSkillUsageEntries(dir);
			const hot = survivors.filter((e) => e.skillPath === 'skill-hot');

			// Retention does not gut the hot skill to zero or near-zero: it keeps
			// its full floor share.
			expect(hot.length).toBe(SKILL_USAGE_LIMITS.floorPerSkill);
		}, 30_000);
	});

	describe('age budget', () => {
		test('maxAgeMs drops entries older than the budget, anchored to the newest entry', () => {
			markMigrated(dir);
			const newest = '2026-06-01T00:00:00.000Z';
			const tooOld = new Date(
				Date.parse(newest) - (SKILL_USAGE_LIMITS.maxAgeMs + 86_400_000),
			).toISOString();
			writeRawLog(
				dir,
				`${[
					rawEntry({ id: 'old-1', skillPath: 'skill-x', timestamp: tooOld }),
					rawEntry({ id: 'new-1', skillPath: 'skill-x', timestamp: newest }),
				].join('\n')}\n`,
			);

			pruneSkillUsageLog(dir);
			const survivors = readSkillUsageEntries(dir);

			expect(survivors.map((e) => e.id)).toEqual(['new-1']);
			expect(survivors.map((e) => e.id)).not.toContain('old-1');
		});
	});

	describe('poisoned-newestMs mass-eviction (PR #2347 review round 2)', () => {
		test('one far-future-timestamped entry does not evict every legitimately-recent entry', () => {
			markMigrated(dir);
			// Ten entries at real, RELATIVE-to-now recent timestamps — not
			// hardcoded absolute dates. Round-2 closeout review: a hardcoded
			// "recent" cohort is recent only while the suite happens to run near
			// that date; once wall-clock passes maxAgeMs (90d) past it, these
			// same fixed dates fall below the 90-day cutoff and the assertion
			// flips from 10 to 0 — a calendar time-bomb in the exact test meant
			// to guard this invariant. Deriving from Date.now() keeps the
			// fixture permanently "recent" regardless of when the suite runs.
			const lines = Array.from({ length: 10 }, (_, i) =>
				rawEntry({
					id: `recent-${i}`,
					skillPath: 'skill-recent',
					timestamp: new Date(Date.now() - i * 86_400_000).toISOString(),
				}),
			);
			// One entry with a bogus far-future timestamp — a broken system clock
			// at write time, not attacker-reachable, but the single input the
			// unclamped `newestMs - maxAgeMs` cutoff was vulnerable to. This one
			// legitimately stays an absolute literal: it must be far enough in
			// the future to still be "the future" no matter when this test runs.
			lines.push(
				rawEntry({
					id: 'poisoned-future',
					skillPath: 'skill-poisoned',
					timestamp: '3000-01-01T00:00:00.000Z',
				}),
			);
			writeRawLog(dir, `${lines.join('\n')}\n`);

			pruneSkillUsageLog(dir, 500);

			const surviving = readSkillUsageEntries(dir);
			// Un-clamped: cutoff = year-3000 minus 90 days is still year 3000, so
			// every real recent entry falls below it and is mass-evicted in one
			// pass — only the poisoned entry itself would survive. Clamped: the
			// cutoff anchors to min(newestMs, Date.now()), so the ten legitimate
			// entries survive regardless of the poisoned one's timestamp.
			const recentSurvivors = surviving.filter(
				(e) => e.skillPath === 'skill-recent',
			);
			expect(recentSurvivors.length).toBe(10);
			// Pin the residual this fix does NOT close, deliberately: the
			// poisoned entry's own timestamp is always >= the clamped cutoff, so
			// it survives every pass too. Harmless (one record out of
			// maxEntries=5,000) and asserting it here means a future change that
			// decides to also age out poisoned-looking entries makes that choice
			// consciously, instead of this test silently starting to fail.
			const poisonedSurvivors = surviving.filter(
				(e) => e.skillPath === 'skill-poisoned',
			);
			expect(poisonedSurvivors.length).toBe(1);
		});
	});

	describe('floorPerSkill retention', () => {
		test("retains each surviving skill's most-recent floorPerSkill entries", () => {
			markMigrated(dir);
			const lines: string[] = [];
			// One skill with 25 entries (> floor of 20), plus enough other skills
			// to push the retention pass into the over-budget branch so the floor
			// actually binds instead of the skill just keeping everything.
			for (let i = 0; i < 25; i++) {
				lines.push(
					rawEntry({
						id: `target-${i}`,
						skillPath: 'skill-target',
						timestamp: `2026-03-01T00:${String(i).padStart(2, '0')}:00.000Z`,
					}),
				);
			}
			for (let i = 0; i < 5_500; i++) {
				lines.push(
					rawEntry({
						id: `filler-${i}`,
						skillPath: `skill-filler-${i}`,
						timestamp: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00.${String(i % 1000).padStart(3, '0')}Z`,
					}),
				);
			}
			writeRawLog(dir, `${lines.join('\n')}\n`);

			pruneSkillUsageLog(dir);
			const survivors = readSkillUsageEntries(dir).filter(
				(e) => e.skillPath === 'skill-target',
			);

			expect(survivors.length).toBe(SKILL_USAGE_LIMITS.floorPerSkill);
			// Must be the MOST RECENT 20 (indices 5..24), not the oldest 20.
			const ids = new Set(survivors.map((e) => e.id));
			for (let i = 5; i < 25; i++) expect(ids.has(`target-${i}`)).toBe(true);
			for (let i = 0; i < 5; i++) expect(ids.has(`target-${i}`)).toBe(false);
		}, 30_000);
	});

	describe('compaction write order (BLK-12 regression guard)', () => {
		test('compaction writes surviving entries in GLOBAL timestamp order, not group order', () => {
			markMigrated(dir);
			// Group-order (the pre-fix bug) would encounter skill A first and write
			// both its rows before skill B's, even though B1 is chronologically
			// between A1 and A2. Force a rewrite via a non-canonical skillPath
			// (the `normalized` trigger) so this fires without needing to exceed
			// any size/age budget.
			const linesInFileOrder = [
				rawEntry({
					id: 'a1',
					skillPath: 'file:skill-a',
					timestamp: '2026-01-01T00:00:00.000Z',
				}),
				rawEntry({
					id: 'b1',
					skillPath: 'skill-b',
					timestamp: '2026-01-01T00:01:00.000Z',
				}),
				rawEntry({
					id: 'a2',
					skillPath: 'file:skill-a',
					timestamp: '2026-01-01T00:02:00.000Z',
				}),
				rawEntry({
					id: 'b2',
					skillPath: 'skill-b',
					timestamp: '2026-01-01T00:03:00.000Z',
				}),
			];
			writeRawLog(dir, `${linesInFileOrder.join('\n')}\n`);

			pruneSkillUsageLog(dir);
			const rawLines = readRawLogLines(dir);
			const ids = rawLines.map((l) => (JSON.parse(l) as SkillUsageEntry).id);

			// Global chronological order: a1, b1, a2, b2 — NOT group order
			// (a1, a2, b1, b2), which would break the 64 KiB dedup-preload tail.
			expect(ids).toEqual(['a1', 'b1', 'a2', 'b2']);
		});
	});

	describe('corrupt-line durability', () => {
		test('a corrupt line is skipped and the corrupt count survives compaction', () => {
			markMigrated(dir);
			writeRawLog(
				dir,
				[
					'{not valid json',
					rawEntry({ id: 'good-1', skillPath: 'file:skill-c' }), // also forces a rewrite (normalized)
				].join('\n') + '\n',
			);

			const first = pruneSkillUsageLog(dir);
			expect(first.remaining).toBe(1);
			let doc = loadPendingDocument(dir).doc;
			expect(doc.counters.corrupt).toBe(1);

			// A second compaction pass over the now-clean, already-canonical file
			// finds nothing new to drop and does not reset the durable counter to
			// zero (the rewrite in `pruneSkillUsageLog` destroys corrupt LINES on
			// disk each pass, so the counter must be a lifetime accumulator).
			pruneSkillUsageLog(dir);
			doc = loadPendingDocument(dir).doc;
			expect(doc.counters.corrupt).toBe(1);
		});
	});

	describe('corrupt-bloated log converges under the byte ceiling (F1 regression)', () => {
		test('a log whose bulk is corrupt lines drops below maxBytes after one pruneSkillUsageLog pass, and the durable corrupt counter survives a second pass', () => {
			markMigrated(dir);
			// The trigger (`compactionTrigger`) reads ALL on-disk bytes; enforcement
			// sums only valid-entry bytes. If corrupt lines are not folded into
			// `needsRewrite`, the file is never rewritten and both numbers are
			// permanently stuck above maxBytes — this is the bug F1 describes.
			const lines: string[] = [];
			// ~30,000 corrupt (unparseable-as-entry) lines, ~110 bytes each ==
			// ~3.3 MB > SKILL_USAGE_LIMITS.maxBytes (1.5 MiB), so the trigger fires
			// on total bytes while almost none of that is valid-entry content.
			for (let i = 0; i < 30_000; i++) {
				lines.push(
					`{"not":"a real usage entry","padding":"${'x'.repeat(60)}","i":${i}}`,
				);
			}
			for (let i = 0; i < 20; i++) {
				lines.push(rawEntry({ id: `valid-${i}`, skillPath: 'skill-real' }));
			}
			writeRawLog(dir, `${lines.join('\n')}\n`);
			const beforeBytes = fs.statSync(logPath(dir)).size;
			expect(beforeBytes).toBeGreaterThan(SKILL_USAGE_LIMITS.maxBytes);

			const first = pruneSkillUsageLog(dir);
			expect(first.remaining).toBe(20);
			const afterFirstBytes = fs.statSync(logPath(dir)).size;
			// The hard ceiling: one rewrite must drop the corrupt bulk so on-disk
			// bytes converge under the limit. Without `|| corruptLines > 0` in
			// `needsRewrite`, `afterFirstBytes` stays equal to `beforeBytes`.
			expect(afterFirstBytes).toBeLessThan(SKILL_USAGE_LIMITS.maxBytes);
			let doc = loadPendingDocument(dir).doc;
			expect(doc.counters.corrupt).toBe(30_000);

			// Second pass: the rewrite already destroyed the corrupt lines on disk,
			// so no NEW corrupt lines are found this pass — but the durable lifetime
			// counter must not reset, and the file must stay converged (proving the
			// state is a stable fixed point, not merely one lucky pass).
			const second = pruneSkillUsageLog(dir);
			expect(second.remaining).toBe(20);
			expect(fs.statSync(logPath(dir)).size).toBeLessThan(
				SKILL_USAGE_LIMITS.maxBytes,
			);
			doc = loadPendingDocument(dir).doc;
			expect(doc.counters.corrupt).toBe(30_000);
		}, 30_000);
	});

	describe('legacy migration', () => {
		test('legacy header-less file migrates; feedback_applied markers become acks, not pending work', () => {
			const legacyEntry = rawEntry({
				id: 'legacy-1',
				skillPath: 'skill-legacy',
				complianceVerdict: 'violated',
			});
			const marker = JSON.stringify({
				type: 'feedback_applied',
				timestamp: '2026-01-01T01:00:00.000Z',
				processedEntryIds: ['legacy-1'],
			});
			// No sidecar at all — pure legacy on-disk shape.
			writeRawLog(dir, `${legacyEntry}\n${marker}\n`);
			expect(fs.existsSync(pendingPath(dir))).toBe(false);

			pruneSkillUsageLog(dir);

			const { doc } = loadPendingDocument(dir);
			expect(doc.migrated).toBe(true);
			// The marker ACKNOWLEDGES legacy-1; it must NOT become a pending
			// record, or the already-applied delta gets re-applied.
			expect(doc.records.find((r) => r.id === 'legacy-1')).toBeUndefined();
		});

		test('migration is triggered from the CONSUMPTION path with no append ever happening', async () => {
			const { applySkillUsageFeedback } = await import(
				'../../../src/hooks/skill-usage-log.js'
			);
			const legacyEntry = rawEntry({
				id: 'consume-trigger-1',
				skillPath: 'skill-consume-trigger',
				complianceVerdict: 'compliant',
			});
			writeRawLog(dir, `${legacyEntry}\n`);
			expect(fs.existsSync(pendingPath(dir))).toBe(false);

			// No append call anywhere — only consumption touches the store.
			await applySkillUsageFeedback(dir);

			expect(fs.existsSync(pendingPath(dir))).toBe(true);
			const { doc } = loadPendingDocument(dir);
			expect(doc.migrated).toBe(true);
		});

		test('migration is bounded in peak buffer size (max single read), not total bytes read', () => {
			const lines: string[] = [];
			for (let i = 0; i < 4_000; i++) {
				lines.push(
					rawEntry({ id: `mig-${i}`, skillPath: `skill-mig-${i % 50}` }),
				);
			}
			writeRawLog(dir, `${lines.join('\n')}\n`);

			const originalReadSync = sul_internals.readSync;
			let maxReadLen = 0;
			sul_internals.readSync = ((
				fd: number,
				buffer: Buffer,
				offset: number,
				length: number,
				position: number,
			) => {
				if (length > maxReadLen) maxReadLen = length;
				return originalReadSync(fd, buffer, offset, length, position);
			}) as typeof sul_internals.readSync;

			pruneSkillUsageLog(dir);

			// Every single read is bounded by the chunk size regardless of the
			// file being far larger than one chunk — this is the metric requirement
			// 4 actually cares about, not total bytes read (necessarily O(filesize)
			// for a one-time pass).
			expect(maxReadLen).toBeLessThanOrEqual(
				SKILL_USAGE_LIMITS.migrationChunkBytes,
			);
			expect(maxReadLen).toBeGreaterThan(0);
		}, 20_000);
	});

	describe('skillPath canonicalization', () => {
		test('the `file:` prefix is stripped at write, collapsing both spellings into one group', () => {
			appendSkillUsageEntry(dir, {
				skillPath: 'file:.claude/skills/canon-test/SKILL.md',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: '2026-01-01T00:00:00.000Z',
				complianceVerdict: 'compliant',
				sessionID: 'session-1',
			});

			const [entry] = readSkillUsageEntries(dir);
			expect(entry.skillPath).toBe('.claude/skills/canon-test/SKILL.md');
			expect(entry.skillPath.startsWith('file:')).toBe(false);
		});
	});
});
