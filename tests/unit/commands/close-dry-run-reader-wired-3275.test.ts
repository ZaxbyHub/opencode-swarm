/**
 * Supplementary wiring test for issue #3317 (not frozen): the dry-run's
 * repository probe must actually route through the shared async reader.
 *
 * The frozen C9 counts branch `_internals.spawnSync` calls (≤1), which a
 * one-shot sync spawn would also satisfy. Here the stub answer CONTRADICTS
 * the fixture's ground truth — the fixture is a REAL git repository, but
 * `gitStatusReadInternals.readOnce` is stubbed to a FAILED read — so the
 * report can only say "would skip git alignment" if it consumes the reader's
 * answer. GREEN only after the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Facade first: binds wireCloseInternals() before the dry-run dereferences
// the late-bound close seam.
import '../../../src/commands/close';
import { runFinalizeDryRun } from '../../../src/commands/close/dry-run';
import { gitStatusReadInternals } from '../../../src/commands/git-status-read';
import { _internals as branchInternals } from '../../../src/git/branch';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GIT_TIMEOUT_MS = 10_000;
const tempRoots: string[] = [];

const originalReadOnce = gitStatusReadInternals.readOnce;
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
	gitStatusReadInternals.readOnce = originalReadOnce;
	branchInternals.spawnSync = originalBranchSpawnSync;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('close dry-run repository probe routes through the async reader (#3317 supplement)', () => {
	test('real repo + reader-stubbed failure → report says would skip git alignment, and zero sync spawns', async () => {
		const root = canonicalMkdtemp('3317-dryrun-wired-');
		tempRoots.push(root);
		// Ground truth: a real git repository (rev-parse would answer yes).
		git(root, 'init', '-q');
		git(root, 'config', 'user.email', 'swarm-test@example.invalid');
		git(root, 'config', 'user.name', 'Swarm Test');
		git(root, 'config', 'commit.gpgsign', 'false');
		fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
		git(root, 'add', 'tracked.txt');
		git(root, 'commit', '-q', '-m', 'base');
		const swarmDir = path.join(root, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// The reader's answer is the OPPOSITE of the fixture ground truth.
		let readerCalls = 0;
		gitStatusReadInternals.readOnce = async () => {
			readerCalls += 1;
			return { ok: false, code: 'ETIMEDOUT', status: null, stderrTail: '' };
		};
		let syncSpawns = 0;
		branchInternals.spawnSync = (() => {
			syncSpawns += 1;
			return {
				pid: -1,
				output: [null, '', ''],
				stdout: '',
				stderr: '',
				status: null,
				signal: null,
				error: Object.assign(new Error('should not run'), {
					code: 'ETIMEDOUT',
				}),
			};
		}) as typeof branchInternals.spawnSync;

		const out = await runFinalizeDryRun(
			root,
			swarmDir,
			{ title: 'wired-dry-run', phases: [] },
			false,
		);

		// The report reflects the READER's failed answer, not the fixture's
		// real repository state — only the reader path can produce this.
		expect(out).toContain('would skip git alignment');
		expect(readerCalls).toBeGreaterThan(0);
		expect(syncSpawns).toBe(0);
	}, 60_000);
});
