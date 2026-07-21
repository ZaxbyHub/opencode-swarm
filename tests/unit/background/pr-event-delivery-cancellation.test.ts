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
import {
	_test_exports as autoWakeInternals,
	observePrWorkflowAutoWakeEvent,
} from '../../../src/hooks/pr-workflow-auto-wake.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';

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
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR monitor delivery after user interruption', () => {
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
