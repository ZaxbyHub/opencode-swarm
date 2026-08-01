import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import {
	type PrWorkflowGateState,
	_test_exports as workflowInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowResponseGate,
	_internals as responseGateInternals,
} from '../../../src/hooks/pr-workflow-response-gate.js';

let directory = '';
const originalClaim = responseGateInternals.claimPrFeedbackMonitorEvents;
const originalReadQueue = responseGateInternals.readPrFeedbackMonitorQueue;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-response-monitor-')),
	);
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	responseGateInternals.claimPrFeedbackMonitorEvents = originalClaim;
	responseGateInternals.readPrFeedbackMonitorQueue = originalReadQueue;
	await fs.rm(directory, { recursive: true, force: true });
});

async function writeState(
	sessionID: string,
	revision: number,
	extra: Partial<PrWorkflowGateState>,
): Promise<void> {
	const absolute = path.join(
		directory,
		'.swarm',
		workflowInternals.workflowGateStateRelativePath(sessionID),
	);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(
		absolute,
		JSON.stringify({
			schemaVersion: 1,
			revision,
			workflowInstanceId: 'test-instance',
			sessionID,
			mode: 'PR_FEEDBACK',
			activatedAt: '2026-08-01T00:00:00.000Z',
			updatedAt: '2026-08-01T00:00:00.000Z',
			...extra,
		}),
		'utf8',
	);
}

function queuedEvent() {
	return {
		type: 'pr.ci.failed',
		repoFullName: 'owner/repo',
		prNumber: 42,
		prUrl: 'https://github.com/owner/repo/pull/42',
		message: '[pr-monitor:pr.ci.failed:owner/repo#42] CI failed',
		dedupToken: '[pr-monitor:pr.ci.failed:owner/repo#42]',
		authorized: true,
		queuedAt: '2026-08-01T00:00:00.000Z',
	};
}

function stubQueue(sessionID: string): ReturnType<typeof queuedEvent> {
	const event = queuedEvent();
	responseGateInternals.readPrFeedbackMonitorQueue = mock(async () => ({
		schemaVersion: 1 as const,
		revision: 1,
		sessionID,
		events: [event],
	})) as typeof responseGateInternals.readPrFeedbackMonitorQueue;
	return event;
}

describe('PR workflow response gate monitor queue', () => {
	test('includes authorized queued monitor events in an accepted feedback wake', async () => {
		const sessionID = 'feedback-queued-session';
		const event = stubQueue(sessionID);
		responseGateInternals.claimPrFeedbackMonitorEvents = mock(async () => [
			{
				...event,
				claimedWorkflowInstanceId: 'feedback-instance',
				claimedAt: '2026-08-01T00:01:00.000Z',
			},
		]) as typeof responseGateInternals.claimPrFeedbackMonitorEvents;
		await writeState(sessionID, 0, {
			workflowInstanceId: 'feedback-instance',
			prFeedbackTargetUrl: event.prUrl,
		});
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});

		await gate.event({
			event: { type: 'session.idle', properties: { sessionID } },
		});

		expect(promptAsync).toHaveBeenCalledTimes(1);
		const prompt = JSON.stringify(promptAsync.mock.calls[0]?.[0]);
		expect(prompt).toContain('Queued PR monitor events are now authorized');
		expect(prompt).toContain('pr.ci.failed on owner/repo#42');
	});

	test('does not claim queued monitor events when the wake is rejected', async () => {
		const sessionID = 'feedback-rejected-session';
		const event = stubQueue(sessionID);
		const claim = mock(async () => []);
		responseGateInternals.claimPrFeedbackMonitorEvents = claim;
		await writeState(sessionID, 0, {
			workflowInstanceId: 'feedback-rejected-instance',
			prFeedbackTargetUrl: event.prUrl,
		});
		const promptAsync = mock(async () => ({ error: 'rejected' }));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});

		await gate
			.event({
				event: { type: 'session.idle', properties: { sessionID } },
			})
			.catch(() => undefined);
		expect(claim).not.toHaveBeenCalled();
	});

	test('does not claim events if feedback inventory becomes immutable during wake', async () => {
		const sessionID = 'feedback-race-session';
		const event = stubQueue(sessionID);
		const claim = mock(async () => []);
		responseGateInternals.claimPrFeedbackMonitorEvents = claim;
		await writeState(sessionID, 0, {
			workflowInstanceId: 'feedback-race-instance',
			prFeedbackTargetUrl: event.prUrl,
		});
		const promptAsync = mock(async () => {
			await writeState(sessionID, 1, {
				workflowInstanceId: 'feedback-race-instance',
				prFeedbackTargetUrl: event.prUrl,
				prFeedbackInventory: ['already-declared'],
			});
			return {};
		});
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});

		await gate.event({
			event: { type: 'session.idle', properties: { sessionID } },
		});
		expect(claim).not.toHaveBeenCalled();
	});

	test('shows recovery state but does not auto-resume it', async () => {
		const sessionID = 'recovery-session';
		await writeState(sessionID, 0, {
			mode: 'PR_REVIEW',
			checkoutRecovery: {
				code: 'GIT_OPERATION_IN_PROGRESS',
				retryable: false,
				requiredAction: 'Complete or abort the active Git operation manually.',
				evidence: {
					worktreeRoot: directory,
					gitDir: path.join(directory, '.git'),
					operations: ['merge'],
					unmergedCodes: [],
					paths: ['tracked.txt'],
					trackedCount: 1,
					untrackedCount: 0,
					pathsTruncated: false,
				},
				detectedAt: '2026-08-01T00:00:00.000Z',
			},
		});
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});

		await gate.event({
			event: { type: 'session.idle', properties: { sessionID } },
		});
		expect(promptAsync).not.toHaveBeenCalled();
		const output = { text: 'waiting for operator recovery' };
		await gate.textComplete({ sessionID }, output);
		expect(output.text).toContain('Manual Git recovery required');
	});
});
