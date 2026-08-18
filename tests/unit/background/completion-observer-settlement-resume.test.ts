import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimTerminalResult,
	findByCorrelationId,
	recordPendingDelegation,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const HEX40 = 'b'.repeat(40);
const HEX64 = 'b'.repeat(64);

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 256 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git exited ${result.status}`,
		);
	}
	return result.stdout.trim();
}

/**
 * Persisted settlement provenance is read back off the `.swarm` ledger and fed
 * straight into `git` argv by the reconciliation path, so these cases pin which
 * stored head values are allowed to resume a merge at all.
 */
describe('settlement resume head validation', () => {
	let directory = '';
	let worktreePath = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('swarm-bg-resume-');
		directory = safe.dir;
		cleanup = safe.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n.swarm-worktrees/\n',
		);
		worktreePath = path.join(directory, '.swarm-worktrees', 'lane-1');
		fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
		git(directory, [
			'worktree',
			'add',
			'-b',
			'swarm/lane/background-coder',
			worktreePath,
			'HEAD',
		]);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	/**
	 * Seeds a delegation that is mid-settlement with the given persisted heads and
	 * replays its completion event.
	 */
	async function replaySettling(
		sourceHeadAfterCommit: string,
		targetHeadBeforeMerge: string,
	): Promise<void> {
		ensureAgentSession('parent', 'architect', directory);
		const baseline = captureWorkspaceSnapshot(worktreePath);
		await recordPendingDelegation(directory, {
			correlationId: 'resume-coder',
			jobId: null,
			subagentSessionId: 'resume-coder',
			parentSessionId: 'parent',
			callID: 'resume-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '7.1',
			evidenceTaskId: '7.1',
			workspace: baseline,
			taskChangeContext: { declaredFiles: ['resume.ts'], baseline },
			worktree: {
				callID: 'resume-call',
				parentSessionId: 'parent',
				taskId: '7.1',
				planTaskId: '7.1',
				worktreePath,
				branchName: 'swarm/lane/background-coder',
				worktreeId: 'lane-1',
				worktreeSessionId: 'resume-coder',
				mergeStrategy: 'merge',
				laneIndex: 0,
				worktreeDir: null,
			},
		});
		fs.writeFileSync(path.join(worktreePath, 'resume.ts'), 'resume\n');
		const digest = createHash('sha256').update('done').digest('hex');
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'resume-coder',
			jobId: null,
			status: 'completed',
			resultDigest: digest,
		});
		await claimTerminalResult(directory, 'resume-coder', {
			eventId,
			status: 'completed',
			recordedAt: 1,
			result: { text: 'done', chars: 4, truncated: false, digest },
		});
		await claimCoderSettlement(directory, 'resume-coder', eventId);
		await updateCoderSettlement(directory, 'resume-coder', {
			operationId: eventId,
			state: 'settling',
			sourceHeadAfterCommit,
			targetHeadBeforeMerge,
			observedFiles: ['resume.ts'],
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'parent',
						text:
							'<task id="resume-coder" state="completed">\n' +
							'<task_result>done</task_result>\n</task>',
					},
				},
			},
		});
	}

	test('declines a persisted settlement with a non-hex head', async () => {
		await replaySettling('-e', HEX40);

		// No resume was handed to the merge: the reconciliation branch would have
		// recorded a `preserved` outcome (see the two cases below). Instead the
		// dispatch took the fresh-merge branch, which the ledger then refuses to
		// re-provenance while the stale `settling` heads are stored.
		const record = findByCorrelationId(directory, 'resume-coder');
		expect(record?.coderSettlement?.state).toBe('settling');
		expect(record?.coderSettlement?.outcome).toBeUndefined();
		expect(record?.coderSettlement?.sourceHeadAfterCommit).toBe('-e');
		expect(fs.existsSync(path.join(directory, 'resume.ts'))).toBe(false);
	});

	test('accepts a 40-hex persisted settlement and resumes reconciliation', async () => {
		await replaySettling(HEX40, HEX40);

		// Resume was taken: reconciliation ran against heads git cannot resolve and
		// the worktree was preserved rather than merged fresh.
		const record = findByCorrelationId(directory, 'resume-coder');
		expect(record?.coderSettlement?.state).toBe('preserved');
		expect(record?.coderSettlement?.outcome?.result).toBe('failed');
		expect(fs.existsSync(worktreePath)).toBe(true);
	});

	test('accepts a 64-hex persisted settlement so sha256 repositories still resume', async () => {
		await replaySettling(HEX64, HEX64);

		const record = findByCorrelationId(directory, 'resume-coder');
		expect(record?.coderSettlement?.state).toBe('preserved');
		expect(fs.existsSync(worktreePath)).toBe(true);
	});
});
