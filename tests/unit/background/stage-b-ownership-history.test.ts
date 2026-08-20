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
	captureReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import { canonicalWorkspaceIdentity } from '../../../src/scope/scope-binding';
import {
	claimReviewerScopeGeneration,
	getReviewerScopeOwnershipHistory,
	markReviewerScopeGenerationReady,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	takeReviewerScopeGeneration,
} from '../../../src/state';

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

function baseline(): BackgroundWorkspaceSnapshot {
	writeFile('src/a.ts', 'export const a = 1;\n');
	writeFile('src/b.ts', 'export const b = 1;\n');
	git('add', 'src/a.ts', 'src/b.ts');
	git('commit', '-m', 'fixture');
	return captureWorkspaceSnapshot(directory);
}

function startCoder(
	taskId: string,
	callID: string,
	file: string,
	createdAt: number,
): void {
	expect(
		startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId,
			coderCallID: callID,
			background: true,
			declaredFiles: [file],
			captureDirectory: directory,
			workspaceIdentity: canonicalWorkspaceIdentity(directory) ?? 'ws:test',
			createdAt,
		}),
	).not.toBeNull();
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
	const value = captureReviewerScopeFileFingerprint(directory, file);
	expect(value?.kind).toBe('captured_file');
	expect(
		recordReviewerScopeGenerationFileFingerprint({
			parentSessionID: 'parent',
			taskId,
			coderCallID: callID,
			fingerprint: reviewerScopeCaptureToFingerprint(value)!,
		}),
	).toBe(true);
}

function consumeSibling(
	taskId: string,
	coderCallID: string,
	readyAt: number,
	consumedAt: number,
): void {
	expect(
		markReviewerScopeGenerationReady({
			parentSessionID: 'parent',
			taskId,
			coderCallID,
			readyAt,
		}),
	).toBe(true);
	expect(
		claimReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId,
			reviewerCallID: `reviewer-${coderCallID}`,
			now: readyAt,
		}),
	).not.toBeNull();
	expect(
		takeReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId,
			reviewerCallID: `reviewer-${coderCallID}`,
			now: consumedAt,
		}),
	).not.toBeNull();
}

function coderRecord(
	snapshot: BackgroundWorkspaceSnapshot,
	createdAt: number,
	completedAt: number,
): BackgroundDelegationRecord {
	return {
		schemaVersion: 2,
		correlationId: 'child-a',
		jobId: 'job-a',
		subagentSessionId: 'child-a',
		parentSessionId: 'parent',
		callID: 'coder-a',
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		status: 'completed',
		createdAt,
		updatedAt: completedAt,
		completedAt,
		taskChangeContext: {
			baseline: snapshot,
			declaredFiles: ['src/a.ts'],
		},
	};
}

async function ingest(
	record: BackgroundDelegationRecord,
): Promise<{ ok: boolean; consumed: boolean }> {
	return ingestBackgroundStageBCompletion({
		directory,
		record,
		result: {
			text: 'done',
			chars: 4,
			truncated: false,
			digest: 'digest',
		},
		reviewerReceiptOptions: {
			config: resolveAutoReviewConfig({ enabled: true }),
		},
	});
}

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'stage-b-owner-history-')),
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

describe('background attribution ownership history — regression: consumed sibling race (F-B1)', () => {
	test('accepts the delayed overlapping coder after its sibling reviewer consumes the live generation', async () => {
		// Previous code deleted sibling ownership with the reviewer generation, so
		// a valid delayed coder completion could no longer explain the sibling file.
		const snapshot = baseline();
		const now = Date.now() - 2_000;
		startCoder('1.1', 'coder-a', 'src/a.ts', now);
		startCoder('1.2', 'coder-b', 'src/b.ts', now + 100);
		writeFile('src/a.ts', 'export const a = 2;\n');
		writeFile('src/b.ts', 'export const b = 2;\n');
		fingerprint('1.1', 'coder-a', 'src/a.ts');
		fingerprint('1.2', 'coder-b', 'src/b.ts');
		consumeSibling('1.2', 'coder-b', now + 400, now + 500);

		expect(
			getReviewerScopeOwnershipHistory({ parentSessionID: 'parent' }),
		).toHaveLength(1);
		expect(await ingest(coderRecord(snapshot, now, now + 700))).toEqual({
			ok: true,
			consumed: true,
		});
	});

	test('rejects a non-overlapping historical owner', async () => {
		// A matching old fingerprint alone must not authorize a later direct edit.
		baseline();
		const now = Date.now() - 3_000;
		startCoder('1.2', 'coder-b', 'src/b.ts', now);
		writeFile('src/b.ts', 'export const b = 2;\n');
		fingerprint('1.2', 'coder-b', 'src/b.ts');
		consumeSibling('1.2', 'coder-b', now + 300, now + 400);
		git('add', 'src/b.ts');
		git('commit', '-m', 'historical owner change');
		writeFile('src/b.ts', 'export const b = 1;\n');
		git('add', 'src/b.ts');
		git('commit', '-m', 'later baseline');
		const snapshot = captureWorkspaceSnapshot(directory);
		startCoder('1.1', 'coder-a', 'src/a.ts', now + 1_500);
		writeFile('src/a.ts', 'export const a = 2;\n');
		writeFile('src/b.ts', 'export const b = 2;\n');
		fingerprint('1.1', 'coder-a', 'src/a.ts');

		expect(
			await ingest(coderRecord(snapshot, now + 1_500, now + 1_800)),
		).toMatchObject({
			ok: false,
			consumed: false,
		});
	});

	test('rejects a post-fingerprint direct edit even when timing overlaps', async () => {
		// Historical provenance is immutable; the current file must still match
		// the exact post-write fingerprint captured for the sibling.
		const snapshot = baseline();
		const now = Date.now() - 2_000;
		startCoder('1.1', 'coder-a', 'src/a.ts', now);
		startCoder('1.2', 'coder-b', 'src/b.ts', now + 100);
		writeFile('src/a.ts', 'export const a = 2;\n');
		writeFile('src/b.ts', 'export const b = 2;\n');
		fingerprint('1.1', 'coder-a', 'src/a.ts');
		fingerprint('1.2', 'coder-b', 'src/b.ts');
		consumeSibling('1.2', 'coder-b', now + 400, now + 500);
		writeFile('src/b.ts', 'export const b = 3;\n');

		expect(await ingest(coderRecord(snapshot, now, now + 700))).toMatchObject({
			ok: false,
			consumed: false,
		});
	});
});
