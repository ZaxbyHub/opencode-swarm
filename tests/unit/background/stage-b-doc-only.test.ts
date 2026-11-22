import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement.js';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

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
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

describe('background doc-only gate evidence', () => {
	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		testDirectory = canonicalMkdtemp('background-doc-gate-');
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
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	test('coder provenance makes reviewer-only evidence durable', async () => {
		swarmState.agentSessions
			.get('parent-session')
			?.taskWorkflowStates?.set('1.1', 'coder_delegated');
		const baseline = captureWorkspaceSnapshot(testDirectory);
		fs.writeFileSync(path.join(testDirectory, 'README.md'), '# docs\n');
		const coder = record('coder', '1.1', baseline);
		coder.taskChangeContext = {
			declaredFiles: ['README.md'],
			baseline,
			workflowGeneration: 0,
		};

		expect(
			(
				await ingestBackgroundStageBCompletion({
					directory: testDirectory,
					record: coder,
					result: { text: 'done', chars: 4, truncated: false, digest: 'coder' },
				})
			).consumed,
		).toBe(true);
		await transitionTaskWorkflowEvidence(testDirectory, '1.1', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a:1.1',
		});

		const reviewer = record('reviewer', '1.1');
		reviewer.workflowGeneration = 1;
		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: reviewer,
			result: {
				text: '[REVIEWED] | task-1.1 | APPROVED | docs are correct',
				chars: 54,
				truncated: false,
				digest: 'reviewer',
			},
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

	test('regression: exempt task with a test-engineer-demanding route receipt is not wedged at reviewer_run', async () => {
		// Production shape (Wirtschaftssimulation session 29b8ccea, task 1.8):
		// the dispatch-time route receipt demanded 1 reviewer + 1 test engineer
		// even though the durable evidence proves test_engineer_exempt
		// (docs-only AGENTS.md change). The Stage-B completeness barrier then
		// pinned the durable workflow at reviewer_run with "all required proof
		// exists" — the reviewer had passed everything that can ever pass for
		// an exempt task, and completion was blocked forever. Previous code:
		// routeCompleteForPersistence=false → durable state reviewer_run.
		swarmState.agentSessions
			.get('parent-session')
			?.taskWorkflowStates?.set('1.9', 'coder_delegated');
		const baseline = captureWorkspaceSnapshot(testDirectory);
		fs.writeFileSync(path.join(testDirectory, 'AGENTS.md'), '# docs rule\n');
		const coder = record('coder', '1.9', baseline);
		coder.taskChangeContext = {
			declaredFiles: ['AGENTS.md'],
			baseline,
			workflowGeneration: 0,
		};

		expect(
			(
				await ingestBackgroundStageBCompletion({
					directory: testDirectory,
					record: coder,
					result: { text: 'done', chars: 4, truncated: false, digest: 'coder' },
				})
			).consumed,
		).toBe(true);
		await transitionTaskWorkflowEvidence(testDirectory, '1.9', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a:1.9',
		});
		const exemptEvidence = await readTaskEvidence(testDirectory, '1.9');
		expect(exemptEvidence?.test_engineer_exempt).toBe(true);

		// The pre-fix route allocation shape: complexity-routed test-engineer
		// slot persisted for the parent session exactly as the dispatch hook
		// would have written it before the exemption-aware allocation fix.
		await persistReviewRouteReceipt({
			projectRoot: testDirectory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-session',
				taskId: '1.9',
				complexity: 'single',
				semanticRisk: 'Standard complexity: 1 files, 0 functions',
				requiredReviewers: ['1.9:reviewer:1'],
				requiredTestEngineers: ['1.9:test_engineer:1'],
			}),
		});

		const reviewer = record('reviewer', '1.9');
		reviewer.workflowGeneration = 1;
		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: reviewer,
			result: {
				text: '[REVIEWED] | task-1.9 | APPROVED | docs are correct',
				chars: 54,
				truncated: false,
				digest: 'reviewer',
			},
		});

		const evidence = await readTaskEvidence(testDirectory, '1.9');
		expect(evidence?.gates.reviewer).toBeDefined();
		// The durable workflow must advance past reviewer_run — the wedge the
		// completeness barrier previously caused for exempt tasks.
		expect(evidence?.workflow.state).toBe('tests_run');
		expect(
			swarmState.agentSessions
				.get('parent-session')
				?.taskWorkflowStates?.get('1.9'),
		).toBe('tests_run');
	});

	test('prior non-coder evidence cannot suppress the full coder gates', async () => {
		await recordGateEvidence(testDirectory, '1.5', 'critic', 'critic-session');
		await transitionTaskWorkflowEvidence(testDirectory, '1.5', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:1.5',
		});
		await transitionTaskWorkflowEvidence(testDirectory, '1.5', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a:1.5',
		});
		const reviewer = record('reviewer', '1.5');
		reviewer.workflowGeneration = 1;
		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: reviewer,
			result: {
				text: '[REVIEWED] | task-1.5 | APPROVED | implementation is correct',
				chars: 61,
				truncated: false,
				digest: 'reviewer',
			},
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

	test('legacy reviewer completion without a launch generation fails closed', async () => {
		const reviewer = record('reviewer', '1.2');
		const result = await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: reviewer,
			result: { text: 'pass', chars: 4, truncated: false, digest: 'legacy' },
		});
		const evidence = await readTaskEvidence(testDirectory, '1.2');
		expect(result.ok).toBe(false);
		expect(result.consumed).toBe(false);
		expect(result.reason).toContain('TASK_WORKFLOW_GENERATION_REQUIRED');
		expect(evidence).toBeNull();
	});

	test('immutable code declaration cannot be downgraded by later plan changes', async () => {
		const baseline = captureWorkspaceSnapshot(testDirectory);
		fs.mkdirSync(path.join(testDirectory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(testDirectory, '.swarm', 'plan.json'),
			JSON.stringify({ files_touched: ['README.md'] }),
		);
		fs.mkdirSync(path.join(testDirectory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(testDirectory, 'src', 'code.ts'),
			'export const immutable = true;\n',
		);
		const coder = record('coder', '1.3', baseline);
		coder.taskChangeContext = {
			declaredFiles: ['src/code.ts'],
			baseline,
			workflowGeneration: 0,
		};

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
			workflowGeneration: 0,
		};

		await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: coder,
			result: { text: 'done', chars: 4, truncated: false, digest: 'mixed' },
		});
		const evidence = await readTaskEvidence(testDirectory, '1.4');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	describe('regression: dirty background baseline fails closed (F-005)', () => {
		test('publishes no coder evidence when a declared Markdown path was already dirty', async () => {
			fs.writeFileSync(
				path.join(testDirectory, 'README.md'),
				'# pre-existing\n',
			);
			const baseline = captureWorkspaceSnapshot(testDirectory);
			expect(baseline.changedFiles).toEqual(['README.md']);
			fs.writeFileSync(path.join(testDirectory, 'README.md'), '# later docs\n');
			const coder = record('coder', '1.7', baseline);
			coder.taskChangeContext = {
				declaredFiles: ['README.md'],
				baseline,
				workflowGeneration: 0,
			};

			// A dirty baseline cannot attribute same-path changes to this coder. An
			// exemption here would turn pre-existing workspace dirt into trusted proof.
			const result = await ingestBackgroundStageBCompletion({
				directory: testDirectory,
				record: coder,
				result: { text: 'done', chars: 4, truncated: false, digest: 'dirty' },
			});

			const evidence = await readTaskEvidence(testDirectory, '1.7');
			expect(result).toEqual({
				ok: false,
				consumed: false,
				stale: true,
				reason:
					'background coder files could not be attributed to a clean immutable baseline',
			});
			expect(evidence).toBeNull();
		});
	});
});
