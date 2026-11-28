/**
 * Event-pump wiring for the child-activity registry (the 2026-11-26 task
 * 2.15 liveness wedge).
 *
 * Drives the REAL deferred pump over a finite envelope list (same harness as
 * the #3401 scope-activation suites — no mocks) and pins that host tool and
 * execution events land in the registry: a `session.tool.called` envelope
 * opens the child's tool counter, `session.tool.success` closes it, and a
 * session end clears it. The registry is what the stale sweep consults —
 * without this feed the sweep keeps measuring store-write age and
 * stale-flips live children on long runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_resetChildActivityForTesting,
	childBlocksStaleSweep,
} from '../../../../src/background/child-activity';
import { resetSwarmState } from '../../../../src/state';
import { pumpEnvelopes } from './_scope-activation-progress-3401-helpers';

const CHILD = 'ses-2-15-pump-child';

function toolCalled(sessionID: string): Record<string, unknown> {
	return {
		type: 'session.tool.called',
		data: { sessionID, id: 'call-1', input: {}, executed: false },
	};
}

function toolSucceeded(sessionID: string): Record<string, unknown> {
	return {
		type: 'session.tool.success',
		data: { sessionID, id: 'call-1' },
	};
}

function executionSucceeded(sessionID: string): Record<string, unknown> {
	return {
		type: 'session.execution.succeeded',
		data: { sessionID },
	};
}

function textDelta(sessionID: string): Record<string, unknown> {
	return {
		type: 'session.text.delta',
		data: { sessionID },
	};
}

beforeEach(() => {
	resetSwarmState();
	_resetChildActivityForTesting();
});

afterEach(() => {
	resetSwarmState();
	_resetChildActivityForTesting();
});

describe('child-activity registry pump wiring (task 2.15 liveness wedge)', () => {
	test('a tool.called envelope opens the child tool counter (blocks the stale sweep)', async () => {
		const { drained } = await pumpEnvelopes([toolCalled(CHILD)]);
		expect(drained).toBe(true);
		// withinMs 0: only an OPEN tool call can block on a zero window.
		expect(childBlocksStaleSweep(CHILD, 0)).toBe(true);
	});

	test('tool.success closes the counter; a session end clears any residue', async () => {
		const { drained } = await pumpEnvelopes([
			toolCalled(CHILD),
			toolSucceeded(CHILD),
		]);
		expect(drained).toBe(true);
		// Closed + quiet: a zero window must not block.
		expect(childBlocksStaleSweep(CHILD, 0)).toBe(false);

		_resetChildActivityForTesting();
		const second = await pumpEnvelopes([
			toolCalled(CHILD),
			executionSucceeded(CHILD),
		]);
		expect(second.drained).toBe(true);
		// session_end cleared the open counter — quiet for a zero window.
		expect(childBlocksStaleSweep(CHILD, 0)).toBe(false);
	});

	test('ordinary session events mark the child recently active', async () => {
		const { drained } = await pumpEnvelopes([textDelta(CHILD)]);
		expect(drained).toBe(true);
		expect(childBlocksStaleSweep(CHILD, 60_000)).toBe(true);
		expect(childBlocksStaleSweep('ses-never-pumped', 60_000)).toBe(false);
	});
});
