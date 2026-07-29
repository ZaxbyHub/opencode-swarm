/**
 * Issue #1676 — settlement `reason` bound.
 *
 * Split from `pending-delegations-v3.test.ts` to keep both files under the
 * FR-006 500-line cap.
 *
 * These pin the bound that `settleCoder` clamps against (finding F-001). The
 * store drops an over-length reason silently and leaves the record stranded in
 * `settling`, so the clamp constant and the schema bound must stay in lockstep:
 * if they ever diverge, a preserved settlement is discarded without an error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimTerminalResult,
	findByCorrelationId,
	MAX_SETTLEMENT_REASON_CHARS,
	type RecordPendingInput,
	recordPendingDelegation,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function baseInput(dir: string): RecordPendingInput {
	return {
		correlationId: 'subagent-1',
		jobId: 'job-1',
		subagentSessionId: 'subagent-1',
		parentSessionId: 'parent-1',
		callID: 'call-1',
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		taskChangeContext: {
			declaredFiles: ['src/feature.ts'],
			baseline: {
				directory: dir,
				gitHead: 'base-head',
				dirtyHash: 'base-dirty',
				changedFiles: [],
				prHeadSha: 'pr-head',
				scope: '1.1',
			},
		},
		worktree: {
			callID: 'call-1',
			parentSessionId: 'parent-1',
			taskId: '1.1',
			planTaskId: '1.1',
			worktreePath: path.join(dir, '.swarm-worktrees', 'lane-1'),
			branchName: 'swarm/coder-parent-1',
			worktreeId: 'worktree-1',
			worktreeSessionId: 'parent-1',
			mergeStrategy: 'merge',
			laneIndex: 0,
			worktreeDir: '.swarm-worktrees',
		},
	};
}

describe('coder settlement reason bound', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('swarm-bg-settle-bounds-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		cleanup();
	});

	it('accepts a reason at the bound and silently drops one past it', async () => {
		await recordPendingDelegation(dir, baseInput(dir));
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'subagent-1',
			jobId: 'job-1',
			status: 'completed',
			resultDigest: 'digest',
		});
		await claimTerminalResult(dir, 'subagent-1', {
			eventId,
			status: 'completed',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'digest' },
		});
		await claimCoderSettlement(dir, 'subagent-1', 'operation-1');

		// Over the bound the whole durable write is discarded with no error and
		// the record is left stranded in `settling` — the trap F-001 fell into,
		// and the reason `settleCoder` must clamp before calling here.
		const pastBound = await updateCoderSettlement(dir, 'subagent-1', {
			operationId: 'operation-1',
			state: 'preserved',
			observedFiles: [],
			outcome: {
				kind: 'standard-worktree',
				result: 'partial',
				reason: 'x'.repeat(MAX_SETTLEMENT_REASON_CHARS + 1),
			},
		});
		expect(pastBound).toBeNull();
		expect(findByCorrelationId(dir, 'subagent-1')?.coderSettlement?.state).toBe(
			'settling',
		);

		// Exactly at the bound the settlement persists, so the clamp in
		// `settleCoder` cannot itself push a valid reason over the edge.
		const atBound = await updateCoderSettlement(dir, 'subagent-1', {
			operationId: 'operation-1',
			state: 'preserved',
			observedFiles: [],
			outcome: {
				kind: 'standard-worktree',
				result: 'partial',
				reason: 'x'.repeat(MAX_SETTLEMENT_REASON_CHARS),
			},
		});
		expect(atBound?.coderSettlement?.state).toBe('preserved');
		expect(findByCorrelationId(dir, 'subagent-1')?.coderSettlement?.state).toBe(
			'preserved',
		);
	});
});
