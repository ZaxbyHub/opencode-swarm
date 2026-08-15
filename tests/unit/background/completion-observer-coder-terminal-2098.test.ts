import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	type RecordPendingInput,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function pendingInput(
	directory: string,
	status: 'error' | 'cancelled',
): RecordPendingInput {
	const taskId = status === 'error' ? '1.1' : '1.2';
	return {
		correlationId: `child-${status}`,
		jobId: `job-${status}`,
		subagentSessionId: `child-${status}`,
		parentSessionId: 'parent',
		callID: `call-${status}`,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: taskId,
		evidenceTaskId: taskId,
		taskChangeContext: {
			declaredFiles: [`src/${status}.ts`],
			workflowGeneration: 0,
			baseline: {
				directory,
				gitHead: null,
				dirtyHash: null,
				changedFiles: [],
				prHeadSha: null,
				scope: taskId,
			},
		},
	};
}

function terminalEvent(status: 'error' | 'cancelled') {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: 'parent',
					text:
						`<task id="child-${status}" state="${status}">\n` +
						`<task_error>${status}</task_error>\n</task>`,
				},
			},
		},
	};
}

describe('issue #2098 background coder terminal retry accounting', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir(
			'bg-coder-terminal-2098-',
		));
		fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	for (const status of ['error', 'cancelled'] as const) {
		test(`${status} increments the exact task retry once and duplicate delivery is idempotent`, async () => {
			const input = pendingInput(directory, status);
			expect(await recordPendingDelegation(directory, input)).toMatchObject({
				status: 'pending',
				correlationId: input.correlationId,
			});
			const observer = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});

			await observer.event(terminalEvent(status));
			const first = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, input.planTaskId!),
			);
			expect(first).toMatchObject({
				generation: 0,
				retryCount: 1,
				lastOutcome: 'dispatch_no_mutation',
			});
			expect(findByCorrelationId(directory, input.correlationId)?.status).toBe(
				status,
			);

			await observer.event(terminalEvent(status));
			const replay = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, input.planTaskId!),
			);
			expect(replay).toEqual(first);
		});
	}
});
