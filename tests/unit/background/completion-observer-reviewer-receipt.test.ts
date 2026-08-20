/**
 * Background completion observer Stage-B reviewer receipt coverage.
 *
 * Kept separate from the legacy observer suite so the pre-existing over-cap
 * parent file does not grow beyond its main-branch line-count ratchet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	captureWorkspaceSnapshot,
	changedFilesSinceSnapshot,
	_internals as workspaceSnapshotInternals,
} from '../../../src/background/workspace-snapshot';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { readAllReceipts } from '../../../src/hooks/review-receipt';
import { _internals as receiptCollectorInternals } from '../../../src/hooks/review-receipt-collector';
import {
	captureReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import { beginApprovedReviewerScopeLifecycle } from '../../../src/hooks/reviewer-scope-lifecycle';
import {
	claimReviewerScopeGeneration,
	ensureAgentSession,
	getAgentSession,
	getReviewerScopeGenerationForCoderCall,
	getTaskState,
	markReviewerScopeGenerationReady,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
} from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bgobs-receipt-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function runGit(directory: string, ...args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		stdio: 'ignore',
		timeout: 5_000,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

function syntheticPartEvent(text: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					text,
					synthetic: true,
					sessionID: 'parent_session',
				},
			},
		},
	};
}

describe('background completion observer reviewer receipts', () => {
	let dir: string;
	let receiptScopeSessionIDs: string[];
	const realSpawnSync = workspaceSnapshotInternals.spawnSync;
	const realResolveReviewerTaskScope =
		receiptCollectorInternals.resolveReviewerTaskScope;

	beforeEach(() => {
		resetSwarmState();
		workspaceSnapshotInternals.spawnSync = realSpawnSync;
		dir = makeTempProject();
		receiptScopeSessionIDs = [];
		receiptCollectorInternals.resolveReviewerTaskScope = async (
			_directory,
			sessionID,
		) => {
			receiptScopeSessionIDs.push(sessionID);
			return {
				content: 'opencode-swarm-reviewer-task-scope-v1\nbackground\n',
				description: 'reviewer-task-files-v1',
				files: ['src/background.ts'],
			};
		};
	});

	afterEach(() => {
		workspaceSnapshotInternals.spawnSync = realSpawnSync;
		receiptCollectorInternals.resolveReviewerTaskScope =
			realResolveReviewerTaskScope;
		resetSwarmState();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('applies trusted Stage B completion to workflow evidence and the resolved-scope receipt', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(dir, '1.1');

		await recordPendingDelegation(dir, {
			correlationId: 'ses_reviewer',
			jobId: 'job_reviewer',
			subagentSessionId: 'ses_reviewer',
			parentSessionId: 'parent_session',
			callID: 'c-reviewer',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: generation,
			prompt: {
				text: 'TASK: 1.1\nCHECK: [security, correctness]',
				chars: 40,
				truncated: false,
				digest: 'prompt-digest',
			},
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
			reviewerReceiptOptions: {
				config: resolveAutoReviewConfig({ enabled: true }),
			},
		});
		await observer.event(
			syntheticPartEvent(
				'<task id="ses_reviewer" state="completed">\n' +
					'<task_result>[REVIEWED] | 1.1 | APPROVED | no issues\nVERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none</task_result>\n' +
					'</task>',
			),
		);

		expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		expect(findByCorrelationId(dir, 'ses_reviewer')?.status).toBe('consumed');
		const evidence = await readTaskEvidence(dir, '1.1');
		expect(evidence?.gates.reviewer?.agent).toBe('reviewer');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(checkReviewerGate('1.1', dir, true, 'parent_session').blocked).toBe(
			true,
		);

		const receipts = await readAllReceipts(dir);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].verdict).toBe('approved');
		expect(receiptScopeSessionIDs).toEqual(['parent_session']);
	});

	it('ingests concurrent duplicate trusted completions exactly once', async () => {
		// Previous observers raced after reading the same pending record, so both
		// could persist reviewer evidence and receipts for one completion.
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		const generation = await seedStageAPassed(dir, '1.1');
		await recordPendingDelegation(dir, {
			correlationId: 'ses_duplicate',
			jobId: 'job_duplicate',
			subagentSessionId: 'ses_duplicate',
			parentSessionId: 'parent_session',
			callID: 'c-duplicate',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: generation,
			prompt: {
				text: 'TASK: 1.1\nCHECK: [correctness]',
				chars: 30,
				truncated: false,
				digest: 'prompt-duplicate',
			},
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
			reviewerReceiptOptions: {
				config: resolveAutoReviewConfig({ enabled: true }),
			},
		});
		const event = syntheticPartEvent(
			'<task id="ses_duplicate" state="completed">\n' +
				'<task_result>[REVIEWED] | 1.1 | APPROVED | no issues\nVERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none</task_result>\n' +
				'</task>',
		);

		await Promise.all([observer.event(event), observer.event(event)]);

		expect(findByCorrelationId(dir, 'ses_duplicate')?.status).toBe('consumed');
		expect(await readAllReceipts(dir)).toHaveLength(1);
		expect(receiptScopeSessionIDs).toEqual(['parent_session']);
		expect((await readTaskEvidence(dir, '1.1'))?.gates.reviewer?.agent).toBe(
			'reviewer',
		);
	});

	it('routes background coder files to ready state and consumes them on reviewer terminal', async () => {
		receiptCollectorInternals.resolveReviewerTaskScope =
			realResolveReviewerTaskScope;
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const value = 1;\n');
		runGit(dir, 'init');
		runGit(dir, 'config', 'user.email', 'test@example.com');
		runGit(dir, 'config', 'user.name', 'Test');
		runGit(dir, 'add', 'src/a.ts');
		runGit(dir, 'commit', '-m', 'fixture');
		startAgentSession('parent_session', 'architect', dir);
		getAgentSession('parent_session')!.currentTaskId = '1.1';
		startAgentSession('coder_child', 'coder', dir);
		installActiveScopeBinding({
			directory: dir,
			childSessionId: 'coder_child',
			parentSessionId: 'parent_session',
			dispatchCallId: 'coder-bg-call',
			taskId: '1.1',
			files: ['src/a.ts'],
		});
		const coderArgs = {
			subagent_type: 'coder',
			background: true,
			prompt: 'TASK: 1.1\nImplement the task.',
		};
		expect(
			await beginApprovedReviewerScopeLifecycle({
				directory: dir,
				tool: 'Task',
				args: coderArgs,
				parentSessionID: 'parent_session',
				callID: 'coder-bg-call',
			}),
		).toBe('coder_started');
		fs.appendFileSync(path.join(dir, '.git/info/exclude'), '\n.swarm/\n');
		const baseline = captureWorkspaceSnapshot(dir);
		await recordPendingDelegation(dir, {
			correlationId: 'ses_coder_bg',
			jobId: 'job_coder_bg',
			subagentSessionId: 'ses_coder_bg',
			parentSessionId: 'parent_session',
			callID: 'coder-bg-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			taskChangeContext: { baseline, declaredFiles: ['src/a.ts'] },
		});
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent_session',
				taskId: '1.1',
				coderCallID: 'coder-bg-call',
				file: 'src/a.ts',
			}),
		).toBe(true);
		fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const value = 2;\n');
		const fingerprint = captureReviewerScopeFileFingerprint(dir, 'src/a.ts');
		expect(fingerprint?.kind).toBe('captured_file');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent_session',
				taskId: '1.1',
				coderCallID: 'coder-bg-call',
				fingerprint: reviewerScopeCaptureToFingerprint(fingerprint)!,
			}),
		).toBe(true);
		expect(changedFilesSinceSnapshot(dir, baseline)).toEqual(['src/a.ts']);
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
			reviewerReceiptOptions: {
				config: resolveAutoReviewConfig({ enabled: true }),
			},
		});
		await observer.event(
			syntheticPartEvent(
				'<task id="ses_coder_bg" state="completed">\n<task_result>done</task_result>\n</task>',
			),
		);
		const coderRecord = findByCorrelationId(dir, 'ses_coder_bg');
		expect(coderRecord?.result?.error).toBeUndefined();
		expect(coderRecord?.status).toBe('consumed');
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent_session',
				coderCallID: 'coder-bg-call',
			})?.status,
		).toBe('ready');
		await transitionTaskWorkflowEvidence(dir, '1.1', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'reviewer-receipt-stage-a',
		});

		const reviewerArgs = {
			subagent_type: 'reviewer',
			prompt: 'TASK: 1.1\nReview the coder output.',
		};
		expect(
			await beginApprovedReviewerScopeLifecycle({
				directory: dir,
				tool: 'Task',
				args: reviewerArgs,
				parentSessionID: 'parent_session',
				callID: 'reviewer-bg-call',
			}),
		).toBe('reviewer_claimed');
		await recordPendingDelegation(dir, {
			correlationId: 'ses_reviewer_bg',
			jobId: 'job_reviewer_bg',
			subagentSessionId: 'ses_reviewer_bg',
			parentSessionId: 'parent_session',
			callID: 'reviewer-bg-call',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workflowGeneration: 1,
			prompt: {
				text: reviewerArgs.prompt,
				chars: reviewerArgs.prompt.length,
				truncated: false,
				digest: 'reviewer-prompt',
			},
			workspace: captureWorkspaceSnapshot(dir),
		});
		await observer.event(
			syntheticPartEvent(
				'<task id="ses_reviewer_bg" state="completed">\n<task_result>[REVIEWED] | 1.1 | APPROVED | no issues\nVERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none</task_result>\n</task>',
			),
		);
		expect(findByCorrelationId(dir, 'ses_reviewer_bg')?.status).toBe(
			'consumed',
		);
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent_session',
				coderCallID: 'coder-bg-call',
			}),
		).toBeNull();
		expect(await readAllReceipts(dir)).toHaveLength(1);
	});

	it('cleans exact reviewer claims on background error and stale completion', async () => {
		startAgentSession('parent_session', 'architect', dir);
		runGit(dir, 'init');
		runGit(dir, 'config', 'user.email', 'test@example.com');
		runGit(dir, 'config', 'user.name', 'Test');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
			reviewerReceiptOptions: {
				config: resolveAutoReviewConfig({ enabled: true }),
			},
		});
		expect(
			startReviewerScopeGeneration({
				parentSessionID: 'parent_session',
				taskId: '1.1',
				coderCallID: 'coder-terminal-error',
				captureDirectory: dir,
				workspaceIdentity: 'ws:/observer-receipt',
			}),
		).not.toBeNull();
		await recordPendingDelegation(dir, {
			correlationId: 'ses_coder_error',
			jobId: 'job_coder_error',
			subagentSessionId: 'ses_coder_error',
			parentSessionId: 'parent_session',
			callID: 'coder-terminal-error',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
		});
		await observer.event(
			syntheticPartEvent(
				'<task id="ses_coder_error" state="error">\n<task_error>failed</task_error>\n</task>',
			),
		);
		expect(findByCorrelationId(dir, 'ses_coder_error')?.status).toBe('error');
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent_session',
				coderCallID: 'coder-terminal-error',
			}),
		).toBeNull();
		for (const mode of ['error', 'stale'] as const) {
			const coderCallID = `coder-${mode}`;
			const reviewerCallID = `reviewer-${mode}`;
			expect(
				startReviewerScopeGeneration({
					parentSessionID: 'parent_session',
					taskId: '1.1',
					coderCallID,
					captureDirectory: dir,
					workspaceIdentity: 'ws:/observer-receipt',
				}),
			).not.toBeNull();
			expect(
				markReviewerScopeGenerationReady({
					parentSessionID: 'parent_session',
					taskId: '1.1',
					coderCallID,
				}),
			).toBe(true);
			expect(
				claimReviewerScopeGeneration({
					parentSessionID: 'parent_session',
					taskId: '1.1',
					reviewerCallID,
				}),
			).not.toBeNull();
			const scopeFile = path.join(dir, `scope-${mode}.txt`);
			fs.writeFileSync(scopeFile, 'before');
			runGit(dir, 'add', `scope-${mode}.txt`);
			runGit(dir, 'commit', '-m', `fixture ${mode}`);
			await recordPendingDelegation(dir, {
				correlationId: `ses_${mode}`,
				jobId: `job_${mode}`,
				subagentSessionId: `ses_${mode}`,
				parentSessionId: 'parent_session',
				callID: reviewerCallID,
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'reviewer',
				planTaskId: '1.1',
				evidenceTaskId: '1.1',
				workspace: captureWorkspaceSnapshot(dir),
			});
			if (mode === 'stale') fs.writeFileSync(scopeFile, 'after');
			await observer.event(
				syntheticPartEvent(
					mode === 'error'
						? `<task id="ses_${mode}" state="error">\n<task_error>failed</task_error>\n</task>`
						: `<task id="ses_${mode}" state="completed">\n<task_result>done</task_result>\n</task>`,
				),
			);
			expect(findByCorrelationId(dir, `ses_${mode}`)?.status).toBe(mode);
			expect(
				getReviewerScopeGenerationForCoderCall({
					parentSessionID: 'parent_session',
					coderCallID,
				}),
			).toBeNull();
		}
	});

	it('leaves taskless coder completion terminal without acquiring an ingestion lease', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'ses_taskless_coder',
			jobId: 'job_taskless_coder',
			subagentSessionId: 'ses_taskless_coder',
			parentSessionId: 'parent_session',
			callID: 'coder-taskless',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: null,
			evidenceTaskId: null,
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});

		await observer.event(
			syntheticPartEvent(
				'<task id="ses_taskless_coder" state="completed">\n<task_result>done</task_result>\n</task>',
			),
		);

		const record = findByCorrelationId(dir, 'ses_taskless_coder');
		expect(record?.status).toBe('completed');
		expect(record?.ingestionId).toBeUndefined();
	});
});
