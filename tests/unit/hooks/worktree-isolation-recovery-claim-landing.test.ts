/**
 * Issue #3494 — the recovery-claim path threads the dispatch's landing intent
 * into recoverMergeBackFromImmutableCoordinates using the same mapping as the
 * reconciliation path (merge.ts): a 'merge' recovery without a landing
 * decision lands squash-unstaged (HEAD unmoved, lane bytes unstaged, lane
 * branch retained as user-work backup); an open epic's commit landing lands as
 * a commit carrying the epic's task-scoped message (a caller landing without
 * an epic is a plain `git merge --no-edit`); an epic dirty-index refusal fails
 * preserved before provenance/onBeforeMerge.
 *
 * #3577 (PRR-001/PRR-002): the unstaged leg drives the REAL worktree cleanup
 * (removeWorktree + postMergeCleanup delegated to their real implementations
 * against a REAL registered `git worktree`) with the PRODUCTION lane branch
 * identity, and asserts the settlement terminal — finalize (not release) —
 * plus the retained production branch. The committed/refusal legs keep the
 * seam mocks: they pin option threading and ordering, not cleanup.
 *
 * Selector groups (frozen -t filters): 'unstaged' and 'commit landing'.
 */
import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { $ } from 'bun';
import { EPIC_LANDING_INDEX_STAGE } from '../../../src/epic/task-landing';
import {
	_internals as _wti,
	awaitingMergeByCallID,
	finishStandardWorktreeDispatch,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recoverMergeBackFromImmutableCoordinates } from '../../../src/worktree/merge';

const PRODUCTION_LANE_BRANCH = 'swarm/lane/parent-1/task-1';

const git = async (cwd: string, ...args: string[]): Promise<string> => {
	const r = await $`git -C ${cwd} ${args}`.quiet();
	if (r.exitCode !== 0)
		throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};

interface ClaimFixture {
	root: string;
	primary: string;
	laneBranch: string;
	coords: {
		sourceBaseOid: string;
		sourceHeadOid: string;
		targetHeadOid: string;
		strategy: 'merge';
	};
	headBefore: string;
}

/** B --- L (lane); primary HEAD = M2 (B's child) — a true 2-way merge shape. */
const buildClaimFixture = async (
	name: string,
	laneBranch = 'lane',
): Promise<ClaimFixture> => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
	const primary = path.join(root, 'primary');
	fs.mkdirSync(primary, { recursive: true });
	await git(primary, 'init', '-q', '-b', 'main');
	await git(primary, 'config', 'user.email', 'check@local');
	await git(primary, 'config', 'user.name', 'check');
	fs.writeFileSync(path.join(primary, 'base.txt'), 'base\n');
	await git(primary, 'add', '.');
	await git(primary, 'commit', '-q', '-m', 'base');
	const B = await git(primary, 'rev-parse', 'HEAD');
	await git(primary, 'checkout', '-q', '-b', laneBranch);
	fs.writeFileSync(path.join(primary, 'lane.txt'), 'lane work\n');
	await git(primary, 'add', '.');
	await git(primary, 'commit', '-q', '-m', 'lane work');
	const L = await git(primary, 'rev-parse', 'HEAD');
	await git(primary, 'checkout', '-q', 'main');
	fs.writeFileSync(path.join(primary, 'primary.txt'), 'primary work\n');
	await git(primary, 'add', '.');
	await git(primary, 'commit', '-q', '-m', 'primary work');
	const M2 = await git(primary, 'rev-parse', 'HEAD');
	return {
		root,
		primary,
		laneBranch,
		coords: {
			sourceBaseOid: B,
			sourceHeadOid: L,
			targetHeadOid: M2,
			strategy: 'merge' as const,
		},
		headBefore: M2,
	};
};

interface Seams {
	calls: unknown[][];
	dispatch: Record<string, unknown>;
	counters: {
		finalize: number;
		release: number;
		remove: number;
		postMerge: number;
	};
	restore: () => void;
}

const installClaimSeams = (
	fx: ClaimFixture,
	callID: string,
	opts?: { realCleanup?: boolean; worktreePath?: string },
): Seams => {
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	ensureAgentSession('parent-1');
	const worktreePath = opts?.worktreePath ?? path.join(fx.root, '.wt-fixture');
	const dispatch = {
		callID,
		parentSessionID: 'parent-1',
		taskId: 'task-1',
		planTaskId: '2.1',
		handle: {
			worktreePath,
			branchName: fx.laneBranch,
			purpose: 'lane',
			id: 'task-1',
			sessionId: 'parent-1',
		},
		mergeStrategy: 'merge',
		laneIndex: 0,
		recoveryClaim: {
			authorityDigest: `digest-${callID}`,
			claimRevision: 1,
			rawToken: `tok-${callID}`,
			coordinates: fx.coords,
		},
	} as never;
	awaitingMergeByCallID.set(callID, {
		callID,
		parentSessionID: 'parent-1',
		taskId: 'task-1',
		planTaskId: '2.1',
		branch: fx.laneBranch,
		worktreePath,
		mergeStrategy: 'merge',
		queuedAt: 1,
	});
	const originals = {
		renew: _wti.renewWorktreeRecoveryClaim,
		release: _wti.releaseWorktreeRecoveryClaim,
		finalize: _wti.finalizeWorktreeRecoveryAuthority,
		remove: _wti.removeWorktree,
		postMergeCleanup: _wti.postMergeCleanup,
		attemptDirty: _wti.attemptMergeBackFromDirty,
		recover: _wti.recoverMergeBackFromImmutableCoordinates,
		epic: _wti.epicCommitLandingFor,
	};
	const authority = { schemaVersion: 2, authorityDigest: `digest-${callID}` };
	const counters = { finalize: 0, release: 0, remove: 0, postMerge: 0 };
	_wti.renewWorktreeRecoveryClaim = (() => ({ ok: true, authority })) as never;
	_wti.releaseWorktreeRecoveryClaim = (() => {
		counters.release += 1;
		return { ok: true, authority };
	}) as never;
	_wti.finalizeWorktreeRecoveryAuthority = (() => {
		counters.finalize += 1;
		return { ok: true, authority: { ...authority, status: 'finalized' } };
	}) as never;
	if (opts?.realCleanup) {
		// Delegate to the REAL cleanup primitives (call-counted): the leg
		// asserts the settlement terminal against the real retainBranch
		// behavior of a real registered worktree.
		_wti.removeWorktree = (async (...args: unknown[]) => {
			counters.remove += 1;
			return (originals.remove as (...a: unknown[]) => unknown)(
				...args,
			) as never;
		}) as never;
		_wti.postMergeCleanup = (async (...args: unknown[]) => {
			counters.postMerge += 1;
			return (originals.postMergeCleanup as (...a: unknown[]) => unknown)(
				...args,
			) as never;
		}) as never;
	} else {
		_wti.removeWorktree = (async () => ({
			success: true,
		})) as never;
		_wti.postMergeCleanup = (async () => ({
			cleaned: true,
		})) as never;
	}
	_wti.attemptMergeBackFromDirty = (async () => {
		throw new Error('claim path must not call attemptMergeBackFromDirty');
	}) as never;
	const calls: unknown[][] = [];
	_wti.recoverMergeBackFromImmutableCoordinates = (async (
		d: string,
		c: unknown,
		o: unknown,
	) => {
		calls.push([d, c, o]);
		return originals.recover(d, c as never, o as never);
	}) as never;
	return {
		calls,
		dispatch: dispatch as Record<string, unknown>,
		counters,
		restore: () => {
			Object.assign(_wti, {
				renewWorktreeRecoveryClaim: originals.renew,
				releaseWorktreeRecoveryClaim: originals.release,
				finalizeWorktreeRecoveryAuthority: originals.finalize,
				removeWorktree: originals.remove,
				postMergeCleanup: originals.postMergeCleanup,
				attemptMergeBackFromDirty: originals.attemptDirty,
				recoverMergeBackFromImmutableCoordinates: originals.recover,
				epicCommitLandingFor: originals.epic,
			});
			awaitingMergeByCallID.delete(callID);
			resetStandardWorktreeIsolationState();
			resetSwarmState();
			fs.rmSync(fx.root, { recursive: true, force: true });
		},
	};
};

describe('recovery-claim landing shape', () => {
	it('unstaged: no landing decision threads {landUnstaged:true}, lands squash-unstaged with REAL cleanup, and FINALIZES the claim (branch retained)', async () => {
		// PRR-001/PRR-002 discriminator: production lane branch identity, a
		// real registered `git worktree`, and the real cleanup primitives —
		// the assertion fails under release-on-squash or if the retained
		// branch were deleted.
		const fx = await buildClaimFixture(
			'claim-landing-unstaged-',
			PRODUCTION_LANE_BRANCH,
		);
		const worktreePath = path.join(fx.root, 'wt-lane');
		await git(fx.primary, 'worktree', 'add', worktreePath, fx.laneBranch);
		const seams = installClaimSeams(fx, 'call-unstaged', {
			realCleanup: true,
			worktreePath,
		});
		try {
			const result = (await finishStandardWorktreeDispatch(
				fx.primary,
				seams.dispatch as never,
				undefined,
				'call-unstaged',
				{}, // no landing decision, no epic (real epicCommitLandingFor → undefined)
			)) as { outcome: string; strategy?: string };

			expect(seams.calls.length).toBe(1);
			const [dir, coords, options] = seams.calls[0] as [
				string,
				unknown,
				Record<string, unknown> | undefined,
			];
			expect(dir).toBe(fx.primary);
			expect(coords).toEqual(fx.coords);
			expect(options?.landUnstaged).toBe(true);
			expect(options?.landingCommitMessage).toBeUndefined();
			expect(result.outcome).toBe('merged');
			expect(result.strategy).toBe('squash-unstaged');
			// no new commit on HEAD; lane bytes unstaged in the primary tree
			expect(await git(fx.primary, 'rev-parse', 'HEAD')).toBe(fx.headBefore);
			// REAL cleanup ran: worktree removed, postMergeCleanup SKIPPED
			// (#2508 retention keeps the lane branch)
			expect(seams.counters.remove).toBe(1);
			expect(seams.counters.postMerge).toBe(0);
			expect(fs.existsSync(worktreePath)).toBe(false);
			// #3494 claim 5, now discriminating (PRR-002): the retained
			// PRODUCTION lane branch keeps the lane commit reachable
			expect(await git(fx.primary, 'rev-parse', fx.laneBranch)).toBe(
				fx.coords.sourceHeadOid,
			);
			// PRR-001: the settlement terminal keys on the landed outcome —
			// finalize (not release) even with the retained branch
			expect(seams.counters.finalize).toBe(1);
			expect(seams.counters.release).toBe(0);
			const status = await git(fx.primary, 'status', '--porcelain');
			expect(status).toContain('lane.txt');
			expect(
				fs.readFileSync(path.join(fx.primary, 'lane.txt'), 'utf8').trim(),
			).toBe('lane work');
		} finally {
			seams.restore();
		}
	});

	it('commit landing: an open epic commit landing threads {landingCommitMessage} and NOT landUnstaged', async () => {
		const fx = await buildClaimFixture('claim-landing-epic-');
		const seams = installClaimSeams(fx, 'call-epic');
		const EPIC_MESSAGE = 'Epic-C3 exact task landing marker';
		const origEpic = _wti.epicCommitLandingFor;
		try {
			_wti.epicCommitLandingFor = (() => ({
				commitLanding: true,
				landingCommitMessage: EPIC_MESSAGE,
			})) as never;
			const result = (await finishStandardWorktreeDispatch(
				fx.primary,
				seams.dispatch as never,
				undefined,
				'call-epic',
				{}, // no caller landing decision → the epic provides it
			)) as { outcome: string; strategy?: string };

			expect(seams.calls.length).toBe(1);
			const [, , options] = seams.calls[0] as [
				string,
				unknown,
				Record<string, unknown> | undefined,
			];
			expect(options?.landUnstaged).toBeUndefined();
			expect(options?.landingCommitMessage).toBe(EPIC_MESSAGE);
			expect(result.outcome).toBe('merged');
			expect(result.strategy).toBe('merge');
			// committed landing: HEAD moves with a 2-parent merge carrying the message
			const headAfter = await git(fx.primary, 'rev-parse', 'HEAD');
			expect(headAfter).not.toBe(fx.headBefore);
			expect(
				(await git(fx.primary, 'log', '-1', '--format=%P')).split(' ').length,
			).toBe(2);
			expect(await git(fx.primary, 'log', '-1', '--format=%s')).toBe(
				EPIC_MESSAGE,
			);
		} finally {
			_wti.epicCommitLandingFor = origEpic;
			seams.restore();
		}
	});

	it('commit landing: a caller settlement.commitLanding lands committed (shape pinned, no epic — plain merge --no-edit, no message)', async () => {
		const fx = await buildClaimFixture('claim-landing-caller-');
		const seams = installClaimSeams(fx, 'call-caller');
		try {
			const result = (await finishStandardWorktreeDispatch(
				fx.primary,
				seams.dispatch as never,
				undefined,
				'call-caller',
				{ commitLanding: true }, // caller-supplied; no epic (→ undefined message: plain merge --no-edit)
			)) as { outcome: string; strategy?: string };

			expect(seams.calls.length).toBe(1);
			const [, , options] = seams.calls[0] as [
				string,
				unknown,
				Record<string, unknown> | undefined,
			];
			expect(options?.landUnstaged).toBeUndefined();
			expect(options?.landingCommitMessage).toBeUndefined();
			expect(result.outcome).toBe('merged');
			expect(result.strategy).toBe('merge');
			expect(await git(fx.primary, 'rev-parse', 'HEAD')).not.toBe(
				fx.headBefore,
			);
		} finally {
			seams.restore();
		}
	});

	it('epic refusal fails preserved BEFORE provenance/onBeforeMerge on the claim path', async () => {
		const fx = await buildClaimFixture('claim-landing-refused-');
		const seams = installClaimSeams(fx, 'call-refused');
		const origEpic = _wti.epicCommitLandingFor;
		try {
			// PRR-010: use the production stage constant (the arm forwards
			// epicLanding.stage verbatim) so the assertion discriminates.
			_wti.epicCommitLandingFor = (() => ({
				refused: true,
				stage: EPIC_LANDING_INDEX_STAGE,
				message: 'epic index dirty; lane preserved until re-land',
			})) as never;
			let onBeforeMergeFired = 0;
			const result = (await finishStandardWorktreeDispatch(
				fx.primary,
				seams.dispatch as never,
				undefined,
				'call-refused',
				{
					onBeforeMerge: () => {
						onBeforeMergeFired += 1;
					},
				},
			)) as { outcome: string; stage?: string };

			expect(onBeforeMergeFired).toBe(0); // resolve-before-merge ordering
			expect(seams.calls.length).toBe(0); // the primitive never ran
			expect(result.outcome).toBe('failed');
			expect(result.stage).toBe(EPIC_LANDING_INDEX_STAGE);
		} finally {
			_wti.epicCommitLandingFor = origEpic;
			seams.restore();
		}
	});
});
