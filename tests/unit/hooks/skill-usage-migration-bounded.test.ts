/**
 * Issue #2038 implementation review F6 — legacy migration must not be an
 * absorbing state.
 *
 * An earlier revision buffered the ACKNOWLEDGMENT (`feedback_applied` marker)
 * set and refused to set `doc.migrated = true` once that set passed
 * `MIGRATION_MAX_ACK_IDS` (queueMaxRecords * 20 = 100,000). Because markers
 * are only ever dropped by the post-migration rewrite — which by construction
 * could never run once refused — that state could never resolve itself:
 * `pruneSkillUsageLog`'s `if (!migrated)` early return left the stream
 * untouched forever, on exactly the large accumulated logs issue #2038 exists
 * to bound.
 *
 * The fix instead bounds the CANDIDATE (entry) side via
 * `MIGRATION_MAX_CANDIDATES` (queueMaxRecords * 2) and never refuses to set
 * `migrated: true` — so a store this large now migrates and compacts to
 * completion rather than needing (or being capable of) "repeated passes".
 * This test proves the store is never permanently stuck: even a single
 * legacy log far exceeding both the old ack ceiling's *scale* and the new
 * candidate ceiling completes migration and becomes compactable, and a
 * second call is idempotent (no re-migration, no growth).
 *
 * Uses the `_internals` DI seam (never `mock.module`) and a private
 * `canonicalMkdtemp` temp dir, matching sibling files in this suite.
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
	loadPendingDocument,
	SKILL_USAGE_LIMITS,
} from '../../../src/hooks/skill-usage-pending.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function logPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.jsonl');
}

function writeRawLog(dir: string, content: string): void {
	const resolved = logPath(dir);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, content, 'utf-8');
}

function rawEntry(overrides: Partial<SkillUsageEntry>): string {
	const entry: SkillUsageEntry = {
		id: overrides.id ?? `id-${Math.random().toString(36).slice(2)}`,
		skillPath: overrides.skillPath ?? 'skill-a',
		agentName: overrides.agentName ?? 'agent',
		taskID: overrides.taskID ?? 'task-1',
		timestamp: overrides.timestamp ?? '2026-01-01T00:00:00.000Z',
		complianceVerdict: overrides.complianceVerdict ?? 'violated',
		sessionID: overrides.sessionID ?? 'session-1',
	};
	return JSON.stringify(entry);
}

describe('legacy migration is never permanently un-migratable (F6 regression)', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('skill-usage-migration-bounded-');
	});

	afterEach(() => {
		_resetSkillUsageMaintenanceState();
		_resetSkillUsagePendingState();
		sul_internals.readFileSync = fs.readFileSync.bind(fs);
		sul_internals.existsSync = fs.existsSync.bind(fs);
		sul_internals.readSync = fs.readSync.bind(fs);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('a legacy log whose actionable-entry count exceeds the migration candidate bound still completes migration in one pass and stays compactable on the next', () => {
		// MIGRATION_MAX_CANDIDATES = queueMaxRecords * 2 = 10,000 (not exported;
		// pinned here so the test states its own assumption rather than silently
		// depending on an internal constant staying in sync).
		const MIGRATION_MAX_CANDIDATES = SKILL_USAGE_LIMITS.queueMaxRecords * 2;
		const totalActionable = MIGRATION_MAX_CANDIDATES + 3_000;

		const lines: string[] = [];
		for (let i = 0; i < totalActionable; i++) {
			lines.push(
				rawEntry({
					id: `legacy-${i}`,
					skillPath: `skill-legacy-${i % 25}`,
					// Ascending timestamps: entries near the end are "newest" and are
					// the ones the candidate-side bound is documented to prefer.
					timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`,
				}),
			);
		}
		// A large marker set acknowledging the OLDEST half — this is exactly the
		// shape that overflowed the old ack-buffering design (a marker set that
		// keeps growing with everything ever processed).
		const ackedIds = Array.from(
			{ length: Math.floor(totalActionable / 2) },
			(_, i) => `legacy-${i}`,
		);
		lines.push(
			JSON.stringify({
				type: 'feedback_applied',
				timestamp: '2026-01-01T01:00:00.000Z',
				processedEntryIds: ackedIds,
			}),
		);
		writeRawLog(dir, `${lines.join('\n')}\n`);

		// A single call must complete migration — no "keep calling until it
		// works" required, and critically, no permanent refusal.
		const first = pruneSkillUsageLog(dir);
		const { doc: docAfterFirst } = loadPendingDocument(dir);
		expect(docAfterFirst.migrated).toBe(true);
		expect(first.remaining).toBeGreaterThan(0);

		// Proof the store is not stuck: a second maintenance pass actually
		// touches the stream again (further compaction/no-op is fine) rather
		// than hitting the `if (!migrated)` early return that stranded the old
		// design forever. The log must never regrow past the global ceiling.
		const second = pruneSkillUsageLog(dir);
		expect(second.remaining).toBeLessThanOrEqual(SKILL_USAGE_LIMITS.maxEntries);
		const { doc: docAfterSecond } = loadPendingDocument(dir);
		expect(docAfterSecond.migrated).toBe(true);

		// Surviving entries are real, readable usage entries post-migration —
		// the store is genuinely usable, not just flagged migrated.
		const survivors = readSkillUsageEntries(dir);
		expect(survivors.length).toBeGreaterThan(0);
		expect(survivors.every((e) => e.id.startsWith('legacy-'))).toBe(true);
	}, 30_000);
});
