import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	BackgroundDelegationRecord,
	BackgroundDelegationResult,
	BackgroundWorkspaceSnapshot,
} from '../../../src/background/pending-delegations';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	captureReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import {
	getReviewerScopeGenerationForCoderCall,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
} from '../../../src/state';

const terminalResult: BackgroundDelegationResult = {
	text: 'done',
	chars: 4,
	truncated: false,
	digest: 'result-digest',
};

let directory = '';

function git(...args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		stdio: 'ignore',
		timeout: 5_000,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

function writeFile(file: string, content: string): void {
	const absolute = path.join(directory, file);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content);
}

function baseline(files: string[]): BackgroundWorkspaceSnapshot {
	for (const file of files)
		writeFile(file, `export const ${path.basename(file, '.ts')} = 1;\n`);
	git('add', ...files);
	git('commit', '-m', 'fixture');
	return captureWorkspaceSnapshot(directory);
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

function startCoder(taskId: string, callID: string, files: string[]): void {
	expect(
		startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId,
			coderCallID: callID,
			background: true,
			declaredFiles: files,
			captureDirectory: directory,
			workspaceIdentity: 'ws:/stage-b-attribution',
		}),
	).not.toBeNull();
}

function route(taskId: string, callID: string, file: string): void {
	expect(
		recordReviewerScopeGenerationFile({
			parentSessionID: 'parent',
			taskId,
			coderCallID: callID,
			file,
		}),
	).toBe(true);
}

function fingerprint(taskId: string, callID: string, file: string): void {
	const captured = captureReviewerScopeFileFingerprint(directory, file);
	expect(captured?.kind).toBe('captured_file');
	const converted = reviewerScopeCaptureToFingerprint(captured);
	expect(converted).not.toBeNull();
	expect(
		recordReviewerScopeGenerationFileFingerprint({
			parentSessionID: 'parent',
			taskId,
			coderCallID: callID,
			fingerprint: converted!,
		}),
	).toBe(true);
}

async function ingest(record: BackgroundDelegationRecord) {
	return ingestBackgroundStageBCompletion({
		directory,
		record,
		result: terminalResult,
		reviewerReceiptOptions: {
			config: resolveAutoReviewConfig({ enabled: true }),
		},
	});
}

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'stage-b-coder-attribution-')),
	);
	git('init');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	fs.appendFileSync(
		path.join(directory, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
	);
	startAgentSession('parent', 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('background coder Stage-B attribution', () => {
	test('keeps the generation collecting when evidence fails and completes on replay', async () => {
		const snapshot = baseline(['src/a.ts']);
		startCoder('1.1', 'coder-retry', ['src/a.ts']);
		route('1.1', 'coder-retry', 'src/a.ts');
		writeFile('src/a.ts', 'export const a = 2;\n');
		fingerprint('1.1', 'coder-retry', 'src/a.ts');
		const evidencePath = path.join(directory, '.swarm', 'evidence', '1.1.json');
		fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
		fs.writeFileSync(evidencePath, '{invalid');
		const record = coderRecord({
			taskId: '1.1',
			callID: 'coder-retry',
			baseline: snapshot,
			declaredFiles: ['src/a.ts'],
		});

		expect(await ingest(record)).toMatchObject({ ok: false, consumed: false });
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-retry',
			})?.status,
		).toBe('collecting');

		fs.unlinkSync(evidencePath);
		expect(await ingest(record)).toEqual({ ok: true, consumed: true });
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-retry',
			})?.status,
		).toBe('ready');
	});

	test('replays an identical successful coder ingestion idempotently', async () => {
		// A crash can leave the durable lease unsettled after evidence and ready
		// state were applied; replaying that immutable scope must remain a success.
		const snapshot = baseline(['src/a.ts']);
		startCoder('1.2', 'coder-crash-replay', ['src/a.ts']);
		route('1.2', 'coder-crash-replay', 'src/a.ts');
		writeFile('src/a.ts', 'export const a = 2;\n');
		fingerprint('1.2', 'coder-crash-replay', 'src/a.ts');
		const record = coderRecord({
			taskId: '1.2',
			callID: 'coder-crash-replay',
			baseline: snapshot,
			declaredFiles: ['src/a.ts'],
		});

		expect(await ingest(record)).toEqual({ ok: true, consumed: true });
		expect(await ingest(record)).toEqual({ ok: true, consumed: true });
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-crash-replay',
			})?.status,
		).toBe('ready');
	});

	test('attributes only A while an independently declared B changes in parallel', async () => {
		const snapshot = baseline(['src/a.ts', 'src/b.ts']);
		startCoder('2.1', 'coder-a', ['src/a.ts']);
		startCoder('2.2', 'coder-b', ['src/b.ts']);
		route('2.1', 'coder-a', 'src/a.ts');
		route('2.2', 'coder-b', 'src/b.ts');
		writeFile('src/a.ts', 'export const a = 2;\n');
		writeFile('src/b.ts', 'export const b = 2;\n');
		fingerprint('2.1', 'coder-a', 'src/a.ts');
		fingerprint('2.2', 'coder-b', 'src/b.ts');

		expect(
			await ingest(
				coderRecord({
					taskId: '2.1',
					callID: 'coder-a',
					baseline: snapshot,
					declaredFiles: ['src/a.ts'],
				}),
			),
		).toEqual({ ok: true, consumed: true });
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-a',
			})?.modifiedFiles,
		).toEqual(['src/a.ts']);
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-b',
			}),
		).toMatchObject({ status: 'collecting', modifiedFiles: ['src/b.ts'] });
	});

	test('fails closed when a declared changed path was not child-routed', async () => {
		const snapshot = baseline(['src/a.ts', 'src/c.ts']);
		startCoder('3.1', 'coder-direct', ['src/a.ts', 'src/c.ts']);
		route('3.1', 'coder-direct', 'src/a.ts');
		writeFile('src/a.ts', 'export const a = 2;\n');
		writeFile('src/c.ts', 'export const c = 2;\n');
		fingerprint('3.1', 'coder-direct', 'src/a.ts');

		expect(
			await ingest(
				coderRecord({
					taskId: '3.1',
					callID: 'coder-direct',
					baseline: snapshot,
					declaredFiles: ['src/a.ts', 'src/c.ts'],
				}),
			),
		).toMatchObject({ ok: false, consumed: false });
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-direct',
			})?.status,
		).toBe('collecting');
	});

	test('fails closed when an observed external path has no sibling owner', async () => {
		const snapshot = baseline(['src/a.ts', 'src/direct.ts']);
		startCoder('3.2', 'coder-unowned', ['src/a.ts']);
		route('3.2', 'coder-unowned', 'src/a.ts');
		writeFile('src/a.ts', 'export const a = 2;\n');
		writeFile('src/direct.ts', 'export const direct = 2;\n');
		fingerprint('3.2', 'coder-unowned', 'src/a.ts');

		expect(
			await ingest(
				coderRecord({
					taskId: '3.2',
					callID: 'coder-unowned',
					baseline: snapshot,
					declaredFiles: ['src/a.ts'],
				}),
			),
		).toMatchObject({ ok: false, consumed: false });
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-unowned',
			})?.status,
		).toBe('collecting');
	});

	test('fails closed for overlapping concurrent declarations', async () => {
		const snapshot = baseline(['src/a.ts']);
		startCoder('4.1', 'coder-overlap-a', ['src/a.ts']);
		startCoder('4.2', 'coder-overlap-b', ['src/a.ts']);
		route('4.1', 'coder-overlap-a', 'src/a.ts');
		writeFile('src/a.ts', 'export const a = 2;\n');
		fingerprint('4.1', 'coder-overlap-a', 'src/a.ts');

		expect(
			await ingest(
				coderRecord({
					taskId: '4.1',
					callID: 'coder-overlap-a',
					baseline: snapshot,
					declaredFiles: ['src/a.ts'],
				}),
			),
		).toMatchObject({ ok: false, consumed: false });
	});

	test('rejects a failed or no-op sibling route followed by a direct write', async () => {
		const snapshot = baseline(['src/a.ts', 'src/b.ts']);
		startCoder('5.1', 'coder-a', ['src/a.ts']);
		startCoder('5.2', 'coder-b', ['src/b.ts']);
		route('5.1', 'coder-a', 'src/a.ts');
		route('5.2', 'coder-b', 'src/b.ts');
		writeFile('src/a.ts', 'export const a = 2;\n');
		fingerprint('5.1', 'coder-a', 'src/a.ts');
		writeFile('src/b.ts', 'export const b = 2;\n');

		expect(
			await ingest(
				coderRecord({
					taskId: '5.1',
					callID: 'coder-a',
					baseline: snapshot,
					declaredFiles: ['src/a.ts'],
				}),
			),
		).toMatchObject({ ok: false, consumed: false });
	});

	test('rejects a direct mutation after a valid sibling fingerprint', async () => {
		const snapshot = baseline(['src/a.ts', 'src/b.ts']);
		startCoder('6.1', 'coder-a', ['src/a.ts']);
		startCoder('6.2', 'coder-b', ['src/b.ts']);
		route('6.1', 'coder-a', 'src/a.ts');
		route('6.2', 'coder-b', 'src/b.ts');
		writeFile('src/a.ts', 'export const a = 2;\n');
		writeFile('src/b.ts', 'export const b = 2;\n');
		fingerprint('6.1', 'coder-a', 'src/a.ts');
		fingerprint('6.2', 'coder-b', 'src/b.ts');
		writeFile('src/b.ts', 'export const b = 3;\n');

		expect(
			await ingest(
				coderRecord({
					taskId: '6.1',
					callID: 'coder-a',
					baseline: snapshot,
					declaredFiles: ['src/a.ts'],
				}),
			),
		).toMatchObject({ ok: false, consumed: false });
	});
});
