/**
 * Worktree isolation prunable-lane recovery — issue #2208.
 *
 * A `prunable` registration (directory deleted, git index still tracks it) is
 * stale metadata, not an active lane. The pre-provision collision check must
 * NOT classify it as a collision — that classification is what routed the
 * restart into `inspectStandardWorktreeCollisionOwnership`, which trusts a
 * live provisioning-owner lease for the full 5-minute window and hard-stops
 * with STANDARD_WORKTREE_OWNER_PROTECTED. With prunable lanes excluded, a
 * restart inside the lease window proceeds to provisioning, where
 * provisionWorktree prunes the stale registration (#2208, core.ts).
 *
 * @note Uses the _internals DI seam (no mock.module leakage), mirroring
 * delegation-gate-worktree-isolation-preprovision.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	preProvisionCollisionCheck,
	resetStandardWorktreeIsolationState,
	_internals as worktreeIsolationInternals,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { recordWorktreeProvisioningOwner } from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import { resetSwarmState } from '../../../src/state';
import type { bunSpawn } from '../../../src/utils/bun-compat';

function normalizeGitPath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function makeTempDir(prefix: string): string {
	return path.join(
		fs.realpathSync(os.tmpdir()),
		`${prefix}-${Math.random().toString(36).slice(2)}`,
	);
}

function mockGitWorktreeList(porcelainOutput: string, exitCode = 0) {
	return mock(() => ({
		exited: Promise.resolve(exitCode),
		stdout: { text: () => Promise.resolve(porcelainOutput) },
		stderr: { text: () => Promise.resolve('') },
		kill: () => {},
	}));
}

describe('preProvisionCollisionCheck — prunable registrations (#2208)', () => {
	let originalBunSpawn: typeof bunSpawn;
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		originalBunSpawn = worktreeIsolationInternals.bunSpawn as typeof bunSpawn;
		tempDir = makeTempDir('preprov-prunable');
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		(worktreeIsolationInternals as Record<string, unknown>).bunSpawn =
			originalBunSpawn;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		resetSwarmState();
		resetStandardWorktreeIsolationState();
	});

	it('does NOT classify a prunable same-session lane as a collision — recovery inside the lease window', async () => {
		const sessionId = 'ses-crashed';
		const taskId = '4.1';
		const lanePath = path.join(tempDir, '.swarm-worktrees', sessionId, taskId);
		const porcelain = [
			`worktree ${normalizeGitPath(tempDir)}`,
			'branch refs/heads/main',
			'',
			`worktree ${normalizeGitPath(lanePath)}`,
			`branch refs/heads/swarm/lane/${sessionId}/${taskId}`,
			'prunable',
			'',
		].join('\n');

		// A LIVE provisioning-owner record exists for the crashed session —
		// pre-#2208 the collision classification routed this into the
		// ownership inspector, which trusts the live lease and hard-stops with
		// STANDARD_WORKTREE_OWNER_PROTECTED for the full 5-minute window.
		recordWorktreeProvisioningOwner(tempDir, {
			callID: 'call-crashed',
			parentSessionId: sessionId,
			worktreeSessionId: sessionId,
			taskId,
		});

		worktreeIsolationInternals.bunSpawn = mockGitWorktreeList(porcelain);
		const result = await preProvisionCollisionCheck(taskId, tempDir, sessionId);
		// No collision → the caller never reaches the protected-owner hard-stop;
		// provisioning proceeds and prunes the stale registration (#2208).
		expect(result.collision).toBe(false);
		expect(result.uncertainty).toBeUndefined();
	});

	it('still classifies a NON-prunable same-session lane as a collision (unchanged behavior)', async () => {
		const sessionId = 'ses-live';
		const taskId = '4.1';
		const lanePath = path.join(tempDir, '.swarm-worktrees', sessionId, taskId);
		const porcelain = [
			`worktree ${normalizeGitPath(tempDir)}`,
			'branch refs/heads/main',
			'',
			`worktree ${normalizeGitPath(lanePath)}`,
			`branch refs/heads/swarm/lane/${sessionId}/${taskId}`,
			'',
		].join('\n');

		worktreeIsolationInternals.bunSpawn = mockGitWorktreeList(porcelain);
		const result = await preProvisionCollisionCheck(taskId, tempDir, sessionId);
		expect(result.collision).toBe(true);
		if (result.collision) {
			expect(result.existingBranch).toBe(`swarm/lane/${sessionId}/${taskId}`);
		}
	});

	it('a prunable OTHER-session lane for the same task is also not a collision (task is recoverable)', async () => {
		const ownerSession = 'ses-other';
		const taskId = '4.1';
		const lanePath = path.join(
			tempDir,
			'.swarm-worktrees',
			ownerSession,
			taskId,
		);
		const porcelain = [
			`worktree ${normalizeGitPath(tempDir)}`,
			'branch refs/heads/main',
			'',
			`worktree ${normalizeGitPath(lanePath)}`,
			`branch refs/heads/swarm/lane/${ownerSession}/${taskId}`,
			'prunable gitdir file points to non-existent location',
			'',
		].join('\n');

		worktreeIsolationInternals.bunSpawn = mockGitWorktreeList(porcelain);
		const result = await preProvisionCollisionCheck(
			taskId,
			tempDir,
			'ses-recovering',
		);
		expect(result.collision).toBe(false);
	});

	it('a prunable entry with a bare `prunable` line and a non-lane branch is ignored as before', async () => {
		const porcelain = [
			`worktree ${normalizeGitPath(tempDir)}`,
			'branch refs/heads/main',
			'',
			`worktree ${normalizeGitPath(path.join(tempDir, 'gone'))}`,
			'branch refs/heads/feature/x',
			'prunable',
			'',
		].join('\n');
		worktreeIsolationInternals.bunSpawn = mockGitWorktreeList(porcelain);
		const result = await preProvisionCollisionCheck('4.1', tempDir, 'ses-a');
		expect(result.collision).toBe(false);
	});
});
