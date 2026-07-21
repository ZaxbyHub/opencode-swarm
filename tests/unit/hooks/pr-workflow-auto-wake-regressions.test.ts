import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	_test_exports,
	isPrWorkflowAutoWakeSuppressed,
	MAX_TRACKED_PR_WORKFLOW_WAKE_STATES,
	markPrWorkflowPluginWake,
	observePrWorkflowAutoWakeEvent,
	PLUGIN_WAKE_MARKER_TTL_MS,
} from '../../../src/hooks/pr-workflow-auto-wake.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';
const originalReadPrWorkflowGateState = _internals.readPrWorkflowGateState;

function abortEvent(sessionID: string) {
	return {
		type: 'session.error',
		properties: {
			sessionID,
			error: { name: 'MessageAbortedError' },
		},
	};
}

function idleEvent(sessionID: string) {
	return { type: 'session.idle', properties: { sessionID } };
}

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-auto-wake-regression-')),
	);
	_internals.readPrWorkflowGateState = originalReadPrWorkflowGateState;
	gateInternals.resetTrackedStateCache();
	_test_exports.reset();
});

afterEach(async () => {
	_internals.readPrWorkflowGateState = originalReadPrWorkflowGateState;
	gateInternals.resetTrackedStateCache();
	_test_exports.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR auto-wake regressions', () => {
	test('fails closed when the abort-path gate read throws (F-002)', async () => {
		await activatePrWorkflow(directory, 'read-error-parent', 'PR_REVIEW');
		// This mock exercises only the transient read-error branch. Successful
		// gate and no-gate branches remain covered by the response-gate tests.
		_internals.readPrWorkflowGateState = mock(async () => {
			throw new Error('transient gate read failure');
		}) as typeof _internals.readPrWorkflowGateState;

		// Previous code rejected before recording a pause, so the plugin-level
		// catch lost the one-shot interruption and the next idle could auto-wake.
		const decision = await observePrWorkflowAutoWakeEvent(
			directory,
			abortEvent('read-error-parent'),
		);

		expect(decision.suppressWake).toBe(true);
		expect(isPrWorkflowAutoWakeSuppressed(directory, 'read-error-parent')).toBe(
			true,
		);
	});

	test('rolls back the provisional pause when the aborted session has no gate', async () => {
		const decision = await observePrWorkflowAutoWakeEvent(
			directory,
			abortEvent('ungated-child'),
		);

		expect(decision.suppressWake).toBe(false);
		expect(isPrWorkflowAutoWakeSuppressed(directory, 'ungated-child')).toBe(
			false,
		);
	});

	test('preserves an existing pause when the idle-path gate read throws', async () => {
		const sessionID = 'idle-read-error-parent';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await observePrWorkflowAutoWakeEvent(directory, abortEvent(sessionID));
		// This mock exercises only the transient idle read-error branch. Normal
		// idle transitions and cleared-gate cleanup are covered elsewhere.
		_internals.readPrWorkflowGateState = mock(async () => {
			throw new Error('transient idle gate read failure');
		}) as typeof _internals.readPrWorkflowGateState;

		const decision = await observePrWorkflowAutoWakeEvent(
			directory,
			idleEvent(sessionID),
		);

		expect(decision.suppressWake).toBe(true);
		expect(_test_exports.getPausePhase(directory, sessionID)).toBe(
			'awaiting-idle',
		);
	});

	test('records the abort pause before a concurrent idle event can overtake it (F-004, F-011a)', async () => {
		const sessionID = 'concurrent-abort-parent';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		const gateState = await originalReadPrWorkflowGateState(
			directory,
			sessionID,
		);
		let releaseFirstRead!: (value: typeof gateState) => void;
		const firstRead = new Promise<typeof gateState>((resolve) => {
			releaseFirstRead = resolve;
		});
		let reads = 0;
		// The first read is deliberately deferred to model OpenCode's concurrent
		// `void hook.event(...)` dispatch. Other read outcomes are covered by the
		// surrounding auto-wake and response-gate suites.
		_internals.readPrWorkflowGateState = mock(async () => {
			reads += 1;
			return reads === 1 ? firstRead : gateState;
		}) as typeof _internals.readPrWorkflowGateState;

		const abortDecisionPromise = observePrWorkflowAutoWakeEvent(
			directory,
			abortEvent(sessionID),
		);
		const idleDecision = await observePrWorkflowAutoWakeEvent(
			directory,
			idleEvent(sessionID),
		);
		releaseFirstRead(gateState);
		const abortDecision = await abortDecisionPromise;

		// Previous code awaited the first read before publishing the pause, so the
		// idle decision observed no suppression and could enter the wake path.
		expect(idleDecision.suppressWake).toBe(true);
		expect(abortDecision.suppressWake).toBe(true);
		expect(_test_exports.getPausePhase(directory, sessionID)).toBe('paused');
	});

	test('preserves a real user resume observed during an in-flight idle read (F-004)', async () => {
		const sessionID = 'user-during-idle-read-parent';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await observePrWorkflowAutoWakeEvent(directory, abortEvent(sessionID));
		const gateState = await originalReadPrWorkflowGateState(
			directory,
			sessionID,
		);
		let releaseIdleRead!: (value: typeof gateState) => void;
		const idleRead = new Promise<typeof gateState>((resolve) => {
			releaseIdleRead = resolve;
		});
		_internals.readPrWorkflowGateState = mock(
			async () => idleRead,
		) as typeof _internals.readPrWorkflowGateState;

		const idlePromise = observePrWorkflowAutoWakeEvent(
			directory,
			idleEvent(sessionID),
		);
		await Promise.resolve();
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'message.updated',
			properties: {
				info: {
					id: 'msg_real_user_during_idle_read',
					role: 'user',
					sessionID,
				},
			},
		});
		expect(_test_exports.getPausePhase(directory, sessionID)).toBe('resuming');

		releaseIdleRead(gateState);
		const idleDecision = await idlePromise;

		// Previous code used its stale awaiting-idle snapshot after the read and
		// overwrote `resuming` back to `paused`, losing the explicit user turn.
		expect(idleDecision.suppressWake).toBe(true);
		expect(_test_exports.getPausePhase(directory, sessionID)).toBeUndefined();
		expect(isPrWorkflowAutoWakeSuppressed(directory, sessionID)).toBe(false);
	});

	test('cleans legacy session.deleted state keyed by properties.info.id (F-003)', async () => {
		const sessionID = 'legacy-deleted-parent';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		markPrWorkflowPluginWake(directory, sessionID);
		await observePrWorkflowAutoWakeEvent(directory, abortEvent(sessionID));

		// Previous code ignored the SDK legacy deletion envelope because it read
		// info.sessionID/sessionId but not the documented info.id field.
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'session.deleted',
			properties: { info: { id: sessionID } },
		});

		expect(isPrWorkflowAutoWakeSuppressed(directory, sessionID)).toBe(false);
		expect(_test_exports.getPluginWakeMarkerCount(directory, sessionID)).toBe(
			0,
		);
	});

	test('marker inspection does not refresh bounded FIFO eviction order (F-007)', () => {
		const oldestSession = 'marker-oldest';
		markPrWorkflowPluginWake(directory, oldestSession);
		for (
			let index = 1;
			index < MAX_TRACKED_PR_WORKFLOW_WAKE_STATES;
			index += 1
		) {
			markPrWorkflowPluginWake(directory, `marker-${index}`);
		}
		expect(
			_test_exports.getPluginWakeMarkerCount(directory, oldestSession),
		).toBe(1);

		// Previous pruning deleted and reinserted the inspected key, turning this
		// read-only test helper into an LRU refresh and evicting marker-1 instead.
		markPrWorkflowPluginWake(directory, 'marker-overflow');
		expect(
			_test_exports.getPluginWakeMarkerCount(directory, oldestSession),
		).toBe(0);
	});

	test('expires an unconsumed synthetic marker after its TTL (F-010)', async () => {
		const sessionID = 'expired-marker-parent';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		const messageID = markPrWorkflowPluginWake(directory, sessionID);
		await observePrWorkflowAutoWakeEvent(directory, abortEvent(sessionID));
		await observePrWorkflowAutoWakeEvent(directory, idleEvent(sessionID));

		_test_exports.getPluginWakeMarkerCount(
			directory,
			sessionID,
			Date.now() + PLUGIN_WAKE_MARKER_TTL_MS + 1,
		);
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'message.updated',
			properties: { info: { id: messageID, role: 'user', sessionID } },
		});

		expect(_test_exports.getPausePhase(directory, sessionID)).toBe('resuming');
	});

	test('treats a non-existent ID as real while preserving a different live marker (F-010)', async () => {
		const sessionID = 'unmatched-marker-parent';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		markPrWorkflowPluginWake(directory, sessionID);
		await observePrWorkflowAutoWakeEvent(directory, abortEvent(sessionID));
		await observePrWorkflowAutoWakeEvent(directory, idleEvent(sessionID));

		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'message.updated',
			properties: {
				info: {
					id: 'msg_real_user_not_in_marker_set',
					role: 'user',
					sessionID,
				},
			},
		});

		expect(_test_exports.getPausePhase(directory, sessionID)).toBe('resuming');
		expect(_test_exports.getPluginWakeMarkerCount(directory, sessionID)).toBe(
			1,
		);
	});

	test('stacked abort events preserve suppression through the idle boundary (F-010)', async () => {
		const sessionID = 'stacked-abort-parent';
		await activatePrWorkflow(directory, sessionID, 'PR_FEEDBACK');

		await observePrWorkflowAutoWakeEvent(directory, abortEvent(sessionID));
		await observePrWorkflowAutoWakeEvent(directory, idleEvent(sessionID));
		expect(_test_exports.getPausePhase(directory, sessionID)).toBe('paused');

		// A second abort after the session is fully paused must restart the
		// awaiting-idle transition without ever reopening automatic wake.
		await observePrWorkflowAutoWakeEvent(directory, abortEvent(sessionID));
		const idleDecision = await observePrWorkflowAutoWakeEvent(
			directory,
			idleEvent(sessionID),
		);

		expect(idleDecision.suppressWake).toBe(true);
		expect(_test_exports.getPausePhase(directory, sessionID)).toBe('paused');
	});
});
