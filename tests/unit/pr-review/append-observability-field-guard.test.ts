/**
 * Issue #3231 remaining scope (issue-tracer trace
 * 3231-3232-observability-append-integrity, Phase 2.5): same-revision stale
 * append through the public no-bump observability append API.
 *
 * `persistStateRowWhileLocked` (src/pr-review/persistence.ts) CASes the
 * re-read state `revision` against the caller payload's revision. The
 * observability append class never advances the state revision (#3199
 * no-bump design), and the durable-wins observability merge plus the
 * field-diff guard both skip observability fields — so when appender B holds
 * a snapshot taken BEFORE appender A's interleaved append (same state
 * revision), B's full-row payload is accepted and silently ERASES A's
 * appended entry with no error.
 *
 * Frozen acceptance checks:
 *   AC4 (RED at base, GREEN after the fix) — a same-revision append built
 *        from a STALE snapshot is rejected with `BLOCKED` and the interleaved
 *        append survives.
 *   AC5 positive control (GREEN at base, must stay GREEN) — an append built
 *        from a FRESH read under the lock is accepted, persists its entry,
 *        and leaves the durable revision unchanged.
 *
 * Seeding pattern: hand-written legacy gate-state JSON (imported into the
 * SQLite coordination row on the first read), matching
 * tests/unit/pr-review/journal-revision-cas-3199.test.ts.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	appendPrWorkflowSkillContractAdvisories,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	appendObservabilityStateWhileLocked,
	readPrWorkflowGateStateFromDisk,
	withSessionStateMutation,
} from '../../../src/pr-review/persistence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Fixed instants for all seeded/mutated timestamps — no raw clock reads. */
const NOW = '2026-11-06T00:00:00.000Z';
const AT_MS = 1_762_273_600_000;

/** Temp dirs created by the current test; drained best-effort in afterEach. */
const tempDirs: string[] = [];

function freshProject(prefix: string): string {
	const directory = canonicalMkdtemp(`sw3231-${prefix}-`);
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	return directory;
}

/** Hand-written legacy gate state at revision 0 (see the 3199 sibling suite). */
function seedGateState(directory: string, session: string): void {
	const stateFile = join(
		directory,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(session)}.json`,
	);
	mkdirSync(dirname(stateFile), { recursive: true });
	writeFileSync(
		stateFile,
		JSON.stringify({
			schemaVersion: 1,
			revision: 0,
			sessionID: session,
			mode: 'PR_REVIEW',
			activatedAt: NOW,
			updatedAt: NOW,
		}),
		'utf8',
	);
}

afterEach(() => {
	closeAllProjectDbs();
	for (const directory of tempDirs.splice(0)) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows: the SQLite WAL may briefly hold the temp dir; best-effort.
		}
	}
});

// ---------------------------------------------------------------------------
// AC4 (discriminating): a same-revision stale append must be BLOCKED.
// ---------------------------------------------------------------------------

test('a same-revision stale append is BLOCKED instead of erasing an interleaved append (issue #3231)', async () => {
	const directory = freshProject('stale-append');
	const session = 'session-3231-stale-append';
	seedGateState(directory, session);
	// One read imports the legacy JSON into the SQLite coordination row.
	const seeded = await readPrWorkflowGateState(directory, session);
	expect(seeded?.revision).toBe(0);

	// Appender B snapshots the durable state at revision 0 — BEFORE A's append.
	const staleSnapshotB = await readPrWorkflowGateStateFromDisk(
		directory,
		session,
	);
	expect(staleSnapshotB).not.toBeNull();
	expect(staleSnapshotB?.skillContractAdvisories ?? []).toHaveLength(0);

	// Appender A performs a legitimate observability append: the advisory
	// persists durably while the state revision stays 0 (#3199 no-bump design).
	await appendPrWorkflowSkillContractAdvisories(directory, session, [
		'A: interleaved advisory that must survive',
	]);
	const afterA = await readPrWorkflowGateState(directory, session);
	expect(afterA?.revision).toBe(0);
	expect(afterA?.skillContractAdvisories).toContain(
		'A: interleaved advisory that must survive',
	);

	// Appender B appends a submit-rejection journal entry built from its STALE
	// snapshot (which lacks A's advisory), under the session lock, through the
	// public no-bump append API — the exact production append shape used by
	// recordPrReviewSubmitRejection.
	let staleError: unknown = null;
	try {
		await withSessionStateMutation(directory, session, async () => {
			await appendObservabilityStateWhileLocked(directory, {
				...staleSnapshotB!,
				prReviewSubmitRejections: [
					{
						childSessionId: 'child-3231-b',
						at: AT_MS,
						message: 'B journal entry from a stale snapshot',
					},
				],
				updatedAt: NOW,
			});
		});
	} catch (error) {
		staleError = error;
	}

	// RED at base: B's append is silently accepted (staleError stays null) and
	// the full-row write erases A's advisory. GREEN after the fix: the stale
	// same-revision append is rejected with a BLOCKED error.
	expect(
		staleError,
		'DEFECT (#3231): the same-revision stale append was silently accepted',
	).toBeInstanceOf(Error);
	expect((staleError as Error).message.startsWith('BLOCKED')).toBe(true);

	// A's appended entry must still survive B's rejected append attempt — the
	// erase is the second half of the defect.
	const finalState = await readPrWorkflowGateState(directory, session);
	expect(finalState?.skillContractAdvisories ?? []).toContain(
		'A: interleaved advisory that must survive',
	);
	expect(finalState?.revision).toBe(0);
});

// ---------------------------------------------------------------------------
// AC5 positive control (preserving): a current-state append stays accepted.
// ---------------------------------------------------------------------------

test('a current-state append is accepted, persists, and leaves the revision unchanged (issue #3231 control)', async () => {
	const directory = freshProject('fresh-append');
	const session = 'session-3231-fresh-append';
	seedGateState(directory, session);
	const seeded = await readPrWorkflowGateState(directory, session);
	expect(seeded?.revision).toBe(0);

	// The production append shape: re-read the durable state INSIDE the held
	// session lock, then append relative to that fresh read.
	await withSessionStateMutation(directory, session, async () => {
		const fresh = await readPrWorkflowGateStateFromDisk(directory, session);
		expect(fresh).not.toBeNull();
		await appendObservabilityStateWhileLocked(directory, {
			...fresh!,
			prReviewSubmitRejections: [
				...(fresh?.prReviewSubmitRejections ?? []),
				{
					childSessionId: 'child-3231-control',
					at: AT_MS,
					message: 'control entry from a fresh read',
				},
			],
			updatedAt: NOW,
		});
	});

	// GREEN at base and after the fix: the fresh-read append is accepted, its
	// entry persists durably, and the observability append does not advance
	// the durable state revision (the #3199 no-bump contract).
	const after = await readPrWorkflowGateState(directory, session);
	expect(
		after?.prReviewSubmitRejections?.some(
			(entry) => entry.message === 'control entry from a fresh read',
		),
	).toBe(true);
	expect(after?.revision).toBe(0);
});
