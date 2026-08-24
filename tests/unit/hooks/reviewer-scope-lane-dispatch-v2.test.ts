import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	captureReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import { canonicalWorkspaceIdentity } from '../../../src/scope/scope-binding';
import {
	getReviewerScopeGenerationForCoderCall,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
let laneDirectory = '';
const SUCCESS_OUTPUT = { status: 'completed', output: 'done' };

function git(args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
}

async function completeCoder(callID: string, output: unknown = SUCCESS_OUTPUT) {
	return completeReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: {
			subagent_type: 'coder',
			prompt: 'TASK: 1.1\nImplement the task.',
		},
		output,
		parentSessionID: 'parent',
		callID,
	});
}

async function beginReviewer(callID: string) {
	return beginApprovedReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: {
			subagent_type: 'reviewer',
			prompt: 'TASK: 1.1\nReview the task.',
		},
		parentSessionID: 'parent',
		callID,
		maxBytes: 1024 * 1024,
	});
}

beforeEach(() => {
	resetSwarmState();
	directory = canonicalMkdtemp('reviewer-scope-lane-');
	laneDirectory = path.join(directory, '.swarm-worktrees', 'sess', 'lane-1');
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.mkdirSync(path.join(laneDirectory, 'src'), { recursive: true });
	fs.writeFileSync(path.join(directory, 'src/a.ts'), 'baseline\n');
	git(['init']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test']);
	git(['add', 'src/a.ts']);
	git(['commit', '-m', 'baseline']);
	fs.appendFileSync(path.join(directory, '.git/info/exclude'), '\n.swarm/\n');
	startAgentSession('parent', 'architect', directory);
	startAgentSession('fixture-child', 'coder', directory);
	installActiveScopeBinding({
		directory,
		childSessionId: 'fixture-child',
		parentSessionId: 'parent',
		dispatchCallId: 'fixture-call',
		taskId: '1.1',
		files: ['src/a.ts'],
	});
});

afterEach(() => {
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer scope lane dispatch v2 (issue #2100 contracts D)', () => {
	test('a worktree_derived binding resolves the lane root from the dispatch registry', async () => {
		const { standardWorktreeByCallID } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);
		fs.writeFileSync(path.join(laneDirectory, 'src/a.ts'), 'lane bytes\n');
		standardWorktreeByCallID.set('coder-wt', {
			callID: 'coder-wt',
			handle: {
				worktreePath: laneDirectory,
				branchName: 'swarm/lane-test',
			},
		} as never);
		try {
			// installActiveScopeBinding creates a plan-sourced binding; flip it to
			// worktree_derived with the lane identity the way deriveChildScopeBinding does.
			const childSessionID = 'child-coder-wt';
			startAgentSession(childSessionID, 'coder', laneDirectory);
			swarmState.activeAgent.set(childSessionID, 'coder');
			swarmState.agentSessions.get(childSessionID)!.delegationActive = true;
			installActiveScopeBinding({
				directory: laneDirectory,
				childSessionId: childSessionID,
				parentSessionId: 'parent',
				dispatchCallId: 'coder-wt',
				taskId: '1.1',
				files: ['src/a.ts'],
			});
			const { getScopeBindingForParentDispatch } = await import(
				'../../../src/scope/scope-binding'
			);
			const binding = getScopeBindingForParentDispatch({
				parentSessionId: 'parent',
				dispatchCallId: 'coder-wt',
			});
			expect(binding).not.toBeNull();
			(binding as { source: string }).source = 'worktree_derived';

			await expect(
				beginApprovedReviewerScopeLifecycle({
					directory,
					tool: 'Task',
					args: {
						subagent_type: 'coder',
						prompt: 'TASK: 1.1\nImplement the task.',
					},
					parentSessionID: 'parent',
					callID: 'coder-wt',
				}),
			).resolves.toBe('coder_started');
			const generation = getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-wt',
			});
			expect(generation?.captureDirectory).toBe(laneDirectory);
			expect(generation?.workspaceIdentity).toBe(
				canonicalWorkspaceIdentity(laneDirectory),
			);
		} finally {
			standardWorktreeByCallID.delete('coder-wt');
		}
	});

	test('F-006: a binding/task mismatch aborts a provisioned lane before the typed denial', async () => {
		const { standardWorktreeByCallID } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);
		fs.writeFileSync(path.join(laneDirectory, 'src/a.ts'), 'lane bytes\n');
		// A dispatch registry entry that the mismatch throw must consume via
		// abortStandardWorktreeDispatch — otherwise the lane leaks (F-006).
		standardWorktreeByCallID.set('coder-mismatched', {
			callID: 'coder-mismatched',
			handle: {
				worktreePath: laneDirectory,
				branchName: 'swarm/lane-mismatch',
			},
		} as never);
		const childSessionID = 'child-coder-mismatched';
		startAgentSession(childSessionID, 'coder', laneDirectory);
		swarmState.activeAgent.set(childSessionID, 'coder');
		swarmState.agentSessions.get(childSessionID)!.delegationActive = true;
		// Binding names task 2.2 while the dispatch args name task 1.1.
		installActiveScopeBinding({
			directory: laneDirectory,
			childSessionId: childSessionID,
			parentSessionId: 'parent',
			dispatchCallId: 'coder-mismatched',
			taskId: '2.2',
			files: ['src/a.ts'],
		});
		try {
			const error = await beginApprovedReviewerScopeLifecycle({
				directory,
				tool: 'Task',
				args: {
					subagent_type: 'coder',
					prompt: 'TASK: 1.1\nImplement the task.',
				},
				parentSessionID: 'parent',
				callID: 'coder-mismatched',
			}).catch((thrown: Error) => thrown);
			expect(error.message).toContain('REVIEWER_SCOPE_BINDING_MISMATCH');
			expect(error.message).toContain('responsible: architect');
			// The abort path consumed the tracked dispatch: the registry entry
			// must no longer exist (cleanupStandardWorktreeForCallId deletes it).
			expect(standardWorktreeByCallID.has('coder-mismatched')).toBe(false);
			// No generation may exist for a mismatched dispatch.
			expect(
				getReviewerScopeGenerationForCoderCall({
					parentSessionID: 'parent',
					coderCallID: 'coder-mismatched',
				}),
			).toBeNull();
		} finally {
			standardWorktreeByCallID.delete('coder-mismatched');
		}
	});

	test('a lane-rooted generation stays mergeback_pending until verified; then it is claimable', async () => {
		// Lane copy of the repo file with the coder's post-write bytes.
		fs.writeFileSync(path.join(laneDirectory, 'src/a.ts'), 'lane bytes\n');
		const generation = startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId: '1.1',
			coderCallID: 'coder-lane',
			declaredFiles: ['src/a.ts'],
			captureDirectory: laneDirectory,
			workspaceIdentity: canonicalWorkspaceIdentity(laneDirectory)!,
		});
		expect(generation).not.toBeNull();
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-lane',
				file: 'src/a.ts',
			}),
		).toBe(true);
		const captured = captureReviewerScopeFileFingerprint(
			laneDirectory,
			'src/a.ts',
		);
		expect(captured.kind).toBe('captured_file');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-lane',
				fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
			}),
		).toBe(true);
		// Completing from the primary root routes a lane generation to pending.
		expect(await completeCoder('coder-lane')).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-lane',
			})?.status,
		).toBe('mergeback_pending');

		// Reviewer dispatch is typed-blocked while merge-back is unverified.
		await expect(beginReviewer('reviewer-lane')).rejects.toThrow(
			/REVIEWER_SCOPE_MERGEBACK_PENDING/,
		);
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-lane',
			})?.status,
		).toBe('mergeback_pending');

		// Simulate merge-back landing the exact lane bytes in the primary root.
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'lane bytes\n');
		const { verifyReviewerScopeGenerationMergeBack } = await import(
			'../../../src/hooks/reviewer-scope-mergeback'
		);
		verifyReviewerScopeGenerationMergeBack({
			parentSessionID: 'parent',
			taskId: '1.1',
			coderCallID: 'coder-lane',
			primaryDirectory: directory,
		});
		const settled = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			coderCallID: 'coder-lane',
		});
		expect(settled?.status).toBe('ready');
		expect(settled?.mergeback).toMatchObject({
			verifiedAt: expect.any(Number),
		});

		// Primary bytes now equal the lane manifest: the reviewer claims cleanly
		// and receives the exact manifest block in its prompt.
		const reviewerArgs = {
			subagent_type: 'reviewer',
			prompt: 'TASK: 1.1\nReview the task.',
		};
		await expect(
			beginApprovedReviewerScopeLifecycle({
				directory,
				tool: 'Task',
				args: reviewerArgs,
				parentSessionID: 'parent',
				callID: 'reviewer-lane',
				maxBytes: 1024 * 1024,
			}),
		).resolves.toBe('reviewer_claimed');
		expect(reviewerArgs.prompt).toContain('<reviewer_scope_manifest>');
		expect(reviewerArgs.prompt).toContain('manifest_hash: ');
	});
});
