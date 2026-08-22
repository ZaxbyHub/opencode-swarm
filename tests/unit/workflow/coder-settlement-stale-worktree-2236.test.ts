/**
 * Issue #2236 F0b/F0e — recovering a coder settlement whose lane worktree
 * directory is gone.
 *
 * REGRESSION SHAPE. `update_task_status` -> `recoverCoderSettlement`
 * reconstructs a dispatch from the durable WAL and hands
 * `descriptor.worktreePath` to git as a spawn `cwd` without checking it still
 * exists. Under Bun the spawn threw synchronously, the throw escaped uncaught,
 * and the raw `ENOENT: no such file or directory, posix_spawn 'git'` reached
 * the user looking like "git is missing". git was never missing.
 *
 * FIXTURE REQUIREMENT (the naive fixture cannot reach the bug). A WAL whose
 * `worktreePath` merely "does not exist" never reaches `merge.ts`: it is gated
 * twice, by `wal.observedFiles` (else `CODER_SETTLEMENT_RECOVERY_UNCERTAIN`
 * throws first) and by `wal.mergeProvenance` (the failing line lives inside the
 * provenance branch). Both are persisted together inside `onBeforeMerge`, so
 * the fixture below is a WAL interrupted AFTER `onBeforeMerge` ran —
 * `recordCoderMergeProvenance` writes exactly that pair.
 *
 * The lane directory is deleted with `rm`, NOT `git worktree remove`, so the
 * stale registration survives — the state that also makes `git branch -d` fail
 * with "cannot delete branch 'X' used by worktree at ..." (BR-2).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTaskWorkflowSnapshot } from '../../../src/gate-evidence';
import {
	awaitingMergeByCallID,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { scanWorktreeProvisioningOwnersForRecovery } from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import {
	_internals,
	recordCoderMergeProvenance,
	recoverCoderSettlement,
} from '../../../src/workflow/coder-settlement';
import {
	branchExists,
	createStaleWorktreeFixture,
	type Fixture,
	git,
	readWal,
	STALE_WORKTREE_TASK_ID as TASK_ID,
	walPath,
} from '../../helpers/stale-worktree-2236';

const roots: string[] = [];

beforeEach(() => {
	clearDeferredWarnings();
	_internals.liveDispatches.clear();
	standardWorktreeByCallID.clear();
	awaitingMergeByCallID.clear();
});

afterEach(() => {
	clearDeferredWarnings();
	_internals.liveDispatches.clear();
	standardWorktreeByCallID.clear();
	awaitingMergeByCallID.clear();
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

async function interruptedAfterOnBeforeMerge(label: string): Promise<Fixture> {
	const fixture = await createStaleWorktreeFixture(label);
	roots.push(fixture.root);
	// The coder committed its work inside the lane worktree...
	fs.writeFileSync(
		path.join(fixture.worktree, 'src', 'nested', 'feature.ts'),
		'export const feature = 2;\n',
	);
	git(fixture.worktree, ['add', '.']);
	git(fixture.worktree, ['commit', '-m', 'feat: isolated mutation']);
	// ...and `onBeforeMerge` persisted provenance + observed files, then the
	// process died before the merge ran.
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

describe('issue #2236 stale lane worktree recovery', () => {
	test('the merge is recovered from the branch when the directory is gone', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('recover');
		// Delete the directory but leave the registration stale.
		fs.rmSync(fixture.worktree, { recursive: true, force: true });
		expect(fs.existsSync(fixture.worktree)).toBe(false);
		expect(branchExists(fixture)).toBe(true);

		// Before the fix this rejected with the raw
		// `ENOENT ... posix_spawn 'git'` message.
		const recovered = await recoverCoderSettlement(fixture.repo, TASK_ID);

		expect(recovered).toMatchObject({ accepted: true });
		expect(getTaskWorkflowSnapshot(recovered?.evidence ?? null)).toMatchObject({
			state: 'coder_delegated',
			lastTransitionId: fixture.transitionId,
		});
		// The coder's commit really landed in the primary tree — the whole point
		// of recovering rather than self-healing.
		expect(
			fs.readFileSync(
				path.join(fixture.repo, 'src', 'nested', 'feature.ts'),
				'utf8',
			),
		).toContain('feature = 2');
	});

	test('cleanup leaves no branch behind even though the directory was already gone', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('cleanup');
		fs.rmSync(fixture.worktree, { recursive: true, force: true });

		await recoverCoderSettlement(fixture.repo, TASK_ID);

		// BR-2: without pruning the stale registration first, `git branch -d`
		// fails with "cannot delete branch ... used by worktree at ...",
		// `cleanupRecoveredWorktree` then throws
		// CODER_SETTLEMENT_WORKTREE_CLEANUP_UNVERIFIED, and the reported
		// deadlock returns under a different message.
		expect(branchExists(fixture)).toBe(false);
		expect(fs.existsSync(fixture.worktree)).toBe(false);
		expect(readWal(fixture)).toMatchObject({
			state: 'COMMITTED',
			cleanupComplete: true,
		});
		expect(scanWorktreeProvisioningOwnersForRecovery(fixture.repo)).toEqual({
			status: 'ok',
			owners: [],
		});
	});

	test('the repair is visible: a warning names the stale worktree and the branch', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('warn');
		fs.rmSync(fixture.worktree, { recursive: true, force: true });

		await recoverCoderSettlement(fixture.repo, TASK_ID);

		const warnings = getDeferredWarnings().join('\n');
		expect(warnings).toContain('STALE_LANE_WORKTREE_DETECTED');
		expect(warnings).toContain(fixture.worktree);
		expect(warnings).toContain(fixture.branch);
	});

	test('recovery is idempotent — a second pass is a stable no-op', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('idempotent');
		fs.rmSync(fixture.worktree, { recursive: true, force: true });

		await recoverCoderSettlement(fixture.repo, TASK_ID);
		const walAfter = fs.readFileSync(walPath(fixture), 'utf8');

		expect(await recoverCoderSettlement(fixture.repo, TASK_ID)).toBeNull();
		expect(fs.readFileSync(walPath(fixture), 'utf8')).toBe(walAfter);
	});

	test('a live worktree still takes the unchanged path', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('live');
		// Directory intact: no gone-mode, no relocation, no extra prune.
		const recovered = await recoverCoderSettlement(fixture.repo, TASK_ID);

		expect(recovered).toMatchObject({ accepted: true });
		expect(getDeferredWarnings().join('\n')).not.toContain(
			'STALE_LANE_WORKTREE_DETECTED',
		);
		expect(branchExists(fixture)).toBe(false);
	});

	test('a stale-provenance merge is still refused when the directory is gone', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('provenance-guard');
		// The lane branch moves after provenance was written. BR-1: the guard is
		// RELOCATED to the primary repo, never dropped — the recovery path is the
		// only path that carries it.
		fs.writeFileSync(
			path.join(fixture.worktree, 'src', 'nested', 'feature.ts'),
			'export const feature = 3;\n',
		);
		git(fixture.worktree, ['add', '.']);
		git(fixture.worktree, ['commit', '-m', 'feat: later commit']);
		fs.rmSync(fixture.worktree, { recursive: true, force: true });

		await expect(recoverCoderSettlement(fixture.repo, TASK_ID)).rejects.toThrow(
			'CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED',
		);
		// Fail closed: nothing was merged, the branch is untouched, and the WAL
		// stays recoverable rather than terminal.
		expect(branchExists(fixture)).toBe(true);
		expect(readWal(fixture)).toMatchObject({ state: 'DISPATCHED' });
	});
});

describe('#2236 concurrent recovery of a stale lane worktree', () => {
	test('a second recovery entering under the lock neither double-merges nor double-heals', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('concurrent');
		fs.rmSync(fixture.worktree, { recursive: true, force: true });

		const outcomes = await Promise.allSettled([
			recoverCoderSettlement(fixture.repo, TASK_ID),
			recoverCoderSettlement(fixture.repo, TASK_ID),
		]);

		// `recoverCoderSettlement` runs under `withSettlementLock`
		// (src/workflow/coder-settlement.ts:72-93), which calls
		// `tryAcquireLock` (src/parallel/file-locks.ts:143-198). That, in turn,
		// hands `proper-lockfile` a `retries: { retries: 5, minTimeout: 10,
		// maxTimeout: 500, factor: 2 }` backoff (file-locks.ts:169-178) — the
		// lock is NOT reentrant, but it is also NOT fail-fast: a contended
		// caller retries with exponential backoff for up to ~310ms before
		// `tryAcquireLock` reports `acquired: false` and
		// `withSettlementLock` throws `CODER_SETTLEMENT_LOCKED`
		// (coder-settlement.ts:85-87). Measured empirically (7 runs): because
		// this fixture's merge is fast, the second caller's retries always
		// land inside that budget, so BOTH promises fulfil — there is no
		// rejection in practice. That is timing-dependent, not a documented
		// guarantee, so this test does not pin the fulfil/reject split.
		// Instead it asserts the invariant that must hold under EITHER
		// ordering: exactly one caller performs the real merge, and the
		// other either (a) re-enters after the winner released the lock,
		// finds `wal.state === 'COMMITTED'`, and returns `null` as a no-op
		// (coder-settlement.ts:810-816), or (b) is turned away by the lock
		// with `CODER_SETTLEMENT_LOCKED`. There is no third outcome — in
		// particular, never a second real merge.
		const winners = outcomes.filter(
			(o) => o.status === 'fulfilled' && o.value !== null,
		);
		const idempotentNoops = outcomes.filter(
			(o) => o.status === 'fulfilled' && o.value === null,
		);
		const lockRejections = outcomes.filter(
			(o) =>
				o.status === 'rejected' &&
				String((o as PromiseRejectedResult).reason).includes(
					'CODER_SETTLEMENT_LOCKED',
				),
		);
		expect(winners).toHaveLength(1);
		expect(idempotentNoops.length + lockRejections.length).toBe(1);
		// No outcome falls outside those three buckets (e.g. a second winner,
		// or a rejection for a different reason).
		expect(
			winners.length + idempotentNoops.length + lockRejections.length,
		).toBe(outcomes.length);

		// End state is indistinguishable from a single run.
		expect(readWal(fixture)).toMatchObject({
			state: 'COMMITTED',
			cleanupComplete: true,
		});
		expect(branchExists(fixture)).toBe(false);
		const merges = git(fixture.repo, [
			'log',
			'--format=%s',
			'--all-match',
			'--grep=isolated mutation',
		])
			.split('\n')
			.filter((line) => line.trim().length > 0);
		expect(merges).toHaveLength(1);
	});
});
