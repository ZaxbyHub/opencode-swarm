import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrWorkflowHead,
	enforcePrWorkflowDispatchLanesAsync,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('pr-workflow-gate lifecycle', () => {
	test('activatePrWorkflow persists recoverable session-keyed state', async () => {
		const activated = await activatePrWorkflow(
			tempDir,
			SESSION_ID,
			'PR_REVIEW',
		);

		expect(activated.mode).toBe('PR_REVIEW');

		_test_exports.resetTrackedStateCache();
		const recovered = await readPrWorkflowGateState(tempDir, SESSION_ID);

		expect(recovered).not.toBeNull();
		expect(recovered?.sessionID).toBe(SESSION_ID);
		expect(recovered?.mode).toBe('PR_REVIEW');

		const relativePath =
			_test_exports.workflowGateStateRelativePath(SESSION_ID);
		const onDisk = JSON.parse(
			await fs.readFile(path.join(tempDir, '.swarm', relativePath), 'utf-8'),
		) as { sessionID: string; mode: string };
		expect(onDisk.sessionID).toBe(SESSION_ID);
		expect(onDisk.mode).toBe('PR_REVIEW');
	});

	test('cache is isolated by canonical project directory and session id', async () => {
		const secondDir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-gate-second-')),
		);
		try {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			await activatePrWorkflow(secondDir, SESSION_ID, 'PR_FEEDBACK');
			expect((await readPrWorkflowGateState(tempDir, SESSION_ID))?.mode).toBe(
				'PR_REVIEW',
			);
			expect((await readPrWorkflowGateState(secondDir, SESSION_ID))?.mode).toBe(
				'PR_FEEDBACK',
			);
		} finally {
			closeProjectDb(secondDir);
			await fs.rm(secondDir, { recursive: true, force: true });
		}
	});

	test('bindPrWorkflowHead is immutable and same-value idempotent', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		await bindPrWorkflowHead(tempDir, SESSION_ID, HEAD_SHA);
		await expect(
			bindPrWorkflowHead(tempDir, SESSION_ID, HEAD_SHA),
		).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
		await expect(
			bindPrWorkflowHead(tempDir, SESSION_ID, 'changed-head'),
		).rejects.toThrow('does not match PR head');
	});

	test('bindPrWorkflowHead rejects dirty and indeterminate working trees', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		for (const cleanState of [false, null] as const) {
			_test_exports.resolveIsWorkingTreeClean = () => cleanState;
			await expect(
				bindPrWorkflowHead(tempDir, SESSION_ID, HEAD_SHA),
			).rejects.toThrow('requires a clean index and working tree');
		}
	});

	test('enforcePrWorkflowDispatchLanesAsync blocks blocking dispatch for active review and feedback workflows', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		await expect(
			enforcePrWorkflowDispatchLanesAsync(
				tempDir,
				SESSION_ID,
				'dispatch_lanes',
			),
		).rejects.toThrow('requires dispatch_lanes_async');

		const feedbackSession = `${SESSION_ID}-feedback`;
		await activatePrWorkflow(tempDir, feedbackSession, 'PR_FEEDBACK');
		await expect(
			enforcePrWorkflowDispatchLanesAsync(
				tempDir,
				feedbackSession,
				'dispatch_lanes',
			),
		).rejects.toThrow('requires dispatch_lanes_async');

		await expect(
			enforcePrWorkflowDispatchLanesAsync(
				tempDir,
				feedbackSession,
				'dispatch_lanes_async',
			),
		).resolves.toMatchObject({ mode: 'PR_FEEDBACK' });
	});
});
