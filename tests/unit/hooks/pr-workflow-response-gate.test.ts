import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	clearPrWorkflowGateState,
	_test_exports as workflowInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { createPrWorkflowResponseGate } from '../../../src/hooks/pr-workflow-response-gate.js';

let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-response-gate-')),
	);
	workflowInternals.resetTrackedStateCache();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR workflow response-level gate', () => {
	test('replaces architect text until complete_pr_workflow clears durable state', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'review-session', 'PR_REVIEW');
		const blocked = { text: 'Looks good. APPROVE.' };
		await gate.textComplete({ sessionID: 'review-session' }, blocked);
		expect(blocked.text).toContain('FINAL RESPONSE BLOCKED');
		expect(blocked.text).not.toContain('Looks good');

		await clearPrWorkflowGateState(directory, 'review-session');
		const completed = { text: 'Verified completion.' };
		await gate.textComplete({ sessionID: 'review-session' }, completed);
		expect(completed.text).toBe('Verified completion.');
	});

	test('session idle mechanically resumes an active workflow', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'feedback-session', 'PR_FEEDBACK');
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'feedback-session' },
			},
		});
		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
			path: { id: 'feedback-session' },
		});
		expect(JSON.stringify(promptAsync.mock.calls[0]?.[0])).toContain(
			'Do not stop or summarize',
		);
	});

	test('does not rewrite or wake sessions without an active gate', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		const output = { text: 'ordinary response' };
		await gate.textComplete({ sessionID: 'ordinary-session' }, output);
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'ordinary-session' },
			},
		});
		expect(output.text).toBe('ordinary response');
		expect(promptAsync).not.toHaveBeenCalled();
	});

	test('keeps text enforcement but skips resume when the host has no session API', async () => {
		const gate = createPrWorkflowResponseGate({ directory });
		await activatePrWorkflow(directory, 'limited-host-session', 'PR_REVIEW');
		const output = { text: 'ordinary response' };
		await gate.textComplete({ sessionID: 'limited-host-session' }, output);
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'limited-host-session' },
			},
		});
		expect(output.text).toContain('FINAL RESPONSE BLOCKED');
	});
});
