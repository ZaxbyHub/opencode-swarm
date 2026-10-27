/**
 * Acceptance check C9 for issue #3317 (class: DISCRIMINATING).
 *
 * `/swarm finalize --dry-run`'s repository probe must be a single bounded
 * read, not the blocking 5-attempt synchronous transient-retry chain: with
 * `branchInternals.spawnSync` stubbed to an ETIMEDOUT error, base runs the
 * sync gitExec retry loop five times (MAX_TRANSIENT_RETRIES) with blocking
 * backoff; the fixed path answers with at most one spawn and still returns a
 * well-formed dry-run report.
 *
 * The close facade is imported so wireCloseInternals() binds the late-bound
 * `_internals.getGitRepositoryStatus` seam (src/commands/close/internals.ts)
 * before runFinalizeDryRun dereferences it.
 *
 * RED at base (spawnSync call count === 5), GREEN after the fix (<= 1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Facade first: binds wireCloseInternals() (getGitRepositoryStatus etc.)
// before the dry-run dereferences the late-bound close seam.
import '../../../src/commands/close';
import { runFinalizeDryRun } from '../../../src/commands/close/dry-run';
import { _internals as branchInternals } from '../../../src/git/branch';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GIT_TIMEOUT_MS = 10_000;
const tempRoots: string[] = [];

const originalBranchSpawnSync = branchInternals.spawnSync;

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

afterEach(() => {
	branchInternals.spawnSync = originalBranchSpawnSync;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('close dry-run git probe is non-blocking (#3317 C9)', () => {
	test('dry-run answers with at most one spawn even when git times out', async () => {
		const root = canonicalMkdtemp('3317-dryrun-');
		tempRoots.push(root);
		git(root, 'init', '-q');
		git(root, 'config', 'user.email', 'swarm-test@example.invalid');
		git(root, 'config', 'user.name', 'Swarm Test');
		git(root, 'config', 'commit.gpgsign', 'false');
		fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
		git(root, 'add', 'tracked.txt');
		git(root, 'commit', '-q', '-m', 'base');
		const swarmDir = path.join(root, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		let spawnCalls = 0;
		branchInternals.spawnSync = (() => {
			spawnCalls += 1;
			return {
				pid: -1,
				output: [null, '', ''],
				stdout: '',
				stderr: '',
				status: null,
				signal: null,
				error: Object.assign(new Error('spawn ETIMEDOUT'), {
					code: 'ETIMEDOUT',
				}),
			};
		}) as typeof branchInternals.spawnSync;

		const out = await runFinalizeDryRun(
			root,
			swarmDir,
			{ title: 'c9-dry-run', phases: [] },
			false,
		);

		// A well-formed dry-run report still comes back.
		expect(out).toContain('DRY RUN');
		// Base: the sync gitExec transient-retry chain fires 5 spawnSync
		// calls (with blocking backoff). The bounded async read fires at most 1.
		expect(spawnCalls).toBeLessThanOrEqual(1);
	}, 60_000);
});
