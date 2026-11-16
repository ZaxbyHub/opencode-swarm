/**
 * AC4 (verdict-lane failure-class typing): a lane settled from a classified
 * PROVIDER terminal error (child session died at first inference, no output)
 * must carry a typed `workflowLaneFailureClass: 'resource'` on its settled
 * result, beside the existing `terminalErrorClass`.
 *
 * Contract for both ends: RED at base, GREEN after the fix. At base the
 * provider-terminal settlement in collectOnce writes only `terminalErrorClass`
 * (no workflowLaneFailureClass); after the fix the same settle also stamps
 * `result.workflowLaneFailureClass === 'resource'`.
 *
 * Scope decision pinned here deliberately: this dispatch is a NON-PR lane
 * (advisory-mode explorer) — the resource typing applies to ALL async lanes,
 * not PR-review lanes only.
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

/** Host whose child session died with a provider credit-exhaustion error. */
function providerTerminalHost(sessionId: string): SessionOps {
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
							name: 'APIError',
							message: 'credit balance too low',
							data: { status: 402 },
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

describe('dispatch-lanes provider-terminal resource class (AC4)', () => {
	let dir: string;
	let restoreClock: () => void;
	const realGetSessionOps = _internals.getSessionOps;

	beforeEach(() => {
		dir = canonicalMkdtemp('lane-provider-resource-class-');
		restoreClock = freezeClock({ fixedNow: NOW });
	});

	afterEach(() => {
		_internals.getSessionOps = realGetSessionOps;
		restoreClock();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('a provider-terminal error settle carries terminalErrorClass AND workflowLaneFailureClass resource', async () => {
		const sessionId = 'sess-ac4-provider';
		_internals.getSessionOps = () => providerTerminalHost(sessionId);
		await executeDispatchLanesAsync(
			{
				batch_id: 'batch-ac4-provider',
				lanes: [{ id: 'runtime', agent: 'explorer', prompt: 'inspect' }],
			},
			dir,
		);

		const result = await executeCollectLaneResults(
			{ batch_id: 'batch-ac4-provider', wait: false },
			dir,
		);

		// Harness proof (green at base): the lane settled as a classified error.
		expect(result.failed).toBe(1);
		const record = findByBatchId(dir, 'batch-ac4-provider')[0];
		expect(record).toBeDefined();
		expect(record.status).toBe('error');
		expect(record.terminalResult?.status).toBe('error');
		expect(record.terminalResult?.result.terminalErrorClass?.kind).toBe(
			'provider',
		);

		// DISCRIMINATING assertion (red at base: undefined): the same settled
		// result must be typed as a resource failure so downstream consumers
		// (resilience circuits, admission gates) never need to parse the
		// display error to learn the failure family.
		expect(record.terminalResult?.result.workflowLaneFailureClass).toBe(
			'resource',
		);
		expect(record.result?.workflowLaneFailureClass).toBe('resource');
	});
});
