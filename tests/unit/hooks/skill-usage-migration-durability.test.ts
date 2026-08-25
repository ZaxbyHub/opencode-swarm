/**
 * Issue #2038 final critic, C1 — the legacy migration must not report success
 * off an in-memory document that was never written to disk.
 *
 * `migrateLegacyLog` used to set `doc.migrated = true` BEFORE
 * `savePendingDocument`. That function re-throws on any write/rename failure,
 * `ensureMigrated` catches the throw and then answers `doc.migrated === true`
 * off the same mutated object, and `pruneSkillUsageLog` trusts that answer:
 * it skips its marker-preserving `!migrated` branch and rewrites the JSONL
 * emitting only the retained entries — which by construction excludes every
 * `feedback_applied` line. One transient sidecar write failure therefore
 * destroyed the acknowledgments while the queue meant to replace them was
 * never written, and the next pass re-enqueued every already-applied verdict
 * (`applyConfidenceDeltas` is additive for this path, so the replay bumps
 * knowledge confidence a second time).
 *
 * The fault is injected ONLY on the sidecar writer (paths containing
 * `skill-usage-pending`); the JSONL writer stays real, so the JSONL rewrite is
 * free to happen and the test fails loudly if it does.
 *
 * Kept in its own file rather than grown into `skill-usage-bounds.test.ts`
 * (443 lines) or `skill-usage-pending.test.ts` (499 lines), both of which are
 * new in this change and close to the FR-006 500-line cap.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	_resetSkillUsageMaintenanceState,
	pruneSkillUsageLog,
} from '../../../src/hooks/skill-usage-log.js';
import {
	_resetSkillUsagePendingState,
	_internals as pending_internals,
} from '../../../src/hooks/skill-usage-pending.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realWriteFileSync = fs.writeFileSync.bind(fs);

function logPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage.jsonl');
}

function pendingPath(dir: string): string {
	return path.join(dir, '.swarm', 'skill-usage-pending.json');
}

/**
 * Ten actionable (`violated`) legacy entries plus ONE `feedback_applied`
 * marker acknowledging all ten ids. A correct migration therefore produces
 * ZERO pending records: every candidate is already applied.
 */
function writeFullyAckedLegacyLog(dir: string): string[] {
	const ids: string[] = [];
	const lines: string[] = [];
	for (let i = 0; i < 10; i++) {
		const id = `e-${i}`;
		ids.push(id);
		lines.push(
			JSON.stringify({
				id,
				skillPath: 'skill-a',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: `2026-01-01T00:00:0${i}.000Z`,
				complianceVerdict: 'violated',
				sessionID: 'session-1',
			}),
		);
	}
	lines.push(
		JSON.stringify({
			type: 'feedback_applied',
			timestamp: '2026-01-02T00:00:00.000Z',
			processedEntryIds: ids,
		}),
	);
	const resolved = logPath(dir);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, `${lines.join('\n')}\n`, 'utf-8');
	return ids;
}

function markerLinesIn(dir: string): number {
	const resolved = logPath(dir);
	if (!fs.existsSync(resolved)) return -1;
	return fs
		.readFileSync(resolved, 'utf-8')
		.split('\n')
		.filter((line) => line.includes('"feedback_applied"')).length;
}

function readSidecar(dir: string): { migrated: boolean; records: string[] } {
	const doc = JSON.parse(fs.readFileSync(pendingPath(dir), 'utf-8')) as {
		migrated?: boolean;
		records?: Array<{ id: string }>;
	};
	return {
		migrated: doc.migrated === true,
		records: (doc.records ?? []).map((record) => record.id),
	};
}

/** Make every SIDECAR write fail with ENOSPC. The JSONL writer is untouched. */
function failSidecarWrites(): void {
	pending_internals.writeFileSync = ((
		file: fs.PathOrFileDescriptor,
		...rest: unknown[]
	) => {
		if (String(file).includes('skill-usage-pending')) {
			const err = new Error('ENOSPC: no space left on device') as Error & {
				code: string;
			};
			err.code = 'ENOSPC';
			throw err;
		}
		return (realWriteFileSync as (...args: unknown[]) => unknown)(
			file,
			...rest,
		);
	}) as typeof fs.writeFileSync;
}

describe('legacy migration durability (issue #2038 C1)', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('skill-usage-migration-durability-');
	});

	afterEach(() => {
		pending_internals.writeFileSync = realWriteFileSync;
		_resetSkillUsageMaintenanceState();
		_resetSkillUsagePendingState();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('control: with a healthy sidecar writer, ten fully-acknowledged entries migrate to ZERO pending records and the markers are dropped', () => {
		writeFullyAckedLegacyLog(dir);

		pruneSkillUsageLog(dir, 500);

		const sidecar = readSidecar(dir);
		expect(sidecar.migrated).toBe(true);
		expect(sidecar.records).toEqual([]);
		expect(markerLinesIn(dir)).toBe(0);
	});

	test('a failed sidecar write leaves the feedback_applied markers on disk and does NOT report the store migrated', () => {
		writeFullyAckedLegacyLog(dir);
		failSidecarWrites();

		// Fail-open: compaction must not propagate the write error.
		expect(() => pruneSkillUsageLog(dir, 500)).not.toThrow();

		// The queue was never written...
		expect(fs.existsSync(pendingPath(dir))).toBe(false);
		// ...so the ONLY acknowledgment record there is must survive. This is
		// the assertion that fails if `migrated` is set before the save: the
		// rewrite emits only the retained entries and the marker disappears.
		expect(markerLinesIn(dir)).toBe(1);
		// The entries themselves are untouched too — nothing was compacted.
		expect(
			fs
				.readFileSync(logPath(dir), 'utf-8')
				.split('\n')
				.filter((line) => line.trim().length > 0).length,
		).toBe(11);
	});

	test('after a transient sidecar failure clears, the recovered pass still yields ZERO pending records — no already-applied verdict is replayed', () => {
		writeFullyAckedLegacyLog(dir);
		failSidecarWrites();
		pruneSkillUsageLog(dir, 500);

		// Disk recovers; a fresh pass re-attempts the migration.
		pending_internals.writeFileSync = realWriteFileSync;
		_resetSkillUsageMaintenanceState();
		_resetSkillUsagePendingState();
		pruneSkillUsageLog(dir, 500);

		const sidecar = readSidecar(dir);
		expect(sidecar.migrated).toBe(true);
		// Ten acknowledged ids came back as ten `pending` records before the fix.
		expect(sidecar.records).toEqual([]);
		expect(markerLinesIn(dir)).toBe(0);
	});

	test('a failed sidecar write leaves the caller-visible counters unmoved: no half-migrated state is published', () => {
		writeFullyAckedLegacyLog(dir);
		// One unparseable line, so the `!migrated` branch takes its
		// best-effort counter flush and we can observe exactly what it wrote.
		fs.appendFileSync(logPath(dir), 'not json at all\n', 'utf-8');

		failSidecarWrites();
		pruneSkillUsageLog(dir, 500);
		pending_internals.writeFileSync = realWriteFileSync;

		// The flush uses the same failing writer, so nothing lands at all; what
		// matters is that no `migrated: true` document was published.
		expect(fs.existsSync(pendingPath(dir))).toBe(false);
		expect(markerLinesIn(dir)).toBe(1);
	});
});

/**
 * A log with NO markers and an already-migrated sidecar, so the migration
 * branch is a no-op and compaction is the only thing under test. Ten entries
 * for one skill; pruning with `maxEntriesPerSkill = 3` drops seven.
 */
function writeMigratedLogWithDroppableEntries(dir: string): void {
	const lines: string[] = [];
	for (let i = 0; i < 10; i++) {
		lines.push(
			JSON.stringify({
				id: `k-${i}`,
				skillPath: 'skill-a',
				agentName: 'agent',
				taskID: 'task-1',
				timestamp: `2026-01-01T00:00:0${i}.000Z`,
				complianceVerdict: 'not_checked',
				sessionID: 'session-1',
			}),
		);
	}
	const resolved = logPath(dir);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, `${lines.join('\n')}\n`, 'utf-8');
	fs.writeFileSync(
		pendingPath(dir),
		JSON.stringify({
			version: 1,
			migrated: true,
			records: [],
			counters: {},
			coverage: { complete: true, entriesDropped: 0, skillsDropped: 0 },
		}),
		'utf-8',
	);
}

function entryLinesIn(dir: string): number {
	return fs
		.readFileSync(logPath(dir), 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0).length;
}

describe('compaction manifest durability (issue #2038 residual R1)', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('skill-usage-r1-');
		_resetSkillUsageMaintenanceState();
		_resetSkillUsagePendingState();
	});

	afterEach(() => {
		pending_internals.writeFileSync = realWriteFileSync;
		_resetSkillUsagePendingState();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('a failed manifest write aborts the rewrite instead of dropping history uncovered', () => {
		writeMigratedLogWithDroppableEntries(dir);
		expect(entryLinesIn(dir)).toBe(10);

		failSidecarWrites();
		const result = pruneSkillUsageLog(dir, 3);
		pending_internals.writeFileSync = realWriteFileSync;

		// Fail-safe: nothing was dropped, so no history exists that the sidecar
		// fails to account for. Before this fix the rewrite ran first and left
		// three entries on disk while the sidecar still claimed complete coverage.
		expect(result.pruned).toBe(0);
		expect(result.error).toContain('ENOSPC');
		expect(entryLinesIn(dir)).toBe(10);

		// The on-disk sidecar must NOT claim coverage is still complete alongside
		// a truncated stream — the curator's retirement gate reads exactly this.
		const doc = JSON.parse(fs.readFileSync(pendingPath(dir), 'utf-8')) as {
			coverage?: { complete?: boolean; entriesDropped?: number };
		};
		expect(doc.coverage?.entriesDropped).toBe(0);
		expect(doc.coverage?.complete).toBe(true);
	});

	test('with a healthy sidecar the same prune drops entries and records the coverage loss', () => {
		writeMigratedLogWithDroppableEntries(dir);

		const result = pruneSkillUsageLog(dir, 3);

		expect(result.pruned).toBe(7);
		expect(entryLinesIn(dir)).toBe(3);
		const doc = JSON.parse(fs.readFileSync(pendingPath(dir), 'utf-8')) as {
			coverage?: { complete?: boolean; entriesDropped?: number };
		};
		expect(doc.coverage?.entriesDropped).toBe(7);
		expect(doc.coverage?.complete).toBe(false);
	});

	test('the emitted health payload reflects the published manifest, not the pre-compaction one', () => {
		// Guards `adoptStagedDocument` on the success path. The sidecar is already
		// durable by then, so no on-disk assertion can discriminate whether the
		// staged manifest was published into the caller's document — the health
		// payload built immediately afterwards is the only observable that can.
		// Without the adopt call this payload reports the PRE-compaction document
		// (dropped 0, coverage still complete).
		writeMigratedLogWithDroppableEntries(dir);

		const payloads: Array<Record<string, unknown>> = [];
		const realEmitHealth = pending_internals.emitHealth;
		pending_internals.emitHealth = ((payload: Record<string, unknown>) => {
			payloads.push(payload);
		}) as typeof pending_internals.emitHealth;

		try {
			expect(pruneSkillUsageLog(dir, 3).pruned).toBe(7);
		} finally {
			pending_internals.emitHealth = realEmitHealth;
		}

		const compaction = payloads.find((p) => p.trigger === 'compaction');
		expect(compaction).toBeDefined();
		expect(compaction?.dropped).toBe(7);
		expect(compaction?.coverage).toBe(false);
	});
});
