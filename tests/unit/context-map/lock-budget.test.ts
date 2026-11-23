/**
 * r17 audit (P1): the optional context-map write must not block a
 * delegation's completion for the evidence lock's 60 s default.
 *
 * `withContextMapLock` inherited `withEvidenceLock`'s default timeout of
 * 60 000 ms. The synchronous `tool.execute.after` path awaits
 * `updateContextMapAfterAgentLocked`, so a contended context-map lock could
 * delay a tool completion — and the whole hook chain behind it — by up to a
 * minute for what is optional enrichment (a skipped write is recovered by
 * the journaled closeout and the maintenance-point reconciliation).
 *
 * The r17 repair threads an explicit, per-path ACQUISITION budget through
 * `withEvidenceLock`'s existing `timeoutMs` parameter (hook 1.5 s /
 * background 5 s / maintenance 10 s). On budget expiry the callback never
 * started — the mutation is skipped whole, no partial write is possible,
 * and no uncontrolled continuation keeps running (this is why the budget is
 * NOT a `Promise.race` around the write operation).
 *
 * Tests use an INJECTABLE short budget (250 ms) instead of real 60 s waits,
 * and prove lock-waiting deterministically via the `evidence_lock_contended`
 * telemetry event (the same event-driven barrier pattern as
 * stale-promotion-fence.test.ts).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import {
	CONTEXT_MAP_LOCK_BUDGET_MS,
	type PostAgentUpdateParams,
	updateContextMapAfterAgentLocked,
	withContextMapLock,
} from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetSwarmState } from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	removeTelemetryListener,
	resetTelemetryForTesting,
} from '../../../src/telemetry';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '1.1';
const TEST_BUDGET_MS = 250;
/** CI-slack upper bound for a 250 ms budget expiry (backoff jitter + load). */
const BUDGET_EXPIRY_SLACK_MS = 3_000;

function makeProject(): string {
	const { dir, cleanup } = createSafeTestDir('ctxmap-lockbudget-');
	fs.mkdirSync(join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(join(dir, '.opencode'), { recursive: true });
	currentCleanup = cleanup;
	return dir;
}

let currentCleanup: (() => void) | null = null;

function childParams(
	directory: string,
	taskId = TASK_ID,
): PostAgentUpdateParams {
	return {
		task_id: taskId,
		agent_role: 'coder',
		files_touched: [],
		implementation_summary: 'child finished its work',
		task_goal: 'do the work',
		final_status: 'in_progress',
		directory,
	};
}

function seedMap(directory: string): void {
	saveContextMap(
		appendTaskHistory(createEmptyContextMap(), {
			task_id: '0.1',
			goal: '',
			files_touched: [],
			implementation_summary: 'base',
			final_status: 'pending',
		}),
		directory,
	);
}

describe('context-map — bounded lock waits for the optional write (r17 P1)', () => {
	let directory: string;
	let warnSpy: ReturnType<typeof spyOn>;
	let originalDebug: string | undefined;

	beforeEach(() => {
		resetSwarmState();
		resetTelemetryForTesting();
		directory = makeProject();
		seedMap(directory);
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
		closeAllProjectDbs();
		currentCleanup?.();
		currentCleanup = null;
	});

	test('the update path provably WAITS on the context-map lock while it is held', async () => {
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
				'lockbudget-holder',
				'holder',
				async () => {
					await holderGate;
				},
			);

			// Long budget so the acquisition WAIT (not the budget) is what we
			// observe: the update cannot complete while the lock is held.
			const updateDone = updateContextMapAfterAgentLocked(
				childParams(directory),
				60_000,
			);
			await contended; // deterministic: the update is inside the lock retry loop

			// Only after the holder releases does the update complete.
			releaseHolder?.();
			await holderDone;
			await updateDone;

			// The write landed exactly once, after the barrier.
			const history = loadContextMap(directory)?.task_history ?? {};
			expect(history[TASK_ID]?.final_status).toBe('pending');
			expect(history['0.1']?.implementation_summary).toBe('base');
		} finally {
			removeTelemetryListener(listener);
		}
	});

	test('a short budget EXPIRES: the update is skipped whole within the budget', async () => {
		initTelemetry(directory);
		let releaseHolder: (() => void) | undefined;
		const holderGate = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holderDone = withContextMapLock(
			directory,
			'lockbudget-holder',
			'holder',
			async () => {
				await holderGate;
			},
		);

		try {
			const startedAt = Date.now();
			// Must not throw — a skipped optional write is a value, not an error.
			await updateContextMapAfterAgentLocked(
				childParams(directory),
				TEST_BUDGET_MS,
			);
			const elapsed = Date.now() - startedAt;

			// The acquisition wait was bounded by the injected budget (+ slack
			// for the backoff iteration), NOT the 60 s default: pre-fix, the
			// call waited for the holder (released after 3 s below) and blew
			// this bound — that is the reproduction of the blocking hazard.
			expect(elapsed).toBeLessThan(BUDGET_EXPIRY_SLACK_MS);

			// No partial write: the callback never started, the map is
			// untouched, and the base entry survives.
			const history = loadContextMap(directory)?.task_history ?? {};
			expect(history[TASK_ID]).toBeUndefined();
			expect(history['0.1']?.implementation_summary).toBe('base');

			// The condition is diagnosable (lock-failure warn logged).
			const warned = warnSpy.mock.calls
				.map((call) => String(call[0]))
				.some((text) => text.includes('write lock'));
			expect(warned).toBe(true);
		} finally {
			// Holder releases only AFTER the budget assertion — pre-fix this
			// is what made the call wait (and the elapsed bound fail).
			setTimeout(() => releaseHolder?.(), 3_000);
			await holderDone;
		}
	});

	test('a free lock performs the write immediately within the budget', async () => {
		const startedAt = Date.now();
		await updateContextMapAfterAgentLocked(
			childParams(directory),
			TEST_BUDGET_MS,
		);
		expect(Date.now() - startedAt).toBeLessThan(BUDGET_EXPIRY_SLACK_MS);
		expect(loadContextMap(directory)?.task_history[TASK_ID]?.final_status).toBe(
			'pending',
		);
	});

	test('replay: a budget-skipped write is recovered by the next attempt, exactly once', async () => {
		let releaseHolder: (() => void) | undefined;
		const holderGate = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holderDone = withContextMapLock(
			directory,
			'lockbudget-holder',
			'holder',
			async () => {
				await holderGate;
			},
		);

		// First attempt: skipped on the budget.
		await updateContextMapAfterAgentLocked(
			childParams(directory),
			TEST_BUDGET_MS,
		);
		expect(loadContextMap(directory)?.task_history[TASK_ID]).toBeUndefined();

		// Lock free again: the replay lands the pending write.
		releaseHolder?.();
		await holderDone;
		await updateContextMapAfterAgentLocked(
			childParams(directory),
			TEST_BUDGET_MS,
		);

		const history = loadContextMap(directory)?.task_history ?? {};
		expect(history[TASK_ID]?.final_status).toBe('pending');
		expect(history['0.1']?.implementation_summary).toBe('base');
		// No duplication: exactly the base entry plus the one replayed task.
		expect(Object.keys(history).sort()).toEqual(['0.1', TASK_ID]);
	});

	test('a contended task does not block longer than its budget while another task holds', async () => {
		// Task A holds the lock through a long-running coordinated write.
		let releaseHolder: (() => void) | undefined;
		const holderGate = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holderDone = withContextMapLock(
			directory,
			'task-a',
			'2.1',
			async () => {
				await holderGate;
			},
		);

		try {
			// Task B's OPTIONAL update skips within its own budget instead of
			// queueing behind A's write for the 60 s default.
			const startedAt = Date.now();
			await updateContextMapAfterAgentLocked(
				childParams(directory, '3.1'),
				TEST_BUDGET_MS,
			);
			const elapsed = Date.now() - startedAt;
			expect(elapsed).toBeLessThan(BUDGET_EXPIRY_SLACK_MS);
			expect(loadContextMap(directory)?.task_history['3.1']).toBeUndefined();
		} finally {
			releaseHolder?.();
			await holderDone;
		}

		// A's own write still completes normally once it finishes.
		await updateContextMapAfterAgentLocked(
			childParams(directory, '2.1'),
			TEST_BUDGET_MS,
		);
		expect(loadContextMap(directory)?.task_history['2.1']?.final_status).toBe(
			'pending',
		);
	});

	test('nested context-map locks cannot deadlock: the inner acquire skips on its budget', async () => {
		// The lock is exclusive and NOT re-entrant. A nested acquire (a bug
		// class the production paths avoid) previously hung for the full 60 s
		// deadline; with the budget it fails fast and the OUTER cycle still
		// completes.
		const outerDone = withContextMapLock(
			directory,
			'outer',
			'outer-task',
			async () => {
				const inner = await withContextMapLock(
					directory,
					'inner',
					'inner-task',
					() => {
						// Must never run.
						saveContextMap(
							appendTaskHistory(createEmptyContextMap(), {
								task_id: '9.9',
								goal: '',
								files_touched: [],
								implementation_summary: 'must not exist',
								final_status: 'pending',
							}),
							directory,
						);
					},
					TEST_BUDGET_MS,
				);
				expect(inner.ok).toBe(false);
			},
			10_000,
		);

		const startedAt = Date.now();
		await outerDone;
		const elapsed = Date.now() - startedAt;
		// No 60 s hang: the outer cycle finished shortly after the inner
		// budget expired.
		expect(elapsed).toBeLessThan(BUDGET_EXPIRY_SLACK_MS + 10_000);
		// The inner callback never ran.
		expect(loadContextMap(directory)?.task_history['9.9']).toBeUndefined();
	});

	test('the shipped budgets are bounded well below the 60 s evidence default', () => {
		expect(CONTEXT_MAP_LOCK_BUDGET_MS.hook).toBeLessThan(5_000);
		expect(CONTEXT_MAP_LOCK_BUDGET_MS.background).toBeLessThan(10_000);
		expect(CONTEXT_MAP_LOCK_BUDGET_MS.maintenance).toBeLessThan(15_000);
	});
});
