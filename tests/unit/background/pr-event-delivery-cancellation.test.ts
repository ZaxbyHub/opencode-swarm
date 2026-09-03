import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	deliverPrActivity,
	type FormattedPrEvent,
	noteSessionIdle,
	registerPrEventDelivery,
	unregisterPrEventDelivery,
} from '../../../src/background/pr-event-delivery.js';
import type { PrMonitorConfig } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports as autoWakeInternals,
	observePrWorkflowAutoWakeEvent,
} from '../../../src/hooks/pr-workflow-auto-wake.js';
import {
	activatePrWorkflow,
	clearPrWorkflowGateState,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { createPrWorkflowResponseGate } from '../../../src/hooks/pr-workflow-response-gate.js';

let directory = '';
let savedSendWakePrompt: typeof _internals.sendWakePrompt;

const event: FormattedPrEvent = {
	type: 'pr.ci.failed',
	repoFullName: 'owner/repo',
	prNumber: 42,
	prUrl: 'https://github.com/owner/repo/pull/42',
	message: '[pr-monitor:pr.ci.failed:owner/repo#42] failed',
	dedupToken: '[pr-monitor:pr.ci.failed:owner/repo#42]',
};

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-monitor-cancel-')),
	);
	savedSendWakePrompt = _internals.sendWakePrompt;
	gateInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	unregisterPrEventDelivery();
});

afterEach(async () => {
	_internals.sendWakePrompt = savedSendWakePrompt;
	unregisterPrEventDelivery();
	gateInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR monitor delivery after user interruption', () => {
	test('retains an uncertain wake marker until a late host event consumes it (F-001)', async () => {
		let lateMessageID = '';
		_internals.sendWakePrompt = mock(async (_sessionID, _events, messageID) => {
			lateMessageID = messageID;
			return false;
		});
		registerPrEventDelivery({
			client: { session: {} } as never,
			directory,
			config: { enabled: true, event_delivery: 'prompt' } as PrMonitorConfig,
		});
		await activatePrWorkflow(directory, 'late-monitor', 'PR_REVIEW');

		// Previous code canceled the marker for every false transport result.
		// A timeout does not abort promptAsync, so its accepted user event can
		// still arrive later with this exact caller-supplied message ID.
		expect(await deliverPrActivity('late-monitor', [event])).toBe(false);
		expect(lateMessageID).toMatch(/^msg_swarm_wake_/);
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(directory, 'late-monitor'),
		).toBe(1);

		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'session.error',
			properties: {
				sessionID: 'late-monitor',
				error: { name: 'MessageAbortedError' },
			},
		});
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'session.idle',
			properties: { sessionID: 'late-monitor' },
		});
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'message.updated',
			properties: {
				info: {
					id: lateMessageID,
					role: 'user',
					sessionID: 'late-monitor',
				},
			},
		});

		expect(autoWakeInternals.getPausePhase(directory, 'late-monitor')).toBe(
			'paused',
		);
	});

	test('retains an uncertain marker across sequential workflows in one session (F-001)', async () => {
		const sessionID = 'sequential-timeout-monitor';
		let lateMessageID = '';
		_internals.sendWakePrompt = mock(async (_sessionID, _events, messageID) => {
			lateMessageID = messageID;
			return false;
		});
		registerPrEventDelivery({
			client: { session: {} } as never,
			directory,
			config: { enabled: true, event_delivery: 'prompt' } as PrMonitorConfig,
		});
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		expect(await deliverPrActivity(sessionID, [event])).toBe(false);

		// Ordinary gate cleanup must clear the pause without discarding an
		// unabortable prompt's marker. The old host call may still be accepted
		// after a new workflow starts in this same session.
		await clearPrWorkflowGateState(directory, sessionID);
		await createPrWorkflowResponseGate({ directory }).event({
			event: { type: 'session.idle', properties: { sessionID } },
		});
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(directory, sessionID),
		).toBe(1);

		await activatePrWorkflow(directory, sessionID, 'PR_FEEDBACK');
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'session.error',
			properties: {
				sessionID,
				error: { name: 'MessageAbortedError' },
			},
		});
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'session.idle',
			properties: { sessionID },
		});
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'message.updated',
			properties: {
				info: { id: lateMessageID, role: 'user', sessionID },
			},
		});

		expect(autoWakeInternals.getPausePhase(directory, sessionID)).toBe(
			'paused',
		);
		expect(
			autoWakeInternals.getPluginWakeMarkerCount(directory, sessionID),
		).toBe(0);
	});

	test('queues immediate and idle wake paths until a later user turn settles', async () => {
		const sendWakePrompt = mock(async () => true);
		_internals.sendWakePrompt = sendWakePrompt;
		registerPrEventDelivery({
			client: { session: {} } as never,
			directory,
			config: { enabled: true, event_delivery: 'prompt' } as PrMonitorConfig,
		});
		await activatePrWorkflow(directory, 'cancelled-monitor', 'PR_REVIEW');
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'session.error',
			properties: {
				sessionID: 'cancelled-monitor',
				error: { name: 'MessageAbortedError' },
			},
		});
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'session.idle',
			properties: { sessionID: 'cancelled-monitor' },
		});

		expect(await deliverPrActivity('cancelled-monitor', [event])).toBe(true);
		noteSessionIdle('cancelled-monitor');
		await Promise.resolve();
		expect(sendWakePrompt).not.toHaveBeenCalled();

		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'message.updated',
			properties: {
				info: { role: 'user', sessionID: 'cancelled-monitor' },
			},
		});
		await observePrWorkflowAutoWakeEvent(directory, {
			type: 'session.idle',
			properties: { sessionID: 'cancelled-monitor' },
		});
		noteSessionIdle('cancelled-monitor');
		await Promise.resolve();
		await Promise.resolve();
		expect(sendWakePrompt).toHaveBeenCalledTimes(1);
	});
});
