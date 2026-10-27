/**
 * Issue #3313 AC7 (trace C31, PRESERVING) — busy readiness, or unknown
 * readiness without terminal assistant proof, with no assistant text: the
 * lane stays pending until the stale horizon (settling a lane that may still
 * be producing would discard live work). Green at base and after the fix.
 */

/**
 * Issues #3312/#3313 acceptance checks — honest immediate settlement of lanes
 * whose host session provably finished without producing any assistant text.
 *
 * `collectOnce` (src/tools/dispatch-lanes.ts) skips a lane whose fetched
 * window holds no assistant text (`if (!transcript.text) continue;`) with no
 * regard for POSITIVE host-side proof that the session is done. The only
 * terminal paths for such a lane are the #2349 classified-terminal-error
 * branch (which needs `info.error`) or the 30-minute presumed-stale sweep —
 * so an idle host session that simply never spoke wedges the lane open for
 * half an hour even though the host itself reports nothing is running.
 *
 * AC30 (discriminating): readiness 'idle' from the batched status probe, OR a
 * window whose only assistant message is TERMINAL (finish 'stop', completed
 * stamp, no error) but textless, plus no terminalError — collect settles the
 * lane IMMEDIATELY as a typed 'liveness' terminal (the same
 * workflowLaneFailureClass the idle stale arm assigns in the sweep), without
 * waiting for the stale horizon. At the base tree both legs FAIL: the record
 * is still `pending` / `running` with a fresh updatedAt (failed assertion:
 * expected false, received true).
 *
 * AC31 (preserving): readiness 'busy', OR readiness 'unknown' without
 * terminal assistant proof, plus no assistant text — the lane STAYS pending
 * after a collect run that ends well before the stale horizon. A busy session
 * may still speak; an unobservable one is not proven dead. Green at the base
 * tree.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { findByCorrelationId } from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import { createCollectLaneTimeoutFixture } from './dispatch-lanes-collect-host-timeout.fixtures.js';

const {
	baseOps,
	cleanupTempDirs,
	makeTempDir,
	recordPending,
	restoreInternals,
} = createCollectLaneTimeoutFixture();

afterEach(async () => {
	restoreInternals();
	await cleanupTempDirs();
});

/** A user-only window: no assistant text, no terminal error, nothing to parse. */
function userOnlyWindow() {
	return [
		{
			info: { role: 'user' },
			parts: [{ type: 'text', text: 'dispatch prompt (no reply)' }],
		},
	];
}

/**
 * A TERMINAL but textless assistant turn: finish 'stop', completed stamp, no
 * error, no text parts. `terminalAssistantProof` is true while
 * `transcript.text` stays empty — the host finished this turn and it said
 * nothing.
 */
function textlessTerminalAssistantWindow() {
	return [
		{
			info: { role: 'assistant', time: { completed: 2 }, finish: 'stop' },
			parts: [{ type: 'text', text: '   ' }],
		},
	];
}

function sessionOpsWith(args: {
	statusData: Record<string, { type: string }>;
	window: ReturnType<typeof userOnlyWindow>;
}): void {
	_internals.getSessionOps = () => ({
		...baseOps(),
		status: mock(async () => ({ data: args.statusData })),
		messages: mock(async () => ({ data: args.window })),
	});
}

function laneLivenessClass(
	record: NonNullable<ReturnType<typeof findByCorrelationId>>,
): string | undefined {
	return (
		record.result?.workflowLaneFailureClass ??
		record.terminalResult?.result.workflowLaneFailureClass
	);
}

describe('collect_lane_results — immediate liveness settle for provably-finished silent lanes (#3312/#3313)', () => {
	test('AC31: a busy host session with no assistant text stays pending after collect', async () => {
		const directory = makeTempDir();
		const batchId = 'busy-silent-stays-pending-3313';
		const correlationId = `${batchId}-session`;
		await recordPending({ directory, batchId, correlationId });
		sessionOpsWith({
			statusData: { [correlationId]: { type: 'busy' } },
			window: userOnlyWindow(),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);

		// Busy means the child may still produce its transcript: collect must
		// not terminalize it (well before the stale horizon).
		const record = findByCorrelationId(directory, correlationId)!;
		expect(record.status).toBe('pending');
		expect(result.pending).toBe(1);
	});

	test('AC31: unknown readiness without terminal assistant proof stays pending after collect', async () => {
		const directory = makeTempDir();
		const batchId = 'unknown-silent-stays-pending-3313';
		const correlationId = `${batchId}-session`;
		await recordPending({ directory, batchId, correlationId });
		// Absent from the status map (readiness 'unknown') and the window holds
		// no terminal assistant message: nothing proves the session finished.
		sessionOpsWith({
			statusData: {},
			window: userOnlyWindow(),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);

		// Unobservable is not dead: the lane stays open for a later pass (the
		// stale horizon is 30 minutes away; this collect ran immediately).
		const record = findByCorrelationId(directory, correlationId)!;
		expect(record.status).toBe('pending');
		expect(result.pending).toBe(1);
	});
});
