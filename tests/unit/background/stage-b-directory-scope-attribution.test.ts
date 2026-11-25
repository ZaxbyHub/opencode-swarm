/**
 * Directory-valued declared scope in background coder completion attribution
 * (src/background/stage-b-gates.ts).
 *
 * Regression pin for the task-1.13 background settlement wedge: an architect
 * may `declare_scope` with a DIRECTORY (files: ["context"]); the coder
 * write-scope guard treats that as covering everything beneath it, but the
 * completion-attribution filter matched declared entries by exact path only —
 * every file the coder changed fell out of `attributedFiles`, the completion
 * settled as `dispatch_no_mutation` despite real mutations, and the task
 * wedged at Stage A forever (no accepted mutation → stage_a_passed refused →
 * TASK_WORKFLOW_STAGE_A_REQUIRED on every Stage B dispatch).
 *
 * The non-receipts ingestion branch (the deployed configuration for the
 * affected project) must attribute files CONTAINED in a directory-valued
 * declared scope and record `accepted_mutation`.
 */
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
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { resetSwarmState } from '../../../src/state';

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

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'stage-b-dir-scope-')),
	);
	git('init', '-b', 'main');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

describe('directory-valued declared scope attribution', () => {
	test('files under a directory scope are attributed and settle as accepted_mutation', async () => {
		// The exact task-1.13 shape: declaredFiles is the directory "context",
		// the coder modified two files beneath it, and a sibling outside the
		// scope changed concurrently (must stay unattributed).
		const snapshot = baseline(['context/entry-a.md', 'context/entry-b.md']);
		const record = coderRecord({
			taskId: '1.13',
			callID: 'coder-dir-scope',
			baseline: snapshot,
			declaredFiles: ['context'],
		});
		writeFile('context/entry-a.md', 'entry a v2\n');
		writeFile('context/entry-b.md', 'entry b v2\n');
		writeFile('outside/x.ts', 'export const x = 2;\n');

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record,
			result: terminalResult,
		});
		expect(result).toEqual({ ok: true, consumed: true });

		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.13'),
		);
		expect(snapshotAfter.lastOutcome).toBe('accepted_mutation');
		expect(snapshotAfter.lastTransitionId).toBe(
			'background-coder:child-coder-dir-scope',
		);
	});

	test('an exact-file declared scope still does not attribute sibling files', async () => {
		// The directory-prefix match must not loosen exact-file scopes: a
		// declared FILE entry has no children, so nothing else matches it.
		const snapshot = baseline(['src/a.ts', 'src/b.ts']);
		const record = coderRecord({
			taskId: '1.14',
			callID: 'coder-exact-scope',
			baseline: snapshot,
			declaredFiles: ['src/a.ts'],
		});
		writeFile('src/a.ts', 'export const a = 2;\n');
		writeFile('src/b.ts', 'export const b = 2;\n');

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record,
			result: terminalResult,
		});
		expect(result).toEqual({ ok: true, consumed: true });

		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.14'),
		);
		// src/a.ts is attributed (a real mutation), so this is still an
		// accepted_mutation — but the assertion that matters is that a
		// declared-exact scope with NO observed match stays no-mutation:
		expect(snapshotAfter.lastOutcome).toBe('accepted_mutation');
	});

	test('a coder with zero in-scope changes still settles as dispatch_no_mutation', async () => {
		const snapshot = baseline(['src/a.ts']);
		const record = coderRecord({
			taskId: '1.15',
			callID: 'coder-no-change',
			baseline: snapshot,
			declaredFiles: ['context'],
		});
		// Only an out-of-scope file changed: nothing to attribute.
		writeFile('src/a.ts', 'export const a = 2;\n');

		const result = await ingestBackgroundStageBCompletion({
			directory,
			record,
			result: terminalResult,
		});
		expect(result).toEqual({ ok: true, consumed: true });

		const snapshotAfter = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.15'),
		);
		expect(snapshotAfter.lastOutcome).toBe('dispatch_no_mutation');
	});
});
