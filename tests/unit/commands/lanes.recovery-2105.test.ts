/**
 * /swarm lanes command — issue #2105 recovery visibility tests
 *
 * Covers:
 * - conflicted lanes surface v2 recovery identity and same-task redispatch
 * - claimed recoveries surface claimant state instead of manual-only guidance
 * - unsupported legacy recovery store falls back to explicit manual guidance
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleLanesCommand } from '../../../src/commands/lanes';
import { resetStandardWorktreeIsolationState } from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	initDurableStatusPath,
	_internals as mergeStatusInternals,
	recordWorktreeMergeFailure,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import {
	type ClaimWorktreeRecoveryAuthorityResult,
	claimWorktreeRecoveryAuthority,
	type PublishWorktreeRecoveryAuthorityResult,
	publishWorktreeRecoveryAuthority,
} from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function hex40(fill: string): string {
	return fill.repeat(40);
}

function addConflictedLane(args: {
	taskId: string;
	worktreePath: string;
	branch: string;
	stage?: string;
	message?: string;
	outcome?: 'partial' | 'failed';
}): void {
	recordWorktreeMergeFailure(args.taskId, {
		outcome: args.outcome ?? 'failed',
		stage: args.stage ?? 'merge',
		message: args.message ?? 'merge-back failed',
		worktreePath: args.worktreePath,
		branch: args.branch,
	});
}

function publishAuthority(
	directory: string,
	overrides: Partial<
		Parameters<typeof publishWorktreeRecoveryAuthority>[1]
	> = {},
): Extract<PublishWorktreeRecoveryAuthorityResult, { ok: true }>['authority'] {
	const published = publishWorktreeRecoveryAuthority(directory, {
		originalCallID: 'call-A',
		parentSessionId: 'session-A',
		taskId: 'task-2105',
		reservationId: 'reservation-A',
		generation: 4,
		canonicalBranch: 'main',
		canonicalPath: directory,
		laneBranch: 'lane/task-2105',
		lanePath: '/tmp/wt-task-2105',
		expectedPrimaryHead: hex40('a'),
		sourceBaseOid: hex40('b'),
		sourceHeadOid: hex40('c'),
		targetHeadOid: hex40('d'),
		strategy: 'merge',
		declaredConflictFiles: ['src/conflicted.ts'],
		...overrides,
	});
	expect(published.ok).toBe(true);
	if (!published.ok) throw new Error(published.code);
	return published.authority;
}

async function claimAuthority(
	directory: string,
	authorityDigest: string,
): Promise<Extract<ClaimWorktreeRecoveryAuthorityResult, { ok: true }>> {
	const claimed = await claimWorktreeRecoveryAuthority(directory, {
		authorityDigest,
		claimantCallID: 'call-B',
		claimantSessionId: 'session-B',
		leaseMs: 60_000,
		createChildSession: () => 'child-session-B',
		now: 10_000,
	});
	expect(claimed.ok).toBe(true);
	if (!claimed.ok) throw new Error(claimed.code);
	return claimed;
}

describe('handleLanesCommand — recovery visibility (issue #2105)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('swarm-lanes-recovery-2105-');
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		initDurableStatusPath(tempDir);
		resetStandardWorktreeIsolationState();
	});

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		mergeStatusInternals.resetForTest();
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('surfaces preserved v2 recovery identity and same-task redispatch guidance for conflicted lanes', () => {
		const authority = publishAuthority(tempDir);
		addConflictedLane({
			taskId: authority.immutable.taskId,
			worktreePath: authority.immutable.lanePath,
			branch: authority.immutable.laneBranch,
			outcome: 'partial',
			stage: 'merge',
			message: 'preserved after partial merge',
		});

		const text = handleLanesCommand(tempDir, []);
		const json = JSON.parse(handleLanesCommand(tempDir, ['--json'])) as {
			lanes: Array<Record<string, unknown>>;
		};
		const conflicted = json.lanes[0] as Record<string, unknown>;
		const recovery = conflicted.recovery as Record<string, unknown>;

		expect(text).toContain(
			'recovery: generation=4 status=preserved parentSession=session-A originalCall=call-A reservation=reservation-A strategy=merge',
		);
		expect(text).toContain(
			'redispatch: Re-dispatch the exact same task in parent session session-A to claim generation 4 instead of allocating a new lane.',
		);
		expect(text).not.toContain('Resolve manually, then re-run merge.');

		expect(recovery).toMatchObject({
			authorityStatus: 'preserved',
			generation: 4,
			originalCallID: 'call-A',
			parentSessionId: 'session-A',
			reservationId: 'reservation-A',
			strategy: 'merge',
			redispatchStatus: 'available',
		});
		expect(recovery.claim).toBeUndefined();
		expect(JSON.stringify(conflicted)).not.toContain('rawToken');
	});

	test('surfaces claimant state when same-task recovery is already claimed', async () => {
		const authority = publishAuthority(tempDir);
		await claimAuthority(tempDir, authority.authorityDigest);
		addConflictedLane({
			taskId: authority.immutable.taskId,
			worktreePath: authority.immutable.lanePath,
			branch: authority.immutable.laneBranch,
			stage: 'conflict',
			message: 'merge conflict preserved for recovery',
		});

		const text = handleLanesCommand(tempDir, []);
		const json = JSON.parse(handleLanesCommand(tempDir, ['--json'])) as {
			lanes: Array<Record<string, unknown>>;
		};
		const recovery = json.lanes[0]!.recovery as Record<string, unknown>;
		const claim = recovery.claim as Record<string, unknown>;

		expect(text).toContain(
			'recovery: generation=4 status=claimed parentSession=session-A originalCall=call-A reservation=reservation-A strategy=merge',
		);
		expect(text).toContain(
			'claimant: call=call-B session=session-B child=child-session-B revision=1 attempt=1',
		);
		expect(text).toContain(
			'redispatch: Same-task recovery is already claimed by call-B; wait for that claimant to settle or cancel it before retrying again.',
		);

		expect(recovery).toMatchObject({
			authorityStatus: 'claimed',
			redispatchStatus: 'claimed',
		});
		expect(claim).toMatchObject({
			claimantCallID: 'call-B',
			claimantSessionId: 'session-B',
			childSessionId: 'child-session-B',
			claimRevision: 1,
			attempt: 1,
			leaseState: 'claimed',
		});
	});

	test('falls back to explicit manual guidance when only unsupported legacy recovery metadata exists', () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'worktree-merge-recovery-v2.json'),
			JSON.stringify({
				schemaVersion: 1,
				owners: [],
			}),
			'utf8',
		);
		addConflictedLane({
			taskId: 'legacy-task',
			worktreePath: '/tmp/wt-legacy',
			branch: 'lane/legacy',
			stage: 'conflict',
			message: 'legacy recovery metadata',
		});

		const text = handleLanesCommand(tempDir, []);
		const json = JSON.parse(handleLanesCommand(tempDir, ['--json'])) as {
			lanes: Array<Record<string, unknown>>;
		};
		const recovery = json.lanes[0]!.recovery as Record<string, unknown>;

		expect(text).toContain(
			'redispatch: Same-task redispatch is unavailable because only legacy recovery metadata was found; use manual lane recovery for this preserved worktree.',
		);
		expect(text).toContain('hint: Merge conflict at /tmp/wt-legacy');
		expect(recovery).toMatchObject({
			authorityStatus: 'unsupported-legacy',
			redispatchStatus: 'unsupported-legacy',
		});
	});
});
