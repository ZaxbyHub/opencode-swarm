/**
 * Issue #2038 — PR #2347 review round 2 regression: `applyRetention`'s
 * cutoff must not be inflatable by a single future-dated (poisoned) entry.
 *
 * Split out of skill-usage-bounds.test.ts (FR-006, that file is already
 * over the 500-line cap and must not grow).
 *
 * Uses the `_internals` DI seams (never `mock.module`) and restores them in
 * `afterEach`. Owns a private `canonicalMkdtemp` temp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	_resetSkillUsageMaintenanceState,
	pruneSkillUsageLog,
	readSkillUsageEntries,
	type SkillUsageEntry,
	_internals as sul_internals,
} from '../../../src/hooks/skill-usage-log.js';
import {
	_resetSkillUsagePendingState,
	createPendingDocument,
	savePendingDocument,
} from '../../../src/hooks/skill-usage-pending.js';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function logPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.jsonl');
}

function writeRawLog(dir: string, content: string): void {
	const resolved = logPath(dir);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, content, 'utf-8');
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

describe('poisoned-newestMs mass-eviction (PR #2347 review round 2)', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('skill-usage-poisoned-clock-');
	});

	afterEach(() => {
		_resetSkillUsageMaintenanceState();
		_resetSkillUsagePendingState();
		sul_internals.readFileSync = fs.readFileSync.bind(fs);
		sul_internals.existsSync = fs.existsSync.bind(fs);
		sul_internals.readSync = fs.readSync.bind(fs);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('one far-future-timestamped entry does not evict every legitimately-recent entry', () => {
		// Freeze the clock at the real "now" so the fixture's relative
		// timestamps are deterministic across runs, while still deriving from
		// Date.now() rather than a hardcoded literal: a hardcoded "recent"
		// cohort is recent only while the suite happens to run near that date;
		// once wall-clock passes maxAgeMs (90d) past it, fixed dates fall below
		// the 90-day cutoff and the assertion flips from 10 to 0 — a calendar
		// time-bomb in the exact test meant to guard this invariant.
		withFrozenClock(
			() => {
				markMigrated(dir);
				const lines = Array.from({ length: 10 }, (_, i) =>
					rawEntry({
						id: `recent-${i}`,
						skillPath: 'skill-recent',
						timestamp: new Date(Date.now() - i * 86_400_000).toISOString(),
					}),
				);
				// One entry with a bogus far-future timestamp — a broken system
				// clock at write time, not attacker-reachable, but the single
				// input the unclamped `newestMs - maxAgeMs` cutoff was vulnerable
				// to. This one legitimately stays an absolute literal: it must be
				// far enough in the future to still be "the future" no matter when
				// this test runs.
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
				// Un-clamped: cutoff = year-3000 minus 90 days is still year 3000,
				// so every real recent entry falls below it and is mass-evicted in
				// one pass — only the poisoned entry itself would survive.
				// Clamped: the cutoff anchors to min(newestMs, Date.now()), so the
				// ten legitimate entries survive regardless of the poisoned one's
				// timestamp.
				const recentSurvivors = surviving.filter(
					(e) => e.skillPath === 'skill-recent',
				);
				expect(recentSurvivors.length).toBe(10);
				// Pin the residual this fix does NOT close, deliberately: the
				// poisoned entry's own timestamp is always >= the clamped cutoff,
				// so it survives every pass too. Harmless (one record out of
				// maxEntries=5,000) and asserting it here means a future change
				// that decides to also age out poisoned-looking entries makes that
				// choice consciously, instead of this test silently starting to
				// fail.
				const poisonedSurvivors = surviving.filter(
					(e) => e.skillPath === 'skill-poisoned',
				);
				expect(poisonedSurvivors.length).toBe(1);
			},
			{ fixedNow: Date.now() },
		);
	});
});
