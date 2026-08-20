import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	captureReviewerScopeFileFingerprint,
	_internals as fingerprintInternals,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import { canonicalWorkspaceIdentity } from '../../../src/scope/scope-binding';
import {
	getReviewerScopeGenerationForCoderCall,
	markReviewerScopeGenerationReady,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';

let directory = '';
let laneDirectory = '';
const realRead = fingerprintInternals.read;
const SUCCESS_OUTPUT = { status: 'completed', output: 'done' };

function git(args: string[], cwd = directory): void {
	const result = spawnSync('git', args, {
		cwd,
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

/** The plan.json fixture installActiveScopeBinding writes is required for taskId resolution. */
async function beginCoder(input: {
	callID: string;
	lane?: boolean;
}): Promise<'coder_started' | null> {
	const childSessionID = `child-${input.callID}`;
	startAgentSession(
		childSessionID,
		'coder',
		input.lane ? laneDirectory : directory,
	);
	swarmState.activeAgent.set(childSessionID, 'coder');
	swarmState.agentSessions.get(childSessionID)!.delegationActive = true;
	installActiveScopeBinding({
		directory: input.lane ? laneDirectory : directory,
		childSessionId: childSessionID,
		parentSessionId: 'parent',
		dispatchCallId: input.callID,
		taskId: '1.1',
		files: ['src/a.ts'],
	});
	return beginApprovedReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: {
			subagent_type: 'coder',
			prompt: 'TASK: 1.1\nImplement the task.',
		},
		parentSessionID: 'parent',
		callID: input.callID,
	});
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
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-scope-lifecycle-v2-')),
	);
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
	fingerprintInternals.read = realRead;
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer scope lifecycle v2 (issue #2100 contracts D/E/F)', () => {
	test('a coder with zero observed writes and a clean tree completes as no_change; reviewer dispatch is typed-blocked, not stale', async () => {
		expect(await beginCoder({ callID: 'coder-nochange' })).toBe(
			'coder_started',
		);
		expect(await completeCoder('coder-nochange')).toBe('coder_no_change');
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-nochange',
			})?.status,
		).toBe('no_change');

		await expect(beginReviewer('reviewer-nochange')).rejects.toThrow(
			/REVIEWER_SCOPE_NO_CHANGE/,
		);
		// The generation is retained for architect retry — never discarded.
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-nochange',
			})?.status,
		).toBe('no_change');
	});

	test('zero observed writes with a dirty tree stays collecting with an actionable advisory', async () => {
		expect(await beginCoder({ callID: 'coder-dirty' })).toBe('coder_started');
		fs.writeFileSync(path.join(directory, 'src/rogue.ts'), 'rogue\n');
		expect(await completeCoder('coder-dirty')).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-dirty',
			})?.status,
		).toBe('collecting');
		const advisories = (
			swarmState.agentSessions.get('parent')?.pendingAdvisoryMessages ?? []
		).join('\n');
		expect(advisories).toContain('REVIEWER_SCOPE_UNATTRIBUTED_CHANGE');
		expect(advisories).toContain('ACTION[architect]');
	});

	test('ready publication is gated on fingerprint completeness (contract E)', async () => {
		expect(await beginCoder({ callID: 'coder-incomplete' })).toBe(
			'coder_started',
		);
		// Route the write but never record its fingerprint.
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-incomplete',
				file: 'src/a.ts',
			}),
		).toBe(true);
		expect(await completeCoder('coder-incomplete')).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-incomplete',
			})?.status,
		).toBe('collecting');
		const advisories = (
			swarmState.agentSessions.get('parent')?.pendingAdvisoryMessages ?? []
		).join('\n');
		expect(advisories).toContain('REVIEWER_CAPTURE_INCOMPLETE');
	});

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

	test('a genuine byte change before reviewer dispatch is stale and discarded (retry cannot fake equality)', async () => {
		expect(await beginCoder({ callID: 'coder-drift' })).toBe('coder_started');
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-drift',
				file: 'src/a.ts',
			}),
		).toBe(true);
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'coder bytes\n');
		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-drift',
				fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-drift',
			}),
		).toBe(true);
		// A later real change invalidates equality — stale, generation discarded.
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'mutated bytes\n');
		await expect(beginReviewer('reviewer-drift')).rejects.toThrow(
			/REVIEWER_SCOPE_STALE/,
		);
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-drift',
			}),
		).toBeNull();
	});

	test('exhausted transient retries throw a typed error and RETAIN the generation', async () => {
		expect(await beginCoder({ callID: 'coder-transient' })).toBe(
			'coder_started',
		);
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-transient',
				file: 'src/a.ts',
			}),
		).toBe(true);
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'stable bytes\n');
		const captured = captureReviewerScopeFileFingerprint(directory, 'src/a.ts');
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-transient',
				fingerprint: reviewerScopeCaptureToFingerprint(captured)!,
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '1.1',
				coderCallID: 'coder-transient',
			}),
		).toBe(true);
		// Every capture attempt races: the read hook mutates the file each time.
		let reads = 0;
		fingerprintInternals.read = ((
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			reads += 1;
			const bytesRead = realRead(fd, buffer, offset, length, position);
			if (bytesRead > 0) {
				fs.writeFileSync(path.join(directory, 'src/a.ts'), 'raced bytes\n');
			}
			return bytesRead;
		}) as typeof realRead;
		await expect(beginReviewer('reviewer-transient')).rejects.toThrow(
			/REVIEWER_CAPTURE_RETRY_EXHAUSTED/,
		);
		// Infrastructure failure must NOT have discarded the generation.
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'coder-transient',
			})?.status,
		).toBe('ready');
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
