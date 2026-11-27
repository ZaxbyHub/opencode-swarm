/**
 * F-001 (PR 3922 review) regression: the plan-critic approval commit fence
 * must execute ONLY under the ledger evidence lock.
 *
 * Prior buggy behavior: `takeSnapshotEvent` awaited `options.preCommitCheck()`
 * once OUTSIDE the ledger evidence lock (before `appendLedgerEvent` acquired
 * it) and then again inside the lock. The unlocked outer run observed
 * plan/ledger state without serialization, so a transient plan read or a
 * concurrent write could spuriously throw conflict / already_recorded /
 * plan_unreadable before the authoritative locked check ever ran — an async
 * plan-critic approval could be skipped or failed despite a valid APPROVED
 * verdict, leaving the critic_pre_plan gate blocked.
 *
 * Discriminating probe: the fence body checks the ledger lock artifact
 * (`.swarm/locks/<sha256(.swarm/plan-ledger.jsonl)>.lck`, derived with the
 * same `getOwnerLockPath` helper the acquire path uses). Under the fix the
 * fence runs exactly once, while the lock artifact exists (it is created at
 * acquire time, before the fenced callback executes). Under the prior bug
 * the fence ALSO ran once before lock acquisition, when the artifact did not
 * exist yet — the assertions below fail on that tree.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { withEvidenceLock } from '../../../src/evidence/lock';
import { getOwnerLockPath } from '../../../src/parallel/file-locks';
import {
	_internals as criticApprovalInternals,
	recordVerifiedPlanCriticApproval,
} from '../../../src/plan/critic-approval';
import {
	computePlanStructureHash,
	initLedger,
	loadLastPlanCriticApprovedSnapshot,
} from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	removeTelemetryListener,
	resetTelemetryForTesting,
	type TelemetryListener,
} from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/** Mirrors the non-exported LEDGER_LOCK_PATH in src/plan/ledger.ts. */
const LEDGER_LOCK_PATH = join('.swarm', 'plan-ledger.jsonl');

/** Minimal deferred — explicit synchronization without timer-based waits. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makePlan(title = 'F-001 Fence Contention Plan'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'f001-fence-contention',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
}

function writePlan(directory: string, plan: Plan): void {
	mkdirSync(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

const APPROVED_TEXT = 'Plan review complete.\n\nVERDICT: APPROVED\nAll good.';

describe('plan-critic-approval fence lock contention — regression: the approval commit fence runs only under the ledger lock (F-001)', () => {
	let dir: string;
	let cleanup: () => void;
	let plan: Plan;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir, cleanup } = createSafeTestDir('critic-approval-f001-'));
		plan = makePlan();
		writePlan(dir, plan);
	});

	afterEach(() => {
		criticApprovalInternals.onPreCommitFence = null;
		resetTelemetryForTesting();
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('the fence executes exactly once, under the ledger lock, and an unreadable plan at the locked fence stays retryable', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const planPath = join(dir, '.swarm', 'plan.json');
		const ledgerLockArtifact = getOwnerLockPath(dir, LEDGER_LOCK_PATH);

		const fenceRuns: { lockArtifactPresent: boolean }[] = [];
		criticApprovalInternals.onPreCommitFence = () => {
			fenceRuns.push({ lockArtifactPresent: existsSync(ledgerLockArtifact) });
			// Contention at the fenced commit point: the plan becomes
			// unreadable (e.g. a concurrent save_plan's atomic tmp→rename
			// swap) exactly while the writer holds the lock.
			rmSync(planPath);
		};

		const result = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_f001_parent',
			callId: 'call-f001-contention',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		criticApprovalInternals.onPreCommitFence = null;

		// The fence did NOT run before lock acquisition: exactly one fence
		// execution, while the ledger lock artifact existed. Under the prior
		// bug the fence also ran once outside the lock (two runs, the first
		// with no lock artifact present).
		expect(fenceRuns.length).toBe(1);
		expect(fenceRuns[0].lockArtifactPresent).toBe(true);

		// Fail-closed held: nothing was approved on an unreadable plan.
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).toBeNull();
		// And the classification is RETRYABLE (failed/plan_unreadable), not a
		// final conflict that would durably destroy the valid APPROVED.
		expect(result.outcome).toBe('failed');
		expect(result.reasonCode).toBe('plan_unreadable');

		// Recovery: the plan is readable again (identical, unchanged) — the
		// replay lands the approval the critic actually gave.
		writePlan(dir, plan);
		const replay = await recordVerifiedPlanCriticApproval(dir, {
			parentSessionId: 'ses_f001_parent',
			callId: 'call-f001-contention',
			verdictText: APPROVED_TEXT,
			dispatchPlanStructureHash: dispatchHash,
			transport: 'async_completion',
		});
		expect(replay.outcome).toBe('recorded');
		expect(
			await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
		).not.toBeNull();
	});

	test('a competing ledger-lock holder blocks the commit fence: it runs once only after release, and the retryable outcome replays', async () => {
		await initLedger(dir, derivePlanId(plan));
		const dispatchHash = computePlanStructureHash(plan);
		const planPath = join(dir, '.swarm', 'plan.json');
		const ledgerLockArtifact = getOwnerLockPath(dir, LEDGER_LOCK_PATH);

		// Positive, event-driven signal that the recorder is BLOCKED on the
		// held lock: withEvidenceLock emits evidence_lock_contended on every
		// contended acquisition attempt. The listener needs a live telemetry
		// stream (emit() drops events while no stream is open), so init it
		// against the test project and reset in the finally/afterEach.
		initTelemetry(dir);
		const contention = deferred();
		const listener: TelemetryListener = (event, data) => {
			if (event !== 'evidence_lock_contended') return;
			if (data.evidencePath !== LEDGER_LOCK_PATH) return;
			contention.resolve();
		};
		addTelemetryListener(listener);

		// Competing writer: holds the SAME ledger evidence lock through the
		// same wrapper the production append path uses, until the test
		// explicitly releases it. The callback body runs only after
		// acquisition, so `competitorAcquired` is a deterministic held-lock
		// signal (no polling, no sleeps).
		let releaseCompetitor!: () => void;
		const releaseSignal = new Promise<void>((resolve) => {
			releaseCompetitor = resolve;
		});
		const competitorAcquired = deferred();
		const competitor = withEvidenceLock(
			dir,
			LEDGER_LOCK_PATH,
			'f001-competitor',
			'hold-ledger-lock',
			async () => {
				competitorAcquired.resolve();
				await releaseSignal;
			},
		);
		await competitorAcquired;

		const fenceRuns: { lockArtifactPresent: boolean }[] = [];
		const fenceRan = deferred();
		criticApprovalInternals.onPreCommitFence = () => {
			fenceRuns.push({ lockArtifactPresent: existsSync(ledgerLockArtifact) });
			// Contention AT the fenced commit point: the plan becomes
			// unreadable (e.g. a concurrent save_plan's atomic tmp→rename
			// swap) exactly while the writer holds the lock.
			rmSync(planPath);
			fenceRan.resolve();
		};

		try {
			// Start the recorder WITHOUT awaiting: it must block on the held
			// lock before any fence execution.
			let settledEarly: unknown;
			const recording = recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_f001_parent',
				callId: 'call-f001-contention-2',
				verdictText: APPROVED_TEXT,
				dispatchPlanStructureHash: dispatchHash,
				transport: 'async_completion',
			});

			// Deterministic discriminator, not a timed window: under the FIX
			// the recorder reaches the lock-wait loop and observes contention
			// while the competitor still holds. Under the PRIOR BUG the fence
			// ran unlocked BEFORE any lock attempt, threw plan_unreadable at
			// the outer call, and the recorder settled without ever
			// contending — the race below fails cleanly on that outcome.
			const phase = await Promise.race([
				contention.promise.then(() => 'contended'),
				recording.then((r) => {
					settledEarly = r;
					return 'settled-before-contention';
				}),
			]);
			expect(phase).toBe('contended');
			expect(settledEarly).toBeUndefined();

			// While the lock is still held, the fence has not executed. The
			// sentinel race is resolved-vs-pending: if the fence had run,
			// `fenceRan` would already be settled and would WIN this race.
			const whileHeld = await Promise.race([
				fenceRan.promise.then(() => 'fence-ran'),
				Promise.resolve('not-run-yet'),
			]);
			expect(whileHeld).toBe('not-run-yet');
			expect(fenceRuns.length).toBe(0);

			// Release → the recorder acquires on its next retry, and the
			// fence runs exactly once, under the lock (artifact present).
			releaseCompetitor();
			await Promise.race([fenceRan.promise, recording]);
			expect(fenceRuns.length).toBe(1);
			expect(fenceRuns[0].lockArtifactPresent).toBe(true);

			const result = await recording;
			criticApprovalInternals.onPreCommitFence = null;
			// Fail-closed held: nothing was approved on an unreadable plan.
			expect(
				await loadLastPlanCriticApprovedSnapshot(dir, derivePlanId(plan)),
			).toBeNull();
			// And the classification is RETRYABLE (failed/plan_unreadable),
			// not a final conflict that would durably destroy the APPROVED.
			expect(result.outcome).toBe('failed');
			expect(result.reasonCode).toBe('plan_unreadable');

			// Recovery replay lands the approval the critic actually gave.
			writePlan(dir, plan);
			const replay = await recordVerifiedPlanCriticApproval(dir, {
				parentSessionId: 'ses_f001_parent',
				callId: 'call-f001-contention-2',
				verdictText: APPROVED_TEXT,
				dispatchPlanStructureHash: dispatchHash,
				transport: 'async_completion',
			});
			expect(replay.outcome).toBe('recorded');
			expect(fenceRuns.length).toBe(1); // replay ran with the seam nulled
		} finally {
			criticApprovalInternals.onPreCommitFence = null;
			// Always release the competitor (idempotent resolve) so the
			// wrapper's finally runs and the lock artifact is removed before
			// the test fixture is deleted — even on an assertion failure.
			releaseCompetitor();
			await competitor.catch(() => {});
			removeTelemetryListener(listener);
			resetTelemetryForTesting();
		}
	});
});
