/**
 * Test helper: land an epic task's coder work the way production does
 * (Epic v2 C3) — in a real linked git worktree cut from HEAD, merged back
 * through the real `attemptMergeBackFromDirty` with the landing options the
 * production seam (`epicCommitLandingFor`) chooses for the task. With an
 * open epic on its branch that is a `git merge --no-ff` commit
 * `swarm(task <id>): <description>` + `Swarm-Plan:` trailer.
 *
 * The lane worktree lives in a sibling temp directory and is removed (with
 * its branch) afterwards; the caller's main tree is never checked out.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { epicCommitLandingFor } from '../../src/epic/task-landing';
import { attemptMergeBackFromDirty } from '../../src/worktree/merge';
import { canonicalMkdtemp } from './tmpdir';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

function git(cwd: string, args: string[]): string {
	const r = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

/** Write `files` (repo-relative → content) in a lane and land it. */
export async function landEpicTaskForTest(
	directory: string,
	taskId: string,
	files: Record<string, string>,
): Promise<Awaited<ReturnType<typeof attemptMergeBackFromDirty>>> {
	const parent = canonicalMkdtemp('epic-lane-');
	const lanePath = path.join(parent, 'lane');
	const branch = `swarm-lane/test-${taskId.replace(/[^A-Za-z0-9_.-]/g, '_')}-${path.basename(parent)}`;
	git(directory, ['worktree', 'add', '-q', '-b', branch, lanePath, 'HEAD']);
	try {
		for (const [file, content] of Object.entries(files)) {
			const target = path.join(lanePath, file);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}
		const landing = epicCommitLandingFor(directory, taskId);
		return await attemptMergeBackFromDirty(
			lanePath,
			branch,
			directory,
			'merge',
			landing ?? {},
		);
	} finally {
		try {
			git(directory, ['worktree', 'remove', '--force', lanePath]);
		} catch {
			// best-effort
		}
		try {
			git(directory, ['branch', '-D', branch]);
		} catch {
			// best-effort (a squash landing keeps nothing to delete)
		}
		fs.rmSync(parent, { recursive: true, force: true });
	}
}
