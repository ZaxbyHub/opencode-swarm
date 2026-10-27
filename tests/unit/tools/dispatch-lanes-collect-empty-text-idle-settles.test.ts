/**
 * Issue #3313 AC6 (trace C30, DISCRIMINATING) — an empty-text lane whose host
 * readiness is idle (or whose window carries a terminal-but-textless assistant
 * message) settles IMMEDIATELY with the typed `liveness` class instead of
 * waiting out the 30-minute stale horizon. RED at base: the record stays
 * `pending` after collect (`!transcript.text` skip; only the age check
 * settles, after DEFAULT_ASYNC_STALE_TIMEOUT_MS) — the not-pending assertion
 * fails (Expected: false / Received: true). GREEN after the fix.
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
	test('AC30: an idle host session with no assistant text settles a typed liveness terminal during collect', async () => {
		const directory = makeTempDir();
		const batchId = 'idle-silent-liveness-3313';
		const correlationId = `${batchId}-session`;
		await recordPending({ directory, batchId, correlationId });
		sessionOpsWith({
			statusData: { [correlationId]: { type: 'idle' } },
			window: userOnlyWindow(),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);

		// The host affirmatively reports nothing is running and the lane never
		// spoke: collect must settle it NOW with the typed 'liveness' class
		// (the same class the idle stale arm assigns), not hold it open until
		// the 30-minute presumed-stale horizon.
		// Base-tree failure signature (captured at 6c68fc7af): record.status
		// 'pending', result.pending 1.
		const record = findByCorrelationId(directory, correlationId)!;
		expect(record.status === 'pending' || record.status === 'running').toBe(
			false,
		);
		expect(laneLivenessClass(record)).toBe('liveness');
		expect(result.pending).toBe(0);
		expect(result.all_settled).toBe(true);
	});

	test('AC30: a terminal-but-textless assistant message with unknown readiness settles a typed liveness terminal during collect', async () => {
		const directory = makeTempDir();
		const batchId = 'terminal-proof-liveness-3313';
		const correlationId = `${batchId}-session`;
		await recordPending({ directory, batchId, correlationId });
		// The child session is ABSENT from the status map (readiness
		// 'unknown'); the transcript itself carries the terminal proof.
		sessionOpsWith({
			statusData: {},
			window: textlessTerminalAssistantWindow(),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			directory,
		);

		// terminalAssistantProof true + no assistant text + no terminalError:
		// the lane's last assistant turn ended without saying anything, so the
		// lane settles immediately as liveness-dead rather than wedging open.
		// Base-tree failure signature (captured at 6c68fc7af): record.status
		// 'pending', result.pending 1.
		const record = findByCorrelationId(directory, correlationId)!;
		expect(record.status === 'pending' || record.status === 'running').toBe(
			false,
		);
		expect(laneLivenessClass(record)).toBe('liveness');
		expect(result.pending).toBe(0);
		expect(result.all_settled).toBe(true);
	});
});
