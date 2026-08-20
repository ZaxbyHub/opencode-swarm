/**
 * Issue #2236 F0b — the invariant whose violation loses user work.
 *
 * > **The WAL is NEVER marked terminal while the lane branch exists, or while
 * > its existence is INDETERMINATE.**
 *
 * Marking terminal with the branch alive strands the coder's commits on an
 * orphan branch the user has no pointer to. "Cannot tell" is not "gone", so it
 * fails closed exactly like `cwd-unreadable`. The guard is enforced at the
 * mutation site in `coder-settlement.ts` — it re-probes rather than trusting
 * the stage string `merge.ts` handed it.
 *
 * The branch probe is driven through `_internals.branchExists` rather than by
 * breaking the fixture's `.git`: an unusable `.git` also breaks every other
 * git call, so `merge.ts` would return the *uncertain* stage and control would
 * never reach the guard under test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

const realBranchExists = _internals.branchExists;
const roots: string[] = [];

beforeEach(() => {
	clearDeferredWarnings();
	_internals.liveDispatches.clear();
	standardWorktreeByCallID.clear();
	awaitingMergeByCallID.clear();
});

afterEach(() => {
	_internals.branchExists = realBranchExists;
	clearDeferredWarnings();
	_internals.liveDispatches.clear();
	standardWorktreeByCallID.clear();
	awaitingMergeByCallID.clear();
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/** A WAL interrupted after `onBeforeMerge` — the only shape that reaches merge.ts. */
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

describe('#2236 self-heal only when nothing is recoverable', () => {
	test('worktree gone AND branch gone: the WAL is healed to terminal and the task unblocks', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('heal');
		destroyWorktreeAndBranch(fixture);
		expect(branchExists(fixture)).toBe(false);

		// Before the fix this rejected forever, deterministically, on every retry.
		expect(await recoverCoderSettlement(fixture.repo, TASK_ID)).toBeNull();

		const wal = readWal(fixture);
		expect(wal).toMatchObject({ state: 'ABORTED', cleanupComplete: true });
		expect(String(wal.abortReason)).toContain(
			'CODER_SETTLEMENT_SELF_HEALED_MISSING_WORKTREE',
		);
		expect(scanWorktreeProvisioningOwnersForRecovery(fixture.repo)).toEqual({
			status: 'ok',
			owners: [],
		});
	});

	test('the self-heal is not silent: the warning names task, worktree, branch, and WAL file', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('heal-warn');
		destroyWorktreeAndBranch(fixture);

		await recoverCoderSettlement(fixture.repo, TASK_ID);

		const warnings = getDeferredWarnings().join('\n');
		expect(warnings).toContain('STALE_CODER_SETTLEMENT_SELF_HEALED');
		expect(warnings).toContain(`task ${TASK_ID}`);
		expect(warnings).toContain(fixture.worktree);
		expect(warnings).toContain(fixture.branch);
		expect(warnings).toContain(walPath(fixture));
	});

	test('self-healing is idempotent', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('heal-idempotent');
		destroyWorktreeAndBranch(fixture);

		await recoverCoderSettlement(fixture.repo, TASK_ID);
		const walAfter = fs.readFileSync(walPath(fixture), 'utf8');

		expect(await recoverCoderSettlement(fixture.repo, TASK_ID)).toBeNull();
		expect(fs.readFileSync(walPath(fixture), 'utf8')).toBe(walAfter);
	});
});

describe('#2236 HARD INVARIANT: never terminal while the branch exists or is indeterminate', () => {
	test('branch EXISTS at the mutation site: refuses to self-heal, WAL stays recoverable', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('branch-alive');
		destroyWorktreeAndBranch(fixture);
		// The guard must re-probe and refuse even though merge.ts already
		// concluded "gone" — the mutation site owns this decision, not the
		// stage string it was handed.
		_internals.branchExists = () => true;

		await expect(recoverCoderSettlement(fixture.repo, TASK_ID)).rejects.toThrow(
			'CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED',
		);

		expect(readWal(fixture)).toMatchObject({ state: 'DISPATCHED' });
		expect(readWal(fixture).abortReason).toBeUndefined();
	});

	test('branch existence INDETERMINATE: fails closed, WAL stays recoverable', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('branch-uncertain');
		destroyWorktreeAndBranch(fixture);
		_internals.branchExists = () => {
			throw new Error(
				'CODER_SETTLEMENT_CLEANUP_UNCERTAIN: git show-ref exited with status 128',
			);
		};

		await expect(recoverCoderSettlement(fixture.repo, TASK_ID)).rejects.toThrow(
			'CODER_SETTLEMENT_CLEANUP_UNCERTAIN',
		);

		// "Cannot tell" must never destroy a branch or close a settlement.
		expect(readWal(fixture)).toMatchObject({ state: 'DISPATCHED' });
		expect(getDeferredWarnings().join('\n')).not.toContain(
			'STALE_CODER_SETTLEMENT_SELF_HEALED',
		);
	});

	test('a raw spawn error from the branch probe also fails closed', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('branch-spawn-error');
		destroyWorktreeAndBranch(fixture);
		const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
		err.code = 'ENOENT';
		_internals.branchExists = () => {
			throw err;
		};

		await expect(recoverCoderSettlement(fixture.repo, TASK_ID)).rejects.toThrow(
			'spawn git ENOENT',
		);
		expect(readWal(fixture)).toMatchObject({ state: 'DISPATCHED' });
	});

	test('a non-gone merge failure never reaches the self-heal at all', async () => {
		const fixture = await interruptedAfterOnBeforeMerge('not-gone');
		// Directory intact, but the branch moved after provenance was written:
		// the merge is refused at the reconciliation guard. Self-heal is keyed on
		// the gone stage, so this must stay a plain recoverable failure — and,
		// per the ordering invariant, must never reach branch deletion.
		fs.writeFileSync(
			path.join(fixture.worktree, 'src', 'nested', 'feature.ts'),
			'export const feature = 3;\n',
		);
		git(fixture.worktree, ['add', '.']);
		git(fixture.worktree, ['commit', '-m', 'feat: later commit']);

		await expect(recoverCoderSettlement(fixture.repo, TASK_ID)).rejects.toThrow(
			'CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED',
		);

		expect(readWal(fixture)).toMatchObject({ state: 'DISPATCHED' });
		expect(branchExists(fixture)).toBe(true);
		expect(fs.existsSync(fixture.worktree)).toBe(true);
	});
});
