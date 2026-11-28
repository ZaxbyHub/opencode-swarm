/**
 * The stale sweep's activity guard (the 2026-11-26 task 2.15 liveness wedge).
 *
 * Faked wedge arc from the live incident: three consecutive coder rounds ran
 * JVM-coupled test suites past the 30-minute mark and were each stale-swept
 * AT the mark — because the sweep measured the record's STORE `updatedAt`,
 * and a live child writes nothing to the store between dispatch and terminal.
 * The rounds delivered their committed work seconds after their flips; the
 * settlements never happened; the task wedged at idle with a
 * user-salvaged deliverable.
 *
 * Pins: an active child (open tool call) is NOT swept even when the record's
 * store age exceeds the timeout; the same record IS swept once the child goes
 * quiet past the window (the historical semantics survive — a genuinely dead
 * child still gets reclaimed); an operator-forced sweep (#2971 terminal
 * stamping) bypasses the guard.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_resetChildActivityForTesting,
	noteChildSessionEvent,
} from '../../../src/background/child-activity';
import {
	findByCorrelationId,
	type RecordPendingInput,
	recordPendingDelegation,
	sweepStaleDelegations,
} from '../../../src/background/pending-delegations';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let directory = '';
let cleanup = (): void => {};

beforeEach(() => {
	resetSwarmState();
	_resetChildActivityForTesting();
	({ dir: directory, cleanup } = createSafeTestDir('stale-sweep-guard-'));
});

afterEach(() => {
	resetSwarmState();
	_resetChildActivityForTesting();
	cleanup();
});

function pendingInput(correlationId: string): RecordPendingInput {
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'ses-arch-2-15',
		callID: `call-${correlationId}`,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'astra_coder',
		planTaskId: '2.15',
		evidenceTaskId: '2.15',
		taskChangeContext: {
			declaredFiles: ['src/labor_supply.py'],
			baseline: {
				directory,
				gitHead: 'e5f4222a4992b1dcd49ee03729c6666953592499',
				dirtyHash: 'clean',
				changedFiles: [],
				prHeadSha: null,
				scope: '2.15',
			},
			workflowGeneration: 0,
		},
	};
}

async function seedRunningRecord(correlationId: string): Promise<void> {
	const recorded = await recordPendingDelegation(
		directory,
		pendingInput(correlationId),
	);
	expect(recorded).not.toBeNull();
}

describe('stale sweep activity guard (task 2.15 liveness wedge)', () => {
	test('an active child with an open tool call is NOT swept past the store-age timeout', async () => {
		await seedRunningRecord('ses-2-15-round-3');
		// The record's store age now exceeds a 5 ms timeout.
		await Bun.sleep(10);
		// The child is mid-execution of a long test run (tool open).
		noteChildSessionEvent('ses-2-15-round-3', 'tool_open');

		const swept = await sweepStaleDelegations(directory, 5);

		expect(swept).toBe(0);
		const record = await findByCorrelationId(directory, 'ses-2-15-round-3');
		expect(record?.status).toBe('pending');
	});

	test('the same record IS swept once the child is quiet past the window (historical semantics)', async () => {
		await seedRunningRecord('ses-2-15-dead-round');
		await Bun.sleep(10);
		// No registry entry at all: the child was never observed (v1 host) or
		// has been quiet — the store-age rule applies unchanged.
		const swept = await sweepStaleDelegations(directory, 5);

		expect(swept).toBe(1);
		const record = await findByCorrelationId(directory, 'ses-2-15-dead-round');
		expect(record?.status).toBe('stale');
		expect(record?.terminalResult?.result?.workflowLaneFailureClass).toBe(
			'liveness',
		);
	});

	test('a closed tool call lets the sweep proceed after the window', async () => {
		await seedRunningRecord('ses-2-15-finished-round');
		await Bun.sleep(10);
		noteChildSessionEvent('ses-2-15-finished-round', 'tool_open');
		noteChildSessionEvent('ses-2-15-finished-round', 'tool_close');
		noteChildSessionEvent('ses-2-15-finished-round', 'session_end');
		await Bun.sleep(10);

		const swept = await sweepStaleDelegations(directory, 5);

		expect(swept).toBe(1);
		const record = await findByCorrelationId(
			directory,
			'ses-2-15-finished-round',
		);
		expect(record?.status).toBe('stale');
	});

	test('an operator-forced sweep (#2971 terminal stamping) bypasses the activity guard', async () => {
		await seedRunningRecord('ses-2-15-forced-round');
		await Bun.sleep(10);
		noteChildSessionEvent('ses-2-15-forced-round', 'tool_open');

		const swept = await sweepStaleDelegations(directory, 5, {
			failureClass: 'operator_cancelled',
		});

		expect(swept).toBe(1);
		const record = await findByCorrelationId(
			directory,
			'ses-2-15-forced-round',
		);
		expect(record?.status).toBe('stale');
	});
});
