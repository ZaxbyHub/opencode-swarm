import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OpencodeClient } from '@opencode-ai/sdk';
import {
	activatePrWorkflow,
	readPrWorkflowGateState,
	transitionPrReviewToFeedback,
} from '../../../../src/hooks/pr-workflow-gate.js';
import { createV2SessionClient } from '../../../../src/host/v2/session-client.js';
import type { V2PluginContext } from '../../../../src/host/v2/types.js';
import { swarmState } from '../../../../src/state.js';
import {
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../../hooks/pr-workflow-gate.test-fixtures.js';

const modeNames = ['PR_REVIEW', 'PR_FEEDBACK'] as const;
const unusedHostOperation = async () => {};
let previousClient: typeof swarmState.opencodeClient;

function makeV2Client(): OpencodeClient {
	const client = createV2SessionClient({
		session: {
			create: unusedHostOperation,
			get: unusedHostOperation,
			remove: unusedHostOperation,
			prompt: unusedHostOperation,
			wait: unusedHostOperation,
			context: unusedHostOperation,
			interrupt: unusedHostOperation,
			hook: unusedHostOperation,
		},
	} as unknown as V2PluginContext);
	if (!client) throw new Error('Fixture could not create the v2 session shim');
	return client;
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	previousClient = swarmState.opencodeClient;
});

afterEach(async () => {
	swarmState.opencodeClient = previousClient;
	await teardownPrWorkflowGateFixtures();
});

describe('PR workflow activation on OpenCode v2', () => {
	test.each(modeNames)('refuses %s before publishing a gate', async (mode) => {
		swarmState.opencodeClient = makeV2Client();

		await expect(activatePrWorkflow(tempDir, SESSION_ID, mode)).rejects.toThrow(
			`BLOCKED: ${mode} cannot activate on OpenCode v2. Missing host capabilities: promptAsync, messages, status.`,
		);
		await expect(
			readPrWorkflowGateState(tempDir, SESSION_ID),
		).resolves.toBeNull();
	});

	test('reports only the operations actually missing from the shim', async () => {
		const client = makeV2Client();
		Object.assign(client.session, { promptAsync: unusedHostOperation });
		swarmState.opencodeClient = client;

		await expect(
			activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW'),
		).rejects.toThrow('Missing host capabilities: messages, status.');
	});

	test('also refuses the feedback continuation before reading a handoff', async () => {
		swarmState.opencodeClient = makeV2Client();

		await expect(
			transitionPrReviewToFeedback(tempDir, SESSION_ID, {
				runId: 'run-123',
				handoffPath: 'missing.json',
			}),
		).rejects.toThrow('PR_FEEDBACK cannot activate on OpenCode v2');
		await expect(
			readPrWorkflowGateState(tempDir, SESSION_ID),
		).resolves.toBeNull();
	});

	test.each(
		modeNames,
	)('preserves %s on a capable legacy client', async (mode) => {
		swarmState.opencodeClient = {
			session: {
				promptAsync: unusedHostOperation,
				messages: unusedHostOperation,
				status: unusedHostOperation,
			},
		} as unknown as OpencodeClient;
		await expect(
			activatePrWorkflow(tempDir, SESSION_ID, mode),
		).resolves.toMatchObject({ mode, sessionID: SESSION_ID });
	});

	test('preserves legacy activation when async capabilities are absent', async () => {
		swarmState.opencodeClient = { session: {} } as unknown as OpencodeClient;
		await expect(
			activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW', sessionID: SESSION_ID });
	});

	test('permits activation if the tagged shim becomes capable', async () => {
		const client = makeV2Client();
		Object.assign(client.session, {
			promptAsync: unusedHostOperation,
			messages: unusedHostOperation,
			status: unusedHostOperation,
		});
		swarmState.opencodeClient = client;
		await expect(
			activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW', sessionID: SESSION_ID });
	});
});
