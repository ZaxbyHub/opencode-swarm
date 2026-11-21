/**
 * r17 audit (P1): a context-map task-release promotion must not be derived
 * from a STALE plan snapshot.
 *
 * `reconcileContextMapTaskReleases` loads the plan, selects the tasks with
 * status 'completed', runs the (async) per-task evidence proof, and then
 * promotes. Between the plan load and the promotion the authoritative task
 * status can change — a rework flips completed → in_progress under a new
 * workflow generation. The existing plan-identity fence does not catch this:
 * `planIdentityHash` is derived from `swarm` + `title` only, so a task-status
 * change never changes it, and unstamped legacy evidence skips the mismatch
 * check entirely. Pre-fix, the promotion wrote a fresh 'approved' marking for
 * a task that was no longer released.
 *
 * The r17 repair re-verifies the CURRENT authoritative task status inside the
 * locked promotion, immediately before the write. The main test reproduces
 * the race deterministically: the cross-process context-map lock is the
 * controlled barrier (held by the test while the plan is flipped), and the
 * `evidence_lock_contended` telemetry event is the deterministic signal that
 * the reconciliation's promotion attempt has reached the barrier.
 *
 * RESIDUAL RACE (documented in the repair, pinned here as a comment): the
 * plan ledger's writes are not serialized against the context-map lock; a
 * plan write racing inside the read→promote→save window itself can still
 * interleave. No exactly-once/atomicity guarantee is claimed.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import {
	reconcileContextMapTaskReleases,
	withContextMapLock,
} from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	resetTelemetryForTesting,
	removeTelemetryListener,
} from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '1.1';

type TaskStatus = Plan['phases'][0]['tasks'][0]['status'];

function writePlan(
	directory: string,
	taskStatus: TaskStatus,
): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'r17 Stale Promotion Plan',
		swarm: 'r17-stale-promotion',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: TASK_ID,
						phase: 1,
						status: taskStatus,
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

function gateEntry(agent: string) {
	const now = new Date().toISOString();
	return { sessionId: `ses-${agent}`, timestamp: now, agent };
}

/** Schema-valid evidence for a task that genuinely completed its full QA chain. */
function writeValidCompletedEvidence(
	directory: string,
	extra: Record<string, unknown> = {},
): void {
	const now = new Date().toISOString();
	fs.writeFileSync(
		join(directory, '.swarm', 'evidence', `${TASK_ID}.json`),
		JSON.stringify({
			taskId: TASK_ID,
			required_gates: ['pre_check', 'reviewer', 'test_engineer'],
			gates: {
				pre_check: gateEntry('pre_check'),
				reviewer: gateEntry('reviewer'),
				test_engineer: gateEntry('test_engineer'),
			},
			workflow: {
				schema: 'exact-task-v1',
				generation: 0,
				state: 'complete',
				retryCount: 0,
				retryHistory: [],
				retryEpoch: 0,
				lastOutcome: 'task_completed',
				lastTransitionId: 'test-seed:complete',
				updatedAt: now,
			},
			...extra,
		}),
	);
}

/** A readable map whose task entry is pending (the pre-promotion state). */
function seedPendingMapEntry(directory: string): void {
	saveContextMap(
		appendTaskHistory(createEmptyContextMap(), {
			task_id: TASK_ID,
			goal: 'do the work',
			files_touched: ['src/a.ts'],
			implementation_summary: 'child finished; release pending',
			final_status: 'pending',
		}),
		directory,
	);
}

function makeProject(): string {
	const { dir, cleanup } = createSafeTestDir('ctxmap-stale-promo-');
	fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ context_map: { enabled: true } }),
	);
	// keep cleanup alive for afterEach via module-level handle
	currentCleanup = cleanup;
	return dir;
}

let currentCleanup: (() => void) | null = null;

describe('context-map — stale task-release promotion fence (r17 P1)', () => {
	let directory: string;
	let warnSpy: ReturnType<typeof spyOn>;
	let originalDebug: string | undefined;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		resetTelemetryForTesting();
		directory = makeProject();
		originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (originalDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = originalDebug;
		}
		resetTelemetryForTesting();
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		currentCleanup?.();
		currentCleanup = null;
	});

	test('a task flipped to in_progress during reconciliation is NOT promoted', async () => {
		writePlan(directory, 'completed');
		writeValidCompletedEvidence(directory);
		seedPendingMapEntry(directory);

		// Controlled barrier: the test holds the cross-process context-map
		// lock, so the reconciliation's promotion attempt cannot complete
		// until the test releases it. The deterministic arrival signal is the
		// evidence_lock_contended telemetry event for THIS task's promotion.
		initTelemetry(directory);
		let signalContended: (() => void) | undefined;
		const contended = new Promise<void>((resolve) => {
			signalContended = resolve;
		});
		const listener = (event: string, data: Record<string, unknown>) => {
			if (
				event === 'evidence_lock_contended' &&
				data?.taskId === TASK_ID &&
				String(data?.evidencePath ?? '').includes('context-map')
			) {
				signalContended?.();
			}
		};
		addTelemetryListener(listener);
		try {
			let releaseHolder: (() => void) | undefined;
			const holderGate = new Promise<void>((resolve) => {
				releaseHolder = resolve;
			});
			const holderDone = withContextMapLock(
				directory,
				'stale-race-holder',
				'holder',
				async () => {
					await holderGate;
				},
			);

			// The reconciliation loads the plan (1.1 completed), proves the
			// evidence, then blocks on the held lock inside the promotion.
			const reconcileDone = reconcileContextMapTaskReleases(directory);
			await contended; // deterministic: the promotion attempt is at the barrier

			// The authoritative status changes WHILE the promotion is
			// suspended at the barrier (rework under a new workflow
			// generation). Same plan identity — the identity fence cannot
			// catch this.
			writePlan(directory, 'in_progress');

			releaseHolder?.();
			await holderDone;
			await reconcileDone;

			const entry = loadContextMap(directory)?.task_history[TASK_ID];
			// The core r17 assertion: no fresh 'approved' marking for a task
			// that is no longer released. The pending entry survives untouched.
			expect(entry?.final_status).toBe('pending');
		} finally {
			removeTelemetryListener(listener);
		}
	});

	test('positive control: an unchanged completed task with full proof is promoted', async () => {
		writePlan(directory, 'completed');
		writeValidCompletedEvidence(directory);
		seedPendingMapEntry(directory);

		await reconcileContextMapTaskReleases(directory);

		expect(
			loadContextMap(directory)?.task_history[TASK_ID]?.final_status,
		).toBe('approved');
	});

	test('evidence stamped for a different plan generation is not promoted', async () => {
		writePlan(directory, 'completed');
		// A stamp naming a DIFFERENT plan identity (64-hex, never equal to the
		// seeded plan's swarm+title hash) classifies the evidence as
		// prior-campaign → fail closed.
		writeValidCompletedEvidence(directory, {
			planIdentityHash: 'a'.repeat(64),
			planId: 'prior-campaign',
		});
		seedPendingMapEntry(directory);

		await reconcileContextMapTaskReleases(directory);

		expect(
			loadContextMap(directory)?.task_history[TASK_ID]?.final_status,
		).toBe('pending');
	});

	test('a terminal rejected entry is never overwritten by a later promotion', async () => {
		writePlan(directory, 'completed');
		writeValidCompletedEvidence(directory);
		saveContextMap(
			appendTaskHistory(createEmptyContextMap(), {
				task_id: TASK_ID,
				goal: '',
				files_touched: [],
				implementation_summary: 'test engineer failed the task',
				final_status: 'rejected',
			}),
			directory,
		);

		await reconcileContextMapTaskReleases(directory);

		expect(
			loadContextMap(directory)?.task_history[TASK_ID]?.final_status,
		).toBe('rejected');
	});

	test('two concurrent reconciliations promote once, idempotently', async () => {
		writePlan(directory, 'completed');
		writeValidCompletedEvidence(directory);
		seedPendingMapEntry(directory);

		await Promise.all([
			reconcileContextMapTaskReleases(directory),
			reconcileContextMapTaskReleases(directory),
		]);

		const map = loadContextMap(directory);
		expect(map?.task_history[TASK_ID]?.final_status).toBe('approved');
		// Idempotent upsert: exactly one entry for the task id.
		expect(Object.keys(map?.task_history ?? {})).toEqual([TASK_ID]);
	});

	test('reconciliation after a process restart recovers a promotion the fence skipped', async () => {
		// The fence's skip is fail-closed and recoverable: once the task is
		// genuinely released again (completed in the authoritative plan), a
		// later maintenance pass (simulated restart: fresh reconciliation
		// call) re-drives the promotion.
		writePlan(directory, 'in_progress');
		writeValidCompletedEvidence(directory);
		seedPendingMapEntry(directory);

		await reconcileContextMapTaskReleases(directory);
		expect(
			loadContextMap(directory)?.task_history[TASK_ID]?.final_status,
		).toBe('pending');

		writePlan(directory, 'completed');
		await reconcileContextMapTaskReleases(directory);
		expect(
			loadContextMap(directory)?.task_history[TASK_ID]?.final_status,
		).toBe('approved');
	});
});
