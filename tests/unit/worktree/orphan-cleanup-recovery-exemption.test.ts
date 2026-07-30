/**
 * Regression test for issue #1657: `cleanupOrphanedBranches` must NOT delete a
 * lane branch that has an unresolved recovery record (a branch preserved for
 * manual merge-back recovery), and must fail-SAFE (skip ALL deletions) when the
 * recovery directory is unreadable.
 *
 * RED before the fix: cleanup force-deleted any non-active-session lane branch
 * via `git branch -D`, including a branch just preserved for recovery — the
 * only copy of unmerged lane work could be deleted by routine init-time cleanup
 * before a human ever saw the recovery message.
 *
 * GREEN after the fix: recovery branches are exempted; read-errors fail safe.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeRecoveryRecord } from '../../../src/turbo/lean/recovery';
import { bunSpawn } from '../../../src/utils/bun-compat';
import { cleanupOrphanedBranches } from '../../../src/worktree/merge';

async function runGit(
	repoDir: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bunSpawn(['git', ...args], {
		cwd: repoDir,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, LC_ALL: 'C' },
	});
	try {
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort
		}
	}
}

async function initGitRepo(repoDir: string): Promise<void> {
	fs.mkdirSync(repoDir, { recursive: true });
	await runGit(repoDir, ['init']);
	await runGit(repoDir, ['config', 'user.email', 'test@test.local']);
	await runGit(repoDir, ['config', 'user.name', 'Test User']);
	fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
	await runGit(repoDir, ['add', '.']);
	await runGit(repoDir, ['commit', '-m', 'initial commit']);
	await runGit(repoDir, ['branch', '-m', 'main']);
}

async function createSwarmLaneBranch(
	repoDir: string,
	sessionId: string,
	laneId: string,
): Promise<void> {
	await runGit(repoDir, [
		'checkout',
		'-b',
		`swarm-lane/${sessionId}/${laneId}`,
	]);
	fs.writeFileSync(
		path.join(repoDir, `lane-${laneId}.txt`),
		`lane ${laneId} content\n`,
	);
	await runGit(repoDir, ['add', '.']);
	await runGit(repoDir, ['commit', '-m', `lane ${laneId} commit`]);
	await runGit(repoDir, ['checkout', 'main']);
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
	const r = await runGit(repoDir, ['branch', '--list', branch]);
	// `--list` prints the branch name if it exists.
	return r.stdout.trim().length > 0;
}

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-recovery-test-'));
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

describe('cleanupOrphanedBranches — #1657 recovery exemption', () => {
	test('a lane branch with a recovery record is NOT deleted', async () => {
		await initGitRepo(tempDir);
		const sessionId = 'sess-crashed';
		const laneId = 'lane-1';
		const branch = `swarm-lane/${sessionId}/${laneId}`;
		await createSwarmLaneBranch(tempDir, sessionId, laneId);

		// Write a recovery record referencing this branch (simulating a
		// merge-back conflict that preserved the worktree for recovery).
		writeRecoveryRecord(tempDir, {
			laneId,
			sessionId,
			branchName: branch,
			worktreePath: path.join(tempDir, 'wt-lane-1'),
			status: 'conflict',
			reason: 'merge conflict on src/shared.ts',
			conflictFiles: ['src/shared.ts'],
			replayHint: `cd ${path.join(tempDir, 'wt-lane-1')} && git status`,
		});

		// Cleanup with NO active sessions — every lane branch is an "orphan"
		// by the old definition. The recovery exemption must protect this one.
		const result = await cleanupOrphanedBranches(tempDir, []);

		expect(result.skippedRecoveryBranches).toContain(branch);
		expect(result.removed).not.toContain(branch);
		expect(await branchExists(tempDir, branch)).toBe(true);
	});

	test('a non-recovery orphan IS still deleted (no regression to base behavior)', async () => {
		await initGitRepo(tempDir);
		const orphanBranch = 'swarm-lane/sess-old/lane-2';
		await createSwarmLaneBranch(tempDir, 'sess-old', 'lane-2');
		// No recovery record for this branch.

		const result = await cleanupOrphanedBranches(tempDir, []);

		expect(result.removed).toContain(orphanBranch);
		expect(await branchExists(tempDir, orphanBranch)).toBe(false);
	});

	test('fail-safe: when .swarm/recovery/ is unreadable, ALL lane-branch deletions are skipped', async () => {
		await initGitRepo(tempDir);
		// Two orphan lane branches, neither with a recovery record.
		await createSwarmLaneBranch(tempDir, 'sess-a', 'lane-a');
		await createSwarmLaneBranch(tempDir, 'sess-b', 'lane-b');

		// Create a corrupt recovery dir: present but containing an unreadable
		// record file. This triggers the fail-safe path.
		const recoveryDir = path.join(tempDir, '.swarm', 'recovery');
		fs.mkdirSync(recoveryDir, { recursive: true });
		fs.writeFileSync(
			path.join(recoveryDir, 'corrupt.json'),
			'not valid json {',
			'utf-8',
		);

		const result = await cleanupOrphanedBranches(tempDir, []);

		expect(result.recoveryReadError).toBe(true);
		// Fail-safe: NOTHING was removed, even though neither branch has a
		// (valid) recovery record. Recovery safety trumps orphan cleanliness.
		expect(result.removed).toEqual([]);
		expect(await branchExists(tempDir, 'swarm-lane/sess-a/lane-a')).toBe(true);
		expect(await branchExists(tempDir, 'swarm-lane/sess-b/lane-b')).toBe(true);
	});

	test('no recovery records and clean dir → base behavior (orphans deleted, no exemption)', async () => {
		await initGitRepo(tempDir);
		await createSwarmLaneBranch(tempDir, 'sess-old', 'lane-1');
		// Recovery dir absent (no recoveries ever recorded).

		const result = await cleanupOrphanedBranches(tempDir, []);

		expect(result.recoveryReadError).toBeUndefined();
		expect(result.skippedRecoveryBranches).toEqual([]);
		expect(result.removed).toContain('swarm-lane/sess-old/lane-1');
	});
});
