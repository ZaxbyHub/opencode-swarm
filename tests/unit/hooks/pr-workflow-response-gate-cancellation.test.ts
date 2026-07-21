import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports as autoWakeInternals,
	isPrWorkflowAutoWakeSuppressed,
} from '../../../src/hooks/pr-workflow-auto-wake.js';
import {
	activatePrWorkflow,
	clearPrWorkflowGateState,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { createPrWorkflowResponseGate } from '../../../src/hooks/pr-workflow-response-gate.js';

let directory = '';

beforeEach(() => {
	directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pr-cancel-')));
	gateInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

function idle(sessionID: string) {
	return { event: { type: 'session.idle', properties: { sessionID } } };
}

describe('PR workflow user interruption', () => {
	test('MessageAbortedError followed by idle never re-wakes the parent', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'cancelled-parent', 'PR_REVIEW');

		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'cancelled-parent',
					error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
				},
			},
		});
		await gate.event(idle('cancelled-parent'));

		expect(promptAsync).not.toHaveBeenCalled();
		expect(isPrWorkflowAutoWakeSuppressed(directory, 'cancelled-parent')).toBe(
			true,
		);
		const output = { text: 'stopped' };
		await gate.textComplete({ sessionID: 'cancelled-parent' }, output);
		expect(output.text).toContain('user interruption');
	});

	test('supports assistant message.updated and data envelopes', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'data-parent', 'PR_FEEDBACK');
		await gate.event({
			event: {
				type: 'message.updated',
				data: {
					info: {
						role: 'assistant',
						sessionID: 'data-parent',
						error: { name: 'MessageAbortedError' },
					},
				},
			},
		});
		await gate.event({
			event: { type: 'session.idle', data: { sessionID: 'data-parent' } },
		});
		expect(promptAsync).not.toHaveBeenCalled();
	});

	test('a later explicit user turn resumes only after its idle boundary', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'resume-parent', 'PR_REVIEW');
		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'resume-parent',
					error: { name: 'MessageAbortedError' },
				},
			},
		});
		await gate.event(idle('resume-parent'));
		await gate.event({
			event: {
				type: 'message.updated',
				properties: { info: { role: 'user', sessionID: 'resume-parent' } },
			},
		});
		await gate.event(idle('resume-parent'));
		expect(promptAsync).not.toHaveBeenCalled();
		expect(isPrWorkflowAutoWakeSuppressed(directory, 'resume-parent')).toBe(
			false,
		);

		await gate.event(idle('resume-parent'));
		expect(promptAsync).toHaveBeenCalledTimes(1);
	});

	test('unrelated errors and child aborts do not pause the gated parent', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'live-parent', 'PR_REVIEW');
		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'child-lane',
					error: { name: 'MessageAbortedError' },
				},
			},
		});
		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'live-parent',
					error: { name: 'UnknownError' },
				},
			},
		});
		await gate.event(idle('live-parent'));
		expect(promptAsync).toHaveBeenCalledTimes(1);
	});

	test('distinguishes a synthetic wake from the first real post-interrupt user turn', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'synthetic-parent', 'PR_REVIEW');

		// The first idle creates a plugin-authored prompt and a marker that must
		// outlive promptAsync acceptance until its user-role event is consumed.
		await gate.event(idle('synthetic-parent'));
		const syntheticMessageID = (
			promptAsync.mock.calls[0]?.[0] as {
				body?: { messageID?: string };
			}
		)?.body?.messageID;
		expect(syntheticMessageID).toMatch(/^msg_swarm_wake_/);
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(directory, 'synthetic-parent'),
		).toBe(1);
		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'synthetic-parent',
					error: { name: 'MessageAbortedError' },
				},
			},
		});
		await gate.event(idle('synthetic-parent'));

		await gate.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						id: syntheticMessageID,
						role: 'user',
						sessionID: 'synthetic-parent',
					},
				},
			},
		});
		expect(autoWakeInternals.getPausePhase(directory, 'synthetic-parent')).toBe(
			'paused',
		);

		await gate.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						id: 'msg_real_user_turn',
						role: 'user',
						sessionID: 'synthetic-parent',
					},
				},
			},
		});
		expect(autoWakeInternals.getPausePhase(directory, 'synthetic-parent')).toBe(
			'resuming',
		);
		await gate.event(idle('synthetic-parent'));
		expect(promptAsync).toHaveBeenCalledTimes(1);
	});

	test('accepts a real user turn that races the first post-abort idle event', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'race-parent', 'PR_REVIEW');

		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'race-parent',
					error: { name: 'MessageAbortedError' },
				},
			},
		});
		await gate.event({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						id: 'msg_real_racing_turn',
						role: 'user',
						sessionID: 'race-parent',
					},
				},
			},
		});
		expect(autoWakeInternals.getPausePhase(directory, 'race-parent')).toBe(
			'resuming',
		);

		await gate.event(idle('race-parent'));
		expect(isPrWorkflowAutoWakeSuppressed(directory, 'race-parent')).toBe(
			false,
		);
		expect(promptAsync).not.toHaveBeenCalled();
	});

	test('clears interruption state when the durable workflow gate is removed', async () => {
		const gate = createPrWorkflowResponseGate({ directory });
		await activatePrWorkflow(directory, 'cleared-parent', 'PR_REVIEW');
		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'cleared-parent',
					error: { name: 'MessageAbortedError' },
				},
			},
		});
		await clearPrWorkflowGateState(directory, 'cleared-parent');
		await gate.event(idle('cleared-parent'));
		expect(isPrWorkflowAutoWakeSuppressed(directory, 'cleared-parent')).toBe(
			false,
		);
	});
});
