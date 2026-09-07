import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimTerminalResult,
	type RecordPendingInput,
	recordPendingDelegation,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { publishWorktreeRecoveryAuthority } from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import { runInitOrphanRecovery } from '../../../src/hooks/init-orphan-recovery';
import { resetSwarmState } from '../../../src/state';

describe('init orphan recovery settlement ownership', () => {
	const roots: string[] = [];

	afterEach(() => {
		resetSwarmState();
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	function setup() {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-init-settlement-')),
		);
		roots.push(root);
		const directory = path.join(root, 'project');
		// Issue #2527: lanes enumerated for reclamation live under the
		// project-INTERNAL base (<project>/.swarm-worktrees).
		const worktreePath = path.join(
			directory,
			'.swarm-worktrees',
			'child-session',
			'1.1',
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.mkdirSync(worktreePath, { recursive: true });
		fs.writeFileSync(path.join(worktreePath, 'valuable.txt'), 'keep\n');
		const input: RecordPendingInput = {
			correlationId: 'child-session',
			jobId: 'job-1',
			subagentSessionId: 'child-session',
			parentSessionId: 'parent-session',
			callID: 'call-1',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			taskChangeContext: {
				declaredFiles: ['valuable.txt'],
				baseline: {
					directory: worktreePath,
					gitHead: 'base',
					dirtyHash: 'clean',
					changedFiles: [],
					prHeadSha: null,
					scope: '1.1',
				},
			},
			worktree: {
				callID: 'call-1',
				parentSessionId: 'parent-session',
				taskId: '1.1',
				planTaskId: '1.1',
				worktreePath,
				branchName: 'swarm/lane/child-session/1.1',
				worktreeId: '1.1',
				worktreeSessionId: 'child-session',
				mergeStrategy: 'merge',
				laneIndex: 0,
				worktreeDir: null,
			},
		};
		return { directory, input, worktreePath };
	}

	async function publishTerminal(directory: string, input: RecordPendingInput) {
		await recordPendingDelegation(directory, input);
		const eventId = buildBackgroundCompletionEventId({
			correlationId: input.correlationId,
			jobId: input.jobId,
			status: 'completed',
			resultDigest: 'digest',
		});
		await claimTerminalResult(directory, input.correlationId, {
			eventId,
			status: 'completed',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'digest' },
		});
		return eventId;
	}

	test('protects a completed worktree until settlement proves it landed', async () => {
		const { directory, input, worktreePath } = setup();
		await publishTerminal(directory, input);

		const result = await runInitOrphanRecovery(directory);

		expect(result.removedWorktrees).not.toContain(worktreePath);
		expect(fs.existsSync(path.join(worktreePath, 'valuable.txt'))).toBe(true);
	});

	test('allows cleanup after durable merged settlement', async () => {
		const { directory, input, worktreePath } = setup();
		const operationId = await publishTerminal(directory, input);
		await claimCoderSettlement(directory, input.correlationId, operationId);
		await updateCoderSettlement(directory, input.correlationId, {
			operationId,
			state: 'settled',
			observedFiles: ['valuable.txt'],
			outcome: { kind: 'standard-worktree', result: 'merged' },
		});

		const result = await runInitOrphanRecovery(directory);

		expect(result.removedWorktrees).toContain(worktreePath);
		expect(fs.existsSync(worktreePath)).toBe(false);
	});

	test('protects an unresolved v2 recovery authority after restart', async () => {
		const { directory, worktreePath } = setup();
		const published = publishWorktreeRecoveryAuthority(directory, {
			originalCallID: 'call-original',
			parentSessionId: 'parent-session',
			taskId: '1.1',
			reservationId: 'reservation-1',
			generation: 1,
			canonicalBranch: 'main',
			canonicalPath: directory,
			laneBranch: 'swarm/lane/child-session/1.1',
			lanePath: worktreePath,
			expectedPrimaryHead: '1'.repeat(40),
			sourceBaseOid: '2'.repeat(40),
			sourceHeadOid: '3'.repeat(40),
			targetHeadOid: '4'.repeat(40),
			strategy: 'merge',
		});
		expect(published.ok).toBe(true);

		const result = await runInitOrphanRecovery(directory);

		expect(result.removedWorktrees).not.toContain(worktreePath);
		expect(fs.existsSync(path.join(worktreePath, 'valuable.txt'))).toBe(true);
	});
});
