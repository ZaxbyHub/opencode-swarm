import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	BackgroundDelegationRecord,
	BackgroundWorkspaceSnapshot,
} from '../../../src/background/pending-delegations';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	getReviewerScopeGenerationForCoderCall,
	markReviewerScopeGenerationNoChange,
	recordReviewerScopeGenerationFile,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
} from '../../../src/state';

let directory = '';

function git(...args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

function terminalResult(output = 'done') {
	return {
		status: 'completed' as const,
		output,
		metadata: {},
	};
}

function coderRecord(input: {
	taskId: string;
	callID: string;
	baseline: BackgroundWorkspaceSnapshot;
	declaredFiles: string[];
}): BackgroundDelegationRecord {
	const completedAt = Date.now();
	return {
		schemaVersion: 2,
		correlationId: `child-${input.callID}`,
		jobId: `job-${input.callID}`,
		subagentSessionId: `child-${input.callID}`,
		parentSessionId: 'parent',
		callID: input.callID,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: input.taskId,
		evidenceTaskId: input.taskId,
		status: 'completed',
		createdAt: completedAt - 60_000,
		updatedAt: completedAt,
		completedAt,
		taskChangeContext: {
			baseline: input.baseline,
			declaredFiles: input.declaredFiles,
		},
	};
}

async function ingest(record: BackgroundDelegationRecord) {
	return ingestBackgroundStageBCompletion({
		directory,
		record,
		result: terminalResult(),
		reviewerReceiptOptions: {
			config: resolveAutoReviewConfig({ enabled: true }),
		},
	});
}

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'stage-b-nochange-')),
	);
	git('init');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	fs.appendFileSync(path.join(directory, '.git/info/exclude'), '\n.swarm/\n');
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(path.join(directory, 'src/a.ts'), 'export const a = 1;\n');
	git('add', 'src/a.ts');
	git('commit', '-m', 'fixture');
	startAgentSession('parent', 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('background Stage-B no-change and typed capture reasons (issue #2100)', () => {
	test('a zero-observed-file background coder completes as no_change, not attribution failure', async () => {
		const baseline = captureWorkspaceSnapshot(directory);
		expect(
			startReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-nochange',
				background: true,
				declaredFiles: ['src/a.ts'],
				captureDirectory: directory,
				workspaceIdentity: 'ws:/stage-b-nochange',
			}),
		).not.toBeNull();
		const result = await ingest(
			coderRecord({
				taskId: '1.1',
				callID: 'coder-nochange',
				baseline,
				declaredFiles: ['src/a.ts'],
			}),
		);
		expect(result).toMatchObject({ ok: true, consumed: true });
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-nochange',
			})?.status,
		).toBe('no_change');
	});

	test('a permanent capture failure returns a typed non-retryable reason with a code', async () => {
		const baseline = captureWorkspaceSnapshot(directory);
		// The declared path becomes a directory in the workspace: capture fails
		// closed as non_regular (permanent), distinguishable from transient.
		fs.rmSync(path.join(directory, 'src/a.ts'));
		fs.mkdirSync(path.join(directory, 'src/a.ts'));
		const changed = captureWorkspaceSnapshot(directory);
		void changed;
		// The observed set must include the now-directory path.
		const record = coderRecord({
			taskId: '1.2',
			callID: 'coder-perm',
			baseline,
			declaredFiles: ['src/a.ts'],
		});
		record.taskChangeContext = {
			baseline,
			declaredFiles: ['src/a.ts'],
		};
		expect(
			startReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '1.2',
				coderCallID: 'coder-perm',
				background: true,
				declaredFiles: ['src/a.ts'],
				captureDirectory: directory,
				workspaceIdentity: 'ws:/stage-b-nochange',
			}),
		).not.toBeNull();
		// Route nothing; observed files come from the baseline diff.
		const result = await ingest(record);
		expect(result.ok).toBe(false);
		expect(result.code).toBe('capture_failed:non_regular');
		expect(result.retryable).toBe(false);
		expect(result.reason).toContain('non_regular');
	});

	test('markReviewerScopeGenerationNoChange refuses generations with routed files', () => {
		expect(
			startReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '1.3',
				coderCallID: 'coder-routed',
				background: true,
				declaredFiles: ['src/a.ts'],
				captureDirectory: directory,
				workspaceIdentity: 'ws:/stage-b-nochange',
			}),
		).not.toBeNull();
		const { recordReviewerScopeGenerationFile: routeFile } = {
			recordReviewerScopeGenerationFile,
		};
		expect(
			routeFile({
				parentSessionID: 'parent',
				taskId: '1.3',
				coderCallID: 'coder-routed',
				file: 'src/a.ts',
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationNoChange({
				parentSessionID: 'parent',
				taskId: '1.3',
				coderCallID: 'coder-routed',
			}),
		).toBe(false);
	});
});
