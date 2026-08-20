/**
 * Issue #2236 — `src/worktree/core.ts` contains git-executable RESOLUTION
 * failures, not just spawn failures.
 *
 * The hardening that routed `runGit` and `checkPathBudget` through
 * `_internals.resolveGitExecutable()` placed that call OUTSIDE the guarded
 * region at both sites. `resolveGitExecutable()` throws `GitBinaryMissingError`
 * when every candidate is rejected, so the throw escaped uncaught —
 * structurally identical to the original `merge.ts` defect this issue fixes,
 * re-introduced by the fix for it.
 *
 * Each function keeps its EXISTING failure contract:
 * - `runGit` returns a non-zero `GitResult`, exactly as it does for a spawn
 *   that never started.
 * - `checkPathBudget` is documented fail-open and returns `{ ok: true }`.
 *
 * The `finally { proc.kill() }` timeout guarantee is pinned too, since the
 * containment restructure moves the spawn relative to that block.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import { GitBinaryMissingError } from '../../../src/utils/git-binary-missing-error';
import {
	_internals,
	checkPathBudget,
	cleanUntrackedFiles,
	isCleanWorktree,
} from '../../../src/worktree/core';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ORIGINAL = { ..._internals };
const roots: string[] = [];

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`core-git-resolve-${label}-`);
	roots.push(dir);
	return dir;
}

function mockProc(
	stdout: string,
	exitCode: number,
	onKill?: () => void,
): BunCompatSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		exitCode,
		stdout: { text: () => Promise.resolve(stdout) },
		stderr: { text: () => Promise.resolve('') },
		kill: () => onKill?.(),
	} as unknown as BunCompatSubprocess;
}

function throwingResolver(): never {
	throw new GitBinaryMissingError(
		'git executable could not be resolved on this host. Candidates tried: ...',
	);
}

afterEach(() => {
	_internals.bunSpawn = ORIGINAL.bunSpawn;
	_internals.resolveGitExecutable = ORIGINAL.resolveGitExecutable;
	_internals.platform = ORIGINAL.platform;
	_internals.getCoreLongPaths = ORIGINAL.getCoreLongPaths;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('runGit contains a git-resolution failure (#2236)', () => {
	test('returns a non-zero GitResult instead of throwing, and never spawns', async () => {
		const directory = tempRoot('rungit');
		let spawned = 0;
		_internals.resolveGitExecutable = throwingResolver;
		_internals.bunSpawn = (() => {
			spawned++;
			return mockProc('', 0);
		}) as unknown as typeof _internals.bunSpawn;

		// `_internals.getCoreLongPaths`'s production implementation is the
		// thinnest wrapper over `runGit`: it returns `undefined` when the
		// result is non-zero, so a contained failure is observable here.
		const result = await _internals.getCoreLongPaths(directory);

		expect(result).toBeUndefined();
		expect(spawned).toBe(0);
	});

	test('isCleanWorktree resolves (treating the worktree as dirty) rather than rejecting', async () => {
		const directory = tempRoot('clean');
		_internals.resolveGitExecutable = throwingResolver;

		await expect(isCleanWorktree(directory)).resolves.toBe(false);
	});

	test('the returned stderr names the git operation, the cwd, and the cause', async () => {
		const directory = tempRoot('stderr');
		_internals.resolveGitExecutable = throwingResolver;

		// `cleanUntrackedFiles` surfaces `runGit`'s stderr verbatim, so it is
		// the caller that proves the contained failure carries a diagnosis
		// rather than an empty result.
		const result = await cleanUntrackedFiles(directory);

		expect(result.cleaned).toBe(false);
		if (!result.cleaned) {
			expect(result.error).toContain('git clean could not start in');
			expect(result.error).toContain(directory);
			expect(result.error).toContain('could not be resolved');
		}
	});

	test('a synchronous bunSpawn throw is contained the same way', async () => {
		const directory = tempRoot('spawnthrow');
		_internals.resolveGitExecutable = () => 'git';
		_internals.bunSpawn = (() => {
			throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
		}) as unknown as typeof _internals.bunSpawn;

		await expect(isCleanWorktree(directory)).resolves.toBe(false);
	});

	test('the finally proc.kill() guarantee survives the restructure', async () => {
		const directory = tempRoot('kill');
		let kills = 0;
		_internals.resolveGitExecutable = () => 'git';
		_internals.bunSpawn = (() =>
			mockProc('', 0, () => {
				kills++;
			})) as unknown as typeof _internals.bunSpawn;

		await expect(isCleanWorktree(directory)).resolves.toBe(true);
		// One kill per runGit call; isCleanWorktree issues two.
		expect(kills).toBe(2);
	});
});

describe('checkPathBudget stays fail-open on a git-resolution failure (#2236)', () => {
	test('returns { ok: true } instead of throwing, and never spawns', async () => {
		const directory = tempRoot('budget');
		let spawned = 0;
		let resolveCalls = 0;
		_internals.platform = 'win32';
		_internals.getCoreLongPaths = async () => undefined;
		_internals.resolveGitExecutable = () => {
			resolveCalls++;
			return throwingResolver();
		};
		_internals.bunSpawn = (() => {
			spawned++;
			return mockProc('', 0);
		}) as unknown as typeof _internals.bunSpawn;

		await expect(
			checkPathBudget('C:\\worktrees\\lane-1', directory),
		).resolves.toEqual({ ok: true });
		// Resolution was REACHED and threw — so `{ ok: true }` provably came
		// from the new containment, not from the `platform !== 'win32'` guard
		// or the `core.longpaths` early return above it.
		expect(resolveCalls).toBe(1);
		expect(spawned).toBe(0);
	});

	test('a genuine over-budget result is still reported (fail-open is not blanket-open)', async () => {
		const directory = tempRoot('overbudget');
		_internals.platform = 'win32';
		_internals.getCoreLongPaths = async () => undefined;
		_internals.resolveGitExecutable = () => 'git';
		_internals.bunSpawn = (() =>
			mockProc(
				`${'a'.repeat(200)}\n`,
				0,
			)) as unknown as typeof _internals.bunSpawn;

		const result = await checkPathBudget('C:\\'.padEnd(60, 'w'), directory);

		expect(result.ok).toBe(false);
	});
});
