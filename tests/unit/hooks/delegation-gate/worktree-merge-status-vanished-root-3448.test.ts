/**
 * Issue #3448 — `saveDurableStatus` must never resurrect a vanished lane root.
 *
 * A coder child session's delegation gate binds the durable-status singleton to
 * its own working directory: the lane worktree. When that worktree (and the lane
 * branch) are later removed while the settlement WAL is still DISPATCHED, the
 * failed `/swarm recover` re-attempt records a `source-worktree-gone` failure —
 * and the pre-#3448 recursive `mkdirSync` recreated the vanished lane root just
 * to hold its own failure-status file. `selfHealMissingLaneWorktree`
 * (coder-settlement.ts) keys on that root's absence, so the resurrection
 * permanently blocked the self-heal and every recover threw
 * CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED.
 *
 * The end-to-end arms below reuse the #2236 stale-worktree fixture with the ONE
 * production condition every prior suite omitted: the durable-status singleton
 * bound to the removed lane worktree's path at recovery time (as a lane-instance
 * delegation gate leaves it).
 *
 * #3409/#3420 forward-compatibility: draft PR #3420 changes the self-heal
 * semantics for a lane whose auto-commit object is still alive (it throws the
 * designed RECOVERABLE_ORPHAN_COMMIT instead of healing). Arm A therefore pins
 * the CURRENT-tree contract on the alive-object fixture (this PR must land
 * before #3420; if #3420 lands first, the frozen C2 evidence is reconciled via
 * a sanctioned AMEND rather than ignored). Arm B pins only the #3448 invariant
 * with a whitelisted outcome, which holds on both trees. A PRUNED-object
 * fixture is deliberately NOT used: on the current tree `git gc --prune=now`
 * makes the recorded merge provenance unverifiable and recovery fails closed
 * with CODER_SETTLEMENT_RECOVERY_UNCERTAIN (verified by probe at
 * implementation time) — the pruned-object heal is #3420's work, not this
 * fix's, and pinning it here would be pinning the other PR's contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	awaitingMergeByCallID,
	standardWorktreeByCallID,
} from '../../../../src/hooks/delegation-gate/worktree-isolation.js';
import {
	clearWorktreeMergeStatus,
	getWorktreeMergeFailure,
	initDurableStatusPath,
	_internals as mergeStatusInternals,
	recordWorktreeMergeFailure,
} from '../../../../src/hooks/delegation-gate/worktree-merge-status.js';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer.js';
import {
	_internals,
	recordCoderMergeProvenance,
	recoverCoderSettlement,
} from '../../../../src/workflow/coder-settlement.js';
import {
	branchExists,
	createStaleWorktreeFixture,
	type Fixture,
	git,
	readWal,
	STALE_WORKTREE_TASK_ID as TASK_ID,
} from '../../../helpers/stale-worktree-2236.js';
import {
	canonicalMkdtemp,
	removeTreeWithRetry,
} from '../../../helpers/tmpdir.js';

const FAILURE = {
	outcome: 'failed' as const,
	stage: 'source-worktree-gone',
	message: 'test: nothing is recoverable',
	completedAt: 1_000,
};

const roots: string[] = [];

beforeEach(() => {
	clearDeferredWarnings();
	_internals.liveDispatches.clear();
	standardWorktreeByCallID.clear();
	awaitingMergeByCallID.clear();
	// Isolate the durable-status singleton BEFORE each test too, so a future
	// test that skips initDurableStatusPath cannot inherit the previous test's
	// bound path and lazily-reloaded registry.
	mergeStatusInternals.resetForTest();
});

afterEach(() => {
	clearDeferredWarnings();
	_internals.liveDispatches.clear();
	standardWorktreeByCallID.clear();
	awaitingMergeByCallID.clear();
	mergeStatusInternals.resetForTest();
	for (const root of roots.splice(0)) {
		// Real-git fixture roots: tolerate the Windows EBUSY/EPERM teardown class.
		removeTreeWithRetry(root);
	}
});

describe('#3448 saveDurableStatus never resurrects a vanished root', () => {
	test('a record whose status parent root is gone leaves the root absent and memory authoritative', () => {
		const root = canonicalMkdtemp('sw3448-unit-');
		roots.push(root);
		const lane = path.join(root, '.swarm-worktrees', 'ses_x', '1.1');
		fs.mkdirSync(path.join(lane, '.swarm'), { recursive: true });
		// The coder child session's delegation gate binds the singleton to the lane.
		initDurableStatusPath(lane);
		// The lane worktree is torn down while the settlement is still DISPATCHED.
		fs.rmSync(lane, { recursive: true, force: true });

		recordWorktreeMergeFailure('1.1', FAILURE);

		expect(fs.existsSync(lane)).toBe(false);
		expect(
			fs.existsSync(path.join(lane, '.swarm', 'worktree-merge-status.json')),
		).toBe(false);
		// AC1: the in-memory registry remains authoritative after the skipped write.
		expect(getWorktreeMergeFailure('1.1')).toMatchObject({
			stage: 'source-worktree-gone',
		});
	});

	test('a clear under the same vanished-root condition also does not resurrect', () => {
		const root = canonicalMkdtemp('sw3448-clear-');
		roots.push(root);
		const lane = path.join(root, '.swarm-worktrees', 'ses_y', '2.1');
		fs.mkdirSync(path.join(lane, '.swarm'), { recursive: true });
		initDurableStatusPath(lane);
		fs.rmSync(lane, { recursive: true, force: true });

		recordWorktreeMergeFailure('2.1', FAILURE);
		clearWorktreeMergeStatus('2.1');

		expect(fs.existsSync(lane)).toBe(false);
		expect(getWorktreeMergeFailure('2.1')).toBeUndefined();
	});

	test('a live root still gets .swarm created and the status persisted', () => {
		const root = canonicalMkdtemp('sw3448-live-');
		roots.push(root);
		initDurableStatusPath(root);

		recordWorktreeMergeFailure('9.9', FAILURE);

		const statusPath = path.join(root, '.swarm', 'worktree-merge-status.json');
		expect(fs.existsSync(statusPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as Record<
			string,
			unknown
		>;
		expect(parsed['9.9']).toMatchObject({ stage: 'source-worktree-gone' });
	});
});

/**
 * A WAL interrupted after `onBeforeMerge` — the only shape that reaches
 * merge.ts (copied from coder-settlement-selfheal-invariant-2236.test.ts).
 */
async function interruptedAfterOnBeforeMerge(label: string): Promise<Fixture> {
	const fixture = await createStaleWorktreeFixture(label);
	roots.push(fixture.root);
	fs.writeFileSync(
		path.join(fixture.worktree, 'src', 'nested', 'feature.ts'),
		'export const feature = 2;\n',
	);
	git(fixture.worktree, ['add', '.']);
	git(fixture.worktree, ['commit', '-m', 'feat: isolated mutation']);
	await recordCoderMergeProvenance({
		directory: fixture.repo,
		taskId: TASK_ID,
		transitionId: fixture.transitionId,
		provenance: {
			operationId: fixture.transitionId,
			sourceHead: git(fixture.worktree, ['rev-parse', 'HEAD']),
			targetHeadBefore: git(fixture.repo, ['rev-parse', 'HEAD']),
			branchName: fixture.branch,
			strategy: 'merge',
		},
		observedFiles: ['src/nested/feature.ts'],
	});
	_internals.liveDispatches.clear();
	return fixture;
}

/** Removes the lane directory, its stale registration, and the lane branch. */
function destroyWorktreeAndBranch(fixture: Fixture): void {
	fs.rmSync(fixture.worktree, { recursive: true, force: true });
	git(fixture.repo, ['worktree', 'prune']);
	git(fixture.repo, ['branch', '-D', fixture.branch]);
}

describe('#3448 recovery self-heal is not blocked by the status writer', () => {
	test('Arm A - current-tree contract: recover self-heals to ABORTED with the singleton lane-bound', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('heal-3448-contract');
		destroyWorktreeAndBranch(fixture);
		expect(branchExists(fixture)).toBe(false);
		// The production condition every prior suite omitted.
		initDurableStatusPath(fixture.worktree);

		await expect(
			recoverCoderSettlement(fixture.repo, TASK_ID),
		).resolves.toBeNull();

		expect(readWal(fixture)).toMatchObject({ state: 'ABORTED' });
		// The #3448 invariant proper: the lane root was not resurrected.
		expect(fs.existsSync(fixture.worktree)).toBe(false);
		const warnings = getDeferredWarnings().join('\n');
		expect(warnings).toContain('STALE_CODER_SETTLEMENT_SELF_HEALED');
	}, // Real git spawns + a full recovery loop: explicit ceiling so a bare
	// `bun test` (5s default) passes; CI's per-file budget is 120s anyway.
	120_000);

	test('Arm B - #3420-tolerant invariant: the lane root stays absent and the loop error never returns', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('heal-3448-alive');
		destroyWorktreeAndBranch(fixture);
		expect(branchExists(fixture)).toBe(false);
		initDurableStatusPath(fixture.worktree);

		let thrown: string | undefined;
		try {
			await recoverCoderSettlement(fixture.repo, TASK_ID);
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		}

		// The #3448 invariant: no resurrected lane root.
		expect(fs.existsSync(fixture.worktree)).toBe(false);
		if (thrown === undefined) {
			// No-throw path (this PR's tree): the recovery healed — pin the full
			// terminal contract so a silent null-return with the WAL left
			// DISPATCHED cannot pass.
			expect(readWal(fixture)).toMatchObject({ state: 'ABORTED' });
			expect(getDeferredWarnings().join('\n')).toContain(
				'STALE_CODER_SETTLEMENT_SELF_HEALED',
			);
		} else {
			// Whitelisted throw path (a #3409/#3420-carrying tree): ONLY the
			// designed RECOVERABLE_ORPHAN_COMMIT is acceptable, and the message
			// must not smuggle the self-defeating loop error alongside it.
			expect(thrown).toContain('RECOVERABLE_ORPHAN_COMMIT');
			expect(thrown).not.toContain('CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED');
		}
	}, 120_000);
});
