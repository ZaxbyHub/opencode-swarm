import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundTaskChangeContext } from '../../../src/background/pending-delegations';
import { changedFilesSinceSnapshotAsync } from '../../../src/background/workspace-snapshot';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { resetSwarmState } from '../../../src/state';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
} from '../../../src/tools/update-task-status';
import {
	beginCoderSettlement,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { withFrozenClockAsync } from '../../helpers/test-clock';

const TASK_ID = '1.1';

function runGit(directory: string, args: string[], capture = false): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore',
		timeout: 5000,
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(`fixture git command failed: ${args.join(' ')}`);
	}
	return capture ? String(result.stdout).trim() : '';
}

function writePlan(directory: string, filesTouched: unknown = []): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Issue 2763 fixture',
			swarm: 'issue-2763',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: TASK_ID,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Read-only verification task',
							depends: [],
							files_touched: filesTouched,
						},
					],
				},
			],
		}),
	);
	runGit(directory, ['init', '--quiet']);
	runGit(directory, ['config', 'user.email', 'issue-2763@example.invalid']);
	runGit(directory, ['config', 'user.name', 'Issue 2763 test']);
	runGit(directory, ['add', '.']);
	runGit(directory, ['commit', '--quiet', '-m', 'issue 2763 fixture']);
}

function makeContext(
	directory: string,
	declaredFiles?: string[] | null,
): BackgroundTaskChangeContext {
	const context = {
		baseline: {
			directory,
			gitHead: runGit(directory, ['rev-parse', 'HEAD'], true),
			dirtyHash: null,
			changedFiles: [],
			prHeadSha: null,
			scope: null,
		},
		workflowGeneration: 0,
	} as BackgroundTaskChangeContext;
	if (declaredFiles !== undefined) context.declaredFiles = declaredFiles;
	return context;
}

async function settleNoMutation(
	directory: string,
	declaredFiles?: string[] | null,
	transitionId = 'issue-2763-no-mutation',
): Promise<void> {
	await beginCoderSettlement({
		directory,
		taskId: TASK_ID,
		transitionId,
		actor: 'issue-2763-test',
		expectedGeneration: 0,
		context: makeContext(directory, declaredFiles),
	});
	await settleCoderDispatch({
		directory,
		taskId: TASK_ID,
		transitionId,
		accepted: false,
		testEngineerExempt: false,
	});
}

async function gateStatus(directory: string): Promise<Record<string, unknown>> {
	return JSON.parse(
		await check_gate_status.execute(
			{ task_id: TASK_ID, working_directory: directory },
			{ directory },
		),
	) as Record<string, unknown>;
}

describe('issue #2763 — empty-scope read-only completion', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('empty-scope-2763-'));
		writePlan(directory, []);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('completes a trusted no-mutation task and keeps status arrays in parity', async () => {
		await settleNoMutation(directory, []);

		const before = checkReviewerGate(
			TASK_ID,
			directory,
			false,
			'session',
			directory,
		);
		expect(before.blocked).toBe(false);
		expect(before.requiredGates).toEqual([]);
		expect(before.missingGates).toEqual([]);

		const result = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: directory },
			directory,
		);
		const status = await gateStatus(directory);
		const evidence = readTaskEvidenceRaw(directory, TASK_ID);
		const workflow = evidence?.workflow as Record<string, unknown>;

		expect(result).toMatchObject({ success: true });
		expect(status.status).toBe('all_passed');
		expect(status.required_gates).toEqual([]);
		expect(status.missing_gates).toEqual([]);
		expect(evidence?.required_gates).toEqual([]);
		expect(evidence?.gates).not.toHaveProperty('pre_check');
		expect(getTaskWorkflowSnapshot(evidence).state).toBe('complete');
		expect(workflow.qaExempt).not.toBe(true);
		expect(workflow.forcedCompletion).not.toBe(true);
	});

	test('retains the dedicated settlement proof across an advisory gate and remains idempotent', async () => {
		await settleNoMutation(directory, [], 'issue-2763-preserve');
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'gate_recorded',
			gate: 'critic',
			sessionId: 'critic-session',
			expectedGeneration: 0,
			transitionId: 'issue-2763-critic',
		});

		const afterAdvisory = readTaskEvidenceRaw(directory, TASK_ID);
		const metadata = afterAdvisory?.workflow as Record<string, unknown>;
		expect(metadata.noMutationSettlement).toMatchObject({
			generation: 0,
			transitionId: 'issue-2763-preserve',
		});
		expect(afterAdvisory?.required_gates).toEqual(['critic']);

		const first = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: directory },
			directory,
		);
		const second = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: directory },
			directory,
		);
		expect(first).toMatchObject({ success: true });
		expect(second.success).toBe(true);
		expect(readTaskEvidenceRaw(directory, TASK_ID)?.workflow?.state).toBe(
			'complete',
		);
	});

	test('fails closed for malformed authoritative no-mutation evidence', async () => {
		// Before the hardening, check_gate_status trusted the authoritative schema
		// marker without validating noMutationSettlement, so malformed raw evidence
		// could bypass pre_check or throw while deriving the gate set.
		const evidencePath = path.join(
			directory,
			'.swarm',
			'evidence',
			`${TASK_ID}.json`,
		);
		fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
		fs.writeFileSync(
			evidencePath,
			JSON.stringify({
				taskId: TASK_ID,
				required_gates: [],
				gates: {},
				workflow: {
					schema: 'exact-task-v1',
					generation: 0,
					state: 'idle',
					retryCount: 0,
					retryHistory: [],
					retryEpoch: 0,
					lastOutcome: 'dispatch_no_mutation',
					lastTransitionId: 'issue-2763-malformed',
					updatedAt: '2026-09-14T00:00:00.000Z',
					noMutationSettlement: {
						generation: 0,
						transitionId: 'issue-2763-malformed',
						declaredFiles: 'not-an-array',
					},
				},
			}),
		);

		const status = await gateStatus(directory);
		expect(status.status).toBe('incomplete');
		expect(status.required_gates).toEqual(['pre_check']);
		expect(status.missing_gates).toContain('pre_check');
	});

	test('keeps a committed empty-scope settlement unchanged when retried after an advisory gate', async () => {
		const transitionId = 'issue-2763-settlement-retry';
		await settleNoMutation(directory, [], transitionId);
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'gate_recorded',
			gate: 'critic',
			sessionId: 'critic-session',
			expectedGeneration: 0,
			transitionId: 'issue-2763-retry-critic',
		});

		const beforeRetry = readTaskEvidenceRaw(directory, TASK_ID);
		const beforeWorkflow = getTaskWorkflowSnapshot(beforeRetry);
		const retry = await settleCoderDispatch({
			directory,
			taskId: TASK_ID,
			transitionId,
			accepted: false,
			testEngineerExempt: false,
		});
		const afterRetry = readTaskEvidenceRaw(directory, TASK_ID);
		const afterWorkflow = getTaskWorkflowSnapshot(afterRetry);

		// Before the hardening, replaying a COMMITTED settlement after an advisory
		// gate could reapply the transition and erase the advisory requirement.
		expect(retry.alreadyApplied).toBe(true);
		expect(afterRetry?.required_gates).toEqual(beforeRetry?.required_gates);
		expect(afterRetry?.gates).toHaveProperty('critic');
		expect(afterWorkflow.retryCount).toBe(beforeWorkflow.retryCount);
		expect(afterWorkflow.noMutationSettlement).toEqual(
			beforeWorkflow.noMutationSettlement,
		);
	});

	test('does not treat an actual empty-scope mutation as a no-mutation settlement', async () => {
		const transitionId = 'issue-2763-out-of-scope-mutation';
		const context = makeContext(directory, []);
		await beginCoderSettlement({
			directory,
			taskId: TASK_ID,
			transitionId,
			actor: 'issue-2763-test',
			expectedGeneration: 0,
			context,
		});
		// Before the fix, the empty declared scope filtered this real workspace
		// change away before settlement, allowing read-only completion.
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'undeclared.ts'),
			'export const changed = true;\n',
		);
		const observedFiles = await changedFilesSinceSnapshotAsync(
			directory,
			context.baseline,
		);
		expect(observedFiles).toContain('src/undeclared.ts');

		const settlement = await settleCoderDispatch({
			directory,
			taskId: TASK_ID,
			transitionId,
			accepted: false,
			testEngineerExempt: false,
			observedFiles,
		});
		expect(settlement.accepted).toBe(true);
		expect(getTaskWorkflowSnapshot(settlement.evidence)).toMatchObject({
			state: 'rework_required',
			generation: 1,
			lastOutcome: 'accepted_mutation_failed',
		});
		expect(settlement.evidence.workflow?.noMutationSettlement).toBeUndefined();
	});

	test('clears a prior read-only proof when a new dispatch starts', async () => {
		await settleNoMutation(directory, [], 'issue-2763-proof-reset');
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'dispatch_attempted',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'issue-2763-new-dispatch',
		});

		const evidence = readTaskEvidenceRaw(directory, TASK_ID);
		expect(evidence?.workflow?.noMutationSettlement).toBeUndefined();
		expect(getTaskWorkflowSnapshot(evidence)).toMatchObject({
			state: 'idle',
			generation: 0,
			lastOutcome: 'dispatch_attempted',
		});
	});

	test('keeps the secretscan overlay authoritative for a proven empty-scope task', async () => {
		await withFrozenClockAsync(
			async () => {
				await settleNoMutation(directory, [], 'issue-2763-secretscan');
				const bundleDirectory = path.join(
					directory,
					'.swarm',
					'evidence',
					TASK_ID,
				);
				fs.mkdirSync(bundleDirectory, { recursive: true });
				fs.writeFileSync(
					path.join(bundleDirectory, 'evidence.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						task_id: TASK_ID,
						entries: [
							{
								task_id: TASK_ID,
								type: 'secretscan',
								timestamp: '2026-09-14T00:00:00.000Z',
								agent: 'pre_check_batch',
								verdict: 'fail',
								summary: 'secret found',
								findings_count: 1,
								scan_directory: 'src',
								files_scanned: 1,
								skipped_files: 0,
								incomplete_files: 0,
								incomplete_paths: [],
							},
						],
						created_at: '2026-09-14T00:00:00.000Z',
						updated_at: '2026-09-14T00:00:00.000Z',
					}),
				);

				const status = await gateStatus(directory);
				expect(status.required_gates).toEqual([]);
				expect(status.status).toBe('incomplete');
				expect(status.missing_gates).toContain(
					'secretscan (BLOCKED — secrets detected)',
				);
			},
			{ fixedNow: 1_767_225_600_000, isoNow: '2026-01-01T00:00:00.000Z' },
		);
	});

	test('does not grant the exception to plan scope alone or malformed settlement scope', async () => {
		const cases: Array<{ label: string; scope?: unknown }> = [
			{ label: 'without-settlement' },
			{ label: 'null-settlement', scope: null },
			{ label: 'non-empty-settlement', scope: ['src/changed.ts'] },
			{ label: 'malformed-settlement', scope: 'not-an-array' },
		];

		for (const [index, candidate] of cases.entries()) {
			resetSwarmState();
			cleanup();
			({ dir: directory, cleanup } = createSafeTestDir(
				`empty-scope-2763-${index}-`,
			));
			writePlan(directory, []);
			if (candidate.label !== 'without-settlement') {
				if (candidate.label === 'malformed-settlement') {
					await expect(
						settleNoMutation(
							directory,
							candidate.scope as string[] | null,
							`issue-2763-${candidate.label}`,
						),
					).rejects.toThrow('CODER_SETTLEMENT_WAL_UNREADABLE');
					continue;
				}
				await settleNoMutation(
					directory,
					candidate.scope as string[] | null,
					`issue-2763-${candidate.label}`,
				);
			}
			const result = await executeUpdateTaskStatus(
				{ task_id: TASK_ID, status: 'completed', working_directory: directory },
				directory,
			);
			expect(result.success, candidate.label).toBe(false);
		}
	});

	test('keeps accepted mutation and stale Stage A on the ordinary pre_check path', async () => {
		await settleNoMutation(directory, [], 'issue-2763-mutation');
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			context: { declaredFiles: [], testEngineerExempt: false },
			expectedGeneration: 0,
			transitionId: 'issue-2763-accepted-mutation',
		});
		const decision = checkReviewerGate(
			TASK_ID,
			directory,
			false,
			'session',
			directory,
		);
		expect(decision.blocked).toBe(true);
		expect(decision.missingGates).toContain('pre_check');

		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'issue-2763-stale-stage-a',
		});
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			context: { declaredFiles: [], testEngineerExempt: false },
			expectedGeneration: 1,
			transitionId: 'issue-2763-second-mutation',
		});
		const afterMutation = checkReviewerGate(
			TASK_ID,
			directory,
			false,
			'session',
			directory,
		);
		expect(afterMutation.blocked).toBe(true);
		expect(afterMutation.missingGates).toContain('pre_check');
	});
});
