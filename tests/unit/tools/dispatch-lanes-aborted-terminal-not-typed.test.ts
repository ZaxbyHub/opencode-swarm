/**
 * AC26 (verdict-lane failure-class typing): a lane settled from an ABORTED
 * host cancellation (MessageAbortedError, no output) settles `cancelled` and
 * must NOT be typed as a resource failure — no `workflowLaneFailureClass` is
 * written on that settle.
 *
 * Contract for both ends: GREEN at base and head. Aborted host cancellations
 * are never typed `resource` and are never admitted by N-of-M terminal
 * completion; the class scoping added for provider-terminal errors must not
 * reach the cancelled branch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { findByBatchId } from '../../../src/background/pending-delegations.js';
import {
	_internals,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = 1_750_000_000_000;

/** Host whose child session ended in an unambiguous host abort. */
function abortedTerminalHost(sessionId: string): SessionOps {
	return {
		create: async () => ({ data: { id: sessionId }, error: undefined }),
		prompt: async () => ({
			data: { parts: [{ type: 'text' as const, text: 'unused' }] },
			error: undefined,
		}),
		promptAsync: async () => ({ data: undefined, error: undefined }),
		status: async () => ({
			data: { [sessionId]: { type: 'idle' } },
			error: undefined,
		}),
		messages: async () => ({
			data: [
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'p' }] },
				{
					info: {
						role: 'assistant',
						time: { completed: NOW },
						error: {
							name: 'MessageAbortedError',
							message: 'aborted by operator',
						},
					},
					parts: [],
				},
			],
			error: undefined,
		}),
		delete: async () => undefined,
		abort: async () => undefined,
	} as never;
}

describe('dispatch-lanes aborted terminal is never typed resource (AC26)', () => {
	let dir: string;
	let restoreClock: () => void;
	const realGetSessionOps = _internals.getSessionOps;

	beforeEach(() => {
		dir = canonicalMkdtemp('lane-aborted-not-typed-');
		restoreClock = freezeClock({ fixedNow: NOW });
	});

	afterEach(() => {
		_internals.getSessionOps = realGetSessionOps;
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('an aborted terminal settles cancelled with no workflowLaneFailureClass', async () => {
		const sessionId = 'sess-ac26-aborted';
		_internals.getSessionOps = () => abortedTerminalHost(sessionId);
		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-ac26-aborted',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
		);

		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-ac26-aborted', wait: false },
			dir,
		);

		// Harness proof (green at base): the abort settled as a cancellation
		// with its typed terminalErrorClass provenance intact.
		expect(result.failed).toBe(0);
		const record = findByBatchId(dir, 'batch-ac26-aborted')[0];
		expect(record).toBeDefined();
		expect(record.status).toBe('cancelled');
		expect(record.terminalResult?.status).toBe('cancelled');
		expect(record.terminalResult?.result.terminalErrorClass?.kind).toBe(
			'aborted',
		);

		// PRESERVING assertion (green at base and head): an aborted host
		// cancellation is not a resource failure. It must never be admitted by
		// N-of-M terminal completion, and it must never carry the 'resource'
		// class introduced for provider-terminal error settles.
		expect(
			record.terminalResult?.result.workflowLaneFailureClass,
		).toBeUndefined();
		expect(record.result?.workflowLaneFailureClass).toBeUndefined();
	});
});
