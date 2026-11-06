/**
 * Issue #3232 acceptance checks (issue-tracer trace
 * 3231-3232-observability-append-integrity, Phase 2.5).
 *
 * `appendPrWorkflowSkillContractAdvisories` documents a fail-open contract
 * ("a concurrent gate transition …, a missing state, or any error drops the
 * append silently", src/hooks/pr-workflow-gate.ts), but its protective
 * `try/catch` sits INSIDE the `withSessionStateMutation` callback while lock
 * ACQUISITION happens before the callback runs. When the session-state
 * mutation lock is held by a live owner for the full 50 x 10 ms acquire
 * budget, the acquire loop's BLOCKED throw escapes the function — and the
 * sole wake-path caller (src/hooks/pr-workflow-response-gate.ts) has no local
 * catch, so one auto-resume wake evaluation aborts before the resume prompt
 * is sent.
 *
 * Frozen acceptance checks:
 *   AC1 — lock exhaustion during the advisory append returns WITHOUT throwing
 *         and leaves the durable state untouched (no advisory persisted,
 *         revision unchanged). RED at base, GREEN after the fix.
 *   AC2 — when the advisory append hits lock exhaustion, the auto-resume wake
 *         still sends its continuation prompt. RED at base, GREEN after the
 *         fix. The assertion targets the resume prompt itself (not
 *         `gate.event()` resolving — the event handler catches wake errors, so
 *         that would pass at base too).
 *
 * Seeding pattern: hand-written legacy gate-state JSON (imported into the
 * SQLite coordination row on the first read), matching
 * tests/unit/hooks/pr-workflow-skill-advisory-revision-3199.test.ts; the wake
 * leg uses the response-gate test helpers
 * (tests/unit/hooks/pr-workflow-response-gate-test-helpers.ts) per
 * tests/unit/hooks/pr-workflow-response-gate-postwake-read.test.ts.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	appendPrWorkflowSkillContractAdvisories,
	_test_exports as gateInternals,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowResponseGate,
	_internals as responseGateInternals,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	idleEventFor,
	writeStateWithRevision,
} from './pr-workflow-response-gate-test-helpers.js';

const NOW = '2026-11-06T00:00:00.000Z';

/**
 * STATE_MUTATION_LOCK_MAX_ATTEMPTS in src/pr-review/persistence.ts (not
 * exported). The acquire loop performs exactly one isProcessAlive check per
 * failed attempt, so 50 checks = one fully-exhausted acquire loop.
 */
const STATE_MUTATION_LOCK_MAX_ATTEMPTS = 50;

/** Synthetic pid for the planted lock owner — never a real process. */
const PLANTED_PID = 323_232_323;

/**
 * Fixed `createdAtMs` for planted locks. Inert: a PARSED lock record is
 * reclaimed only on owner-pid liveness (`isProcessAlive`), and its
 * `createdAtMs` is validated only as a finite number — no clock comparison
 * reads it, so a literal keeps the fixture deterministic (check:test-clock).
 */
const PLANTED_LOCK_CREATED_AT_MS = 1_762_387_200_000;

// Seam snapshots (restored in afterEach; the gate binds its `_test_exports`
// object as the persistence hooks, so property mutation is read at call time
// inside src/pr-review/persistence.ts).
const originalIsProcessAlive = gateInternals.isProcessAlive;
const originalEnsureSkillContractsFresh =
	responseGateInternals.ensurePrWorkflowSkillContractsFresh;

/** Temp dirs created by the current test; drained best-effort in afterEach. */
const tempDirs: string[] = [];

function freshProject(prefix: string): string {
	const directory = canonicalMkdtemp(`sw3232-${prefix}-`);
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

/** Plant a session-state mutation lock owned by `pid` at the canonical path. */
function plantMutationLock(
	directory: string,
	session: string,
	pid: number,
	ownerToken: string,
): void {
	writeFileSync(
		join(
			directory,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(session)}.lock`,
		),
		JSON.stringify({
			ownerToken,
			pid,
			createdAtMs: PLANTED_LOCK_CREATED_AT_MS,
		}),
		'utf8',
	);
}

afterEach(() => {
	gateInternals.isProcessAlive = originalIsProcessAlive;
	responseGateInternals.ensurePrWorkflowSkillContractsFresh =
		originalEnsureSkillContractsFresh;
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
// AC1 (discriminating): lock exhaustion must not escape the fail-open append.
// ---------------------------------------------------------------------------

test('lock exhaustion returns without throwing and drops the advisory append (issue #3232 AC1)', async () => {
	const directory = freshProject('lock-exhaust');
	const session = 'session-3232-lock-exhaustion';
	seedGateState(directory, session);
	// One read imports the legacy JSON into the SQLite coordination row.
	const seeded = await readPrWorkflowGateState(directory, session);
	expect(seeded?.revision).toBe(0);

	// Live-owner lock: `reclaimAbandonedSessionStateMutationLock` refuses to
	// reclaim while the owner pid is alive, so the append's acquire loop burns
	// its full 50 x 10 ms budget and then throws BLOCKED. process.pid needs no
	// seam — this process is definitionally alive.
	plantMutationLock(directory, session, process.pid, 'live-owner-3232-ac1');

	// RED at base: the promise REJECTS with
	// "BLOCKED: PR workflow gate state is being mutated by another process…"
	// because the lock acquisition sits OUTSIDE the fail-open try/catch.
	// GREEN after the fix: the append is dropped silently and resolves.
	await expect(
		appendPrWorkflowSkillContractAdvisories(directory, session, [
			'3232 advisory under lock contention',
		]),
	).resolves.toBeUndefined();

	// Cannot pass by accident: the dropped append must leave the durable state
	// untouched — the advisory was never persisted and the revision never moved.
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.revision).toBe(0);
	expect(after?.skillContractAdvisories ?? []).not.toContain(
		'3232 advisory under lock contention',
	);
});

// ---------------------------------------------------------------------------
// AC2 (discriminating): the wake still sends its resume prompt when the
// advisory append hits lock exhaustion.
// ---------------------------------------------------------------------------

test('wake still prompts when the advisory append hits lock exhaustion (issue #3232 AC2)', async () => {
	const directory = freshProject('wake-prompt');
	const session = 'session-3232-wake-prompt';
	await writeStateWithRevision(directory, session, 0);

	const promptAsync = mock(async () => ({}));
	const gate = createPrWorkflowResponseGate({
		directory,
		client: { session: { prompt: promptAsync, promptAsync } },
		maxConsecutiveUnproductiveWakes: 999_999,
		wakeCooldownMs: 0,
		totalWakeCeiling: 999_999,
	});

	// Deterministic contention scoped to the advisory append's lock
	// acquisition only:
	//  - the skill-contract stub plants a live-owner lock and returns a
	//    non-empty advisory list, so the wake path calls
	//    appendPrWorkflowSkillContractAdvisories (nothing between the stub's
	//    return and the append acquires the session lock);
	//  - the isProcessAlive seam (the gate's bound persistence hooks) reports
	//    the planted pid ALIVE for exactly one exhausted acquire loop (50
	//    checks) and DEAD afterwards, so any later acquire in the same wake
	//    reclaims the abandoned lock instead of blocking too. Verified against
	//    the post-append wake steps (markPrWorkflowPluginWake is in-memory;
	//    the finally-block re-read and the PR_REVIEW-mode monitor-queue claim
	//    are skipped/lockless) — no later step depends on the lock.
	let plantedPidLivenessChecks = 0;
	gateInternals.isProcessAlive = (pid: number) => {
		if (pid !== PLANTED_PID) return originalIsProcessAlive(pid);
		plantedPidLivenessChecks += 1;
		return plantedPidLivenessChecks <= STATE_MUTATION_LOCK_MAX_ATTEMPTS;
	};
	responseGateInternals.ensurePrWorkflowSkillContractsFresh = async () => {
		plantMutationLock(directory, session, PLANTED_PID, 'live-owner-3232-ac2');
		return ['3232 wake-path advisory under lock contention'];
	};

	// The idle-event handler catches wake errors and resolves either way; the
	// discriminating assertion is the resume prompt itself.
	await gate.event(idleEventFor(session));

	// Sanity on the arrangement: the append's acquire loop really did exhaust
	// (exactly one loop's worth of live-owner checks), so the wake reached the
	// append and the failure under test is the append's throw, not a blocked
	// wake step.
	expect(plantedPidLivenessChecks).toBe(STATE_MUTATION_LOCK_MAX_ATTEMPTS);

	// RED at base: the append's lock-exhaustion throw aborts runWakeEvaluation
	// before the resume prompt is built, so no prompt was sent. GREEN after
	// the fix: the append is dropped, the wake continues, the prompt fires.
	expect(promptAsync).toHaveBeenCalled();

	// Reinforcement: the wake completed its bookkeeping (the post-prompt
	// finally block ran); at base the throw skips this entirely.
	expect(gate._inspectWakeBudget(session)?.totalWakes).toBe(1);
});
