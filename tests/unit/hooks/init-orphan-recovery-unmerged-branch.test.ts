import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recordWorktreeProvisioningOwner } from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import { runInitOrphanRecovery } from '../../../src/hooks/init-orphan-recovery';
import { bunSpawn } from '../../../src/utils/bun-compat';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

async function git(directory: string, args: string[]): Promise<string> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	try {
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		if (exitCode !== 0) throw new Error(stderr || `git exited ${exitCode}`);
		return stdout.trim();
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort
		}
	}
}

describe('init orphan recovery preserves unmerged expired-owner branches', () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('missing lane path does not force-delete the only valuable commit', async () => {
		const root = canonicalMkdtemp('swarm-init-unmerged-');
		roots.push(root);
		const project = path.join(root, 'project');
		fs.mkdirSync(project, { recursive: true });
		await git(project, ['init']);
		await git(project, ['config', 'user.email', 'test@example.invalid']);
		await git(project, ['config', 'user.name', 'Test User']);
		fs.writeFileSync(path.join(project, 'base.txt'), 'base\n');
		await git(project, ['add', 'base.txt']);
		await git(project, ['commit', '-m', 'initial']);

		const sessionId = 'ses_crashed';
		const taskId = 'lane-1';
		const branch = `swarm/lane/${sessionId}/${taskId}`;
		const worktreePath = path.join(root, '.swarm-worktrees', sessionId, taskId);
		await git(project, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
		fs.writeFileSync(path.join(worktreePath, 'valuable.txt'), 'keep me\n');
		await git(worktreePath, ['add', 'valuable.txt']);
		await git(worktreePath, ['commit', '-m', 'valuable lane commit']);

		const callID = 'expired-owner';
		recordWorktreeProvisioningOwner(project, {
			callID,
			parentSessionId: sessionId,
			worktreeSessionId: sessionId,
			taskId,
		});
		const ownerPath = path.join(
			project,
			'.swarm',
			'worktree-provisioning-owners',
			`${createHash('sha256').update(callID).digest('hex')}.json`,
		);
		const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<
			string,
			unknown
		>;
		owner.createdAt = 1;
		fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`);
		fs.rmSync(worktreePath, { recursive: true, force: true });

		const result = await runInitOrphanRecovery(project);

		expect(result.attempted).toBe(true);
		expect(fs.existsSync(ownerPath)).toBe(false);
		expect(result.orphanedBranches).not.toContain(branch);
		expect(result.warnings.some((warning) => warning.includes(branch))).toBe(
			true,
		);
		expect(await git(project, ['show', `${branch}:valuable.txt`])).toBe(
			'keep me',
		);
	});
});
