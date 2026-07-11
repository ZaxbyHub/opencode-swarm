import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	readTaskEvidence,
	recordGateEvidence,
} from '../../../src/gate-evidence';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function record(
	agent: string,
	taskId: string,
	workspace = captureWorkspaceSnapshot(testDirectory),
): BackgroundDelegationRecord {
	return {
		schemaVersion: 1,
		correlationId: `${agent}-${taskId}`,
		jobId: null,
		subagentSessionId: `${agent}-session`,
		parentSessionId: 'parent-session',
		callID: `${agent}-call`,
		normalizedAgent: agent,
		swarmPrefixedAgent: agent,
		planTaskId: taskId,
		evidenceTaskId: taskId,
		status: 'completed',
		createdAt: 1,
		updatedAt: 2,
		workspace,
	};
}

let testDirectory = '';

describe('background doc-only gate evidence', () => {
	beforeEach(() => {
		resetSwarmState();
		testDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'background-doc-gate-'),
		);
		git(testDirectory, ['init']);
		git(testDirectory, ['config', 'user.email', 'tests@example.com']);
		git(testDirectory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(testDirectory, 'base.txt'), 'base\n');
		git(testDirectory, ['add', 'base.txt']);
		git(testDirectory, ['commit', '-m', 'test: seed repository']);
		startAgentSession('parent-session', 'architect');
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(testDirectory, { recursive: true, force: true });
	});

	test('coder provenance makes reviewer-only evidence durable', async () => {
		swarmState.agentSessions
			.get('parent-session')
			?.taskWorkflowStates?.set('1.1', 'coder_delegated');
		const baseline = captureWorkspaceSnapshot(testDirectory);
		fs.writeFileSync(path.join(testDirectory, 'README.md'), '# docs\n');
		const coder = record('coder', '1.1', baseline);
		coder.taskChangeContext = { declaredFiles: ['README.md'], baseline };

		expect(
			(
				await ingestBackgroundStageBCompletion({
					directory: testDirectory,
					record: coder,
					result: { text: 'done', chars: 4, truncated: false, digest: 'coder' },
				})
			).consumed,
		).toBe(true);

		const reviewer = record('reviewer', '1.1');
		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: reviewer,
			result: { text: 'pass', chars: 4, truncated: false, digest: 'reviewer' },
		});
		const evidence = await readTaskEvidence(testDirectory, '1.1');
		expect(evidence?.required_gates).toEqual(['reviewer']);
		expect(evidence?.gates.reviewer).toBeDefined();
		expect(
			swarmState.agentSessions
				.get('parent-session')
				?.taskWorkflowStates?.get('1.1'),
		).toBe('tests_run');
	});

	test('prior non-coder evidence cannot suppress the full coder gates', async () => {
		await recordGateEvidence(testDirectory, '1.5', 'critic', 'critic-session');
		const reviewer = record('reviewer', '1.5');
		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: reviewer,
			result: { text: 'pass', chars: 4, truncated: false, digest: 'reviewer' },
		});

		const evidence = await readTaskEvidence(testDirectory, '1.5');
		expect(evidence?.required_gates).toContain('test_engineer');
		expect(evidence?.test_engineer_exempt).not.toBe(true);
	});

	test('background coder observes its captured linked-worktree directory', async () => {
		const worktree = `${testDirectory}-linked`;
		git(testDirectory, [
			'worktree',
			'add',
			'-b',
			'docs-lane',
			worktree,
			'HEAD',
		]);
		try {
			const baseline = captureWorkspaceSnapshot(worktree);
			fs.writeFileSync(path.join(worktree, 'README.md'), '# linked docs\n');
			const coder = record('coder', '1.6', baseline);
			coder.taskChangeContext = { declaredFiles: ['README.md'], baseline };

			await ingestBackgroundStageBCompletion({
				directory: testDirectory,
				record: coder,
				result: { text: 'done', chars: 4, truncated: false, digest: 'linked' },
			});
			const evidence = await readTaskEvidence(testDirectory, '1.6');
			expect(evidence?.test_engineer_exempt).toBe(true);
		} finally {
			git(testDirectory, ['worktree', 'remove', '--force', worktree]);
		}
	});

	test('legacy reviewer completion without coder provenance fails closed', async () => {
		const reviewer = record('reviewer', '1.2');
		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: reviewer,
			result: { text: 'pass', chars: 4, truncated: false, digest: 'legacy' },
		});
		const evidence = await readTaskEvidence(testDirectory, '1.2');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	test('immutable code declaration cannot be downgraded by later plan changes', async () => {
		const baseline = captureWorkspaceSnapshot(testDirectory);
		fs.mkdirSync(path.join(testDirectory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(testDirectory, '.swarm', 'plan.json'),
			JSON.stringify({ files_touched: ['README.md'] }),
		);
		fs.writeFileSync(path.join(testDirectory, 'README.md'), '# docs\n');
		const coder = record('coder', '1.3', baseline);
		coder.taskChangeContext = { declaredFiles: ['src/code.ts'], baseline };

		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: coder,
			result: { text: 'done', chars: 4, truncated: false, digest: 'immutable' },
		});
		const evidence = await readTaskEvidence(testDirectory, '1.3');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	test('observed code beside docs prevents cross-task exemption', async () => {
		const baseline = captureWorkspaceSnapshot(testDirectory);
		fs.writeFileSync(path.join(testDirectory, 'README.md'), '# docs\n');
		fs.writeFileSync(
			path.join(testDirectory, 'code.ts'),
			'export const x = 1;\n',
		);
		const coder = record('coder', '1.4', baseline);
		coder.taskChangeContext = {
			declaredFiles: ['README.md', 'code.ts'],
			baseline,
		};

		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: coder,
			result: { text: 'done', chars: 4, truncated: false, digest: 'mixed' },
		});
		const evidence = await readTaskEvidence(testDirectory, '1.4');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});
});
