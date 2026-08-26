/**
 * Shared fixtures for the issue #2349 terminal-provider-error lane suites.
 *
 * Extracted when `dispatch-lanes-terminal-provider-error.test.ts` crossed the
 * FR-006 500-line cap, so the settle-behavior suite and the
 * classification/format suite can each stay under it without duplicating the
 * host mock. Both suites drive the REAL `executeCollectLaneResults` entry point;
 * only the host `SessionOps` is injected, through the existing `_internals`
 * seam (no new `mock.module` targets).
 */
import { recordPendingDelegation } from '../../src/background/pending-delegations.js';
import {
	_internals,
	executeCollectLaneResults,
} from '../../src/tools/dispatch-lanes.js';

export const LANE_SESSION_ID = 'sub-lane-2349';
export const LANE_CORRELATION_ID = 'c-lane-2349';
export const LANE_BATCH_ID = 'batch-2349';

/** An SDK-shaped assistant message: `info.error` union + optional text parts. */
export function assistantMessage(options: {
	error?: unknown;
	completed?: number | undefined;
	text?: string;
}): unknown {
	return {
		info: {
			role: 'assistant',
			time:
				options.completed === undefined ? {} : { completed: options.completed },
			...(options.error === undefined ? {} : { error: options.error }),
		},
		parts:
			options.text === undefined ? [] : [{ type: 'text', text: options.text }],
	};
}

/**
 * Install a fake host. `statusType: null` models the six-way `'unknown'`
 * readiness collapse (no usable status), which is what a budget-exhausted poll
 * produces — the state in which an elapsed-time SLO would be unsafe.
 */
export function installLaneHost(options: {
	statusType: string | null;
	messages: unknown[];
}): void {
	_internals.getSessionOps = () =>
		({
			status: async () => ({
				data:
					options.statusType === null
						? {}
						: { [LANE_SESSION_ID]: { type: options.statusType } },
			}),
			messages: async () => ({ data: options.messages }),
			abort: async () => ({}),
			delete: async () => ({}),
		}) as never;
}

export async function recordLaneFixture(directory: string): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId: LANE_CORRELATION_ID,
		jobId: null,
		subagentSessionId: LANE_SESSION_ID,
		parentSessionId: 'collect-parent',
		callID: `call-${LANE_CORRELATION_ID}`,
		normalizedAgent: 'sme',
		swarmPrefixedAgent: 'mega_sme',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: LANE_BATCH_ID,
		laneId: 'lane-2349',
		mode: undefined,
		workflowLane: null,
		workspace: {
			directory,
			gitHead: 'abc123',
			dirtyHash: null,
			prHeadSha: 'abc123',
			scope: null,
		},
	});
}

export async function collectLaneFixture(
	directory: string,
): Promise<Awaited<ReturnType<typeof executeCollectLaneResults>>> {
	return executeCollectLaneResults(
		{ batch_id: LANE_BATCH_ID, wait: false },
		directory,
	);
}
