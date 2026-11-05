/**
 * Issue #3494 — the recovery-claim path threads the dispatch's landing intent
 * into recoverMergeBackFromImmutableCoordinates using the same mapping as the
 * reconciliation path (merge.ts): a 'merge' recovery without a commit landing
 * lands squash-unstaged (HEAD unmoved, lane bytes unstaged); with an epic or
 * caller commit landing it lands as a commit carrying that message.
 *
 * Selector groups (frozen -t filters): 'unstaged' and 'commit landing'.
 *
 * Harness: drives the REAL finishStandardWorktreeDispatch claim arm on a real
 * git primary (B←L lane branch, B←M2 primary); the 2105-suite seams mock
 * renew/release/finalize/remove/cleanup; a spy at
 * _internals.recoverMergeBackFromImmutableCoordinates delegates to the REAL
 * primitive so the landed shape is asserted on real git state.
 * attemptMergeBackFromDirty throws if called (proves the claim arm ran).
 */
import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { $ } from 'bun';
import {
	_internals as _wti,
	awaitingMergeByCallID,
	finishStandardWorktreeDispatch,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recoverMergeBackFromImmutableCoordinates } from '../../../src/worktree/merge';

const git = async (cwd: string, ...args: string[]): Promise<string> => {
	const r = await $`git -C ${cwd} ${args}`.quiet();
	if (r.exitCode !== 0)
		throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};

interface ClaimFixture {
	primary: string;
	coords: {
		sourceBaseOid: string;
		sourceHeadOid: string;
		targetHeadOid: string;
		strategy: 'merge';
	};
	headBefore: string;
}

/** B --- L (lane); primary HEAD = M2 (B's child) — a true 2-way merge shape. */
const buildClaimFixture = async (name: string): Promise<ClaimFixture> => {
	const primary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
	fs.mkdirSync(primary, { recursive: true });
	await git(primary, 'init', '-q', '-b', 'main');
	await git(primary, 'config', 'user.email', 'check@local');
	await git(primary, 'config', 'user.name', 'check');
	fs.writeFileSync(path.join(primary, 'base.txt'), 'base\n');
	await git(primary, 'add', '.');
	await git(primary, 'commit', '-q', '-m', 'base');
	const B = await git(primary, 'rev-parse', 'HEAD');
	await git(primary, 'checkout', '-q', '-b', 'lane');
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
		primary,
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
	restore: () => void;
}

const installClaimSeams = (fx: ClaimFixture, callID: string): Seams => {
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	ensureAgentSession('parent-1');
	const dispatch = {
		callID,
		parentSessionID: 'parent-1',
		taskId: 'task-1',
		planTaskId: '2.1',
		handle: {
			worktreePath: path.join(fx.primary, '.wt-fixture'),
			branchName: 'swarm/lane/parent-1/task-1',
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
		branch: 'swarm/lane/parent-1/task-1',
		worktreePath: path.join(fx.primary, '.wt-fixture'),
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
	_wti.renewWorktreeRecoveryClaim = (() => ({ ok: true, authority })) as never;
	_wti.releaseWorktreeRecoveryClaim = (() => ({
		ok: true,
		authority,
	})) as never;
	_wti.finalizeWorktreeRecoveryAuthority = (() => ({
		ok: true,
		authority: { ...authority, status: 'finalized' },
	})) as never;
	_wti.removeWorktree = (async () => ({ success: true })) as never;
	_wti.postMergeCleanup = (async () => ({ cleaned: true })) as never;
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
			fs.rmSync(fx.primary, { recursive: true, force: true });
		},
	};
};

describe('recovery-claim landing shape', () => {
	it('unstaged: no commitLanding threads {landUnstaged:true} and lands squash-unstaged', async () => {
		const fx = await buildClaimFixture('claim-landing-unstaged-');
		const seams = installClaimSeams(fx, 'call-unstaged');
		try {
			const result = (await finishStandardWorktreeDispatch(
				fx.primary,
				seams.dispatch as never,
				undefined,
				'call-unstaged',
				{}, // no commitLanding, no epic (real epicCommitLandingFor → undefined)
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
			// #3494 claim 5 (was INFERENCE): the preserved source ref RETAINS the
			// lane commit — the unstaged bytes stay recognizable through it
			expect(await git(fx.primary, 'rev-parse', 'lane')).toBe(
				fx.coords.sourceHeadOid,
			);
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
				{}, // no caller commitLanding → the epic provides it
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

	it('commit landing: a caller settlement.commitLanding lands committed (shape pinned, no epic)', async () => {
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
			expect('landingCommitMessage' in (options ?? {})).toBe(true);
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
			_wti.epicCommitLandingFor = (() => ({
				refused: true,
				stage: 'epic-landing-index-dirty',
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
			expect(result.stage).toBe('epic-landing-index-dirty');
		} finally {
			_wti.epicCommitLandingFor = origEpic;
			seams.restore();
		}
	});
});
