/**
 * Real-git regression for the finalize knowledge-loss bug.
 *
 * Bug: `runAlignStage` → `resetToMainAfterMerge` ran a blanket `git clean -fdX`.
 * Because `.swarm/` is gitignored, `-X` (remove ignored paths) deleted the entire
 * `.swarm/` tree — including the cumulative `knowledge.jsonl` the finalize clean
 * stage deliberately preserves, and the archive backup bundle.
 *
 * Fix: scope the clean to an explicit build-artifact allowlist
 * (`GITIGNORED_BUILD_ARTIFACTS`) via a `--` pathspec.
 *
 * This test uses REAL git (not a mocked gitExec) because the behavior is
 * pattern-/version-sensitive: an earlier candidate fix (`-e '!.swarm/'`) and the
 * anchored `-e '!/.swarm/'` variant were verified to FAIL, and pathspec-exclude
 * approaches also failed. A mocked-args assertion cannot catch a regression that
 * reintroduces a semantically-wrong-but-plausible clean invocation; only running
 * real git against a real `.swarm/` can. The command under test is built from the
 * SAME source constant the production code spreads, so changing the constant to
 * something that wipes `.swarm/` fails this test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals as closeInternals,
	handleCloseCommand,
} from '../../src/commands/close.js';
import { GITIGNORED_BUILD_ARTIFACTS } from '../../src/git/branch';
import { createSafeTestDir } from '../helpers/safe-test-dir';

function gitAvailable(): boolean {
	try {
		execFileSync('git', ['--version'], { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

const GIT_OK = gitAvailable();

function git(cwd: string, args: string[]): void {
	execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function branchExists(cwd: string, branchName: string): boolean {
	try {
		git(cwd, ['show-ref', '--verify', `refs/heads/${branchName}`]);
		return true;
	} catch {
		return false;
	}
}

function seedRepo(dir: string): void {
	git(dir, ['init', '-q']);
	git(dir, ['config', 'user.email', 'test@test.test']);
	git(dir, ['config', 'user.name', 'test']);
	// `dist/` ignored via .gitignore; `.swarm/` ignored via .git/info/exclude to
	// mirror this repo's `ensureSwarmGitExcluded`, which writes `.swarm/` there.
	fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
	fs.appendFileSync(
		path.join(dir, '.git', 'info', 'exclude'),
		'\n# opencode-swarm local runtime state\n.swarm/\n',
	);
	git(dir, ['add', '.gitignore']);
	git(dir, ['commit', '-qm', 'init']);
}

function seedWorkingState(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm', 'archive', 'swarm-123'), {
		recursive: true,
	});
	fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'knowledge.jsonl'),
		'{"lesson":"keep me"}\n',
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', 'archive', 'swarm-123', 'knowledge.jsonl'),
		'{"lesson":"backup"}\n',
	);
	fs.writeFileSync(path.join(dir, 'dist', 'out.js'), 'build output\n');
	fs.writeFileSync(path.join(dir, 'untracked-user-work.txt'), 'user work\n');
}

function confirmToken(preview: string): string {
	const token = /--confirm=([0-9a-f]{24})/.exec(preview)?.[1];
	if (!token)
		throw new Error(`close preview did not issue a token: ${preview}`);
	return token;
}

const exists = (dir: string, rel: string): boolean =>
	fs.existsSync(path.join(dir, rel));

describe.skipIf(!GIT_OK)(
	'finalize git-clean preserves .swarm/ (real git)',
	() => {
		let dir: string;
		let cleanup: () => void;

		beforeEach(() => {
			({ dir, cleanup } = createSafeTestDir('finalize-clean-'));
			seedRepo(dir);
		});

		afterEach(() => {
			cleanup();
		});

		test('scoped clean (production invocation) removes dist/ but preserves .swarm/', () => {
			seedWorkingState(dir);

			// Exact invocation the production code runs (branch.ts Step 7b), built from
			// the same exported constant.
			git(dir, ['clean', '-fdX', '--', ...GITIGNORED_BUILD_ARTIFACTS]);

			expect(exists(dir, '.swarm/knowledge.jsonl')).toBe(true);
			expect(exists(dir, '.swarm/archive/swarm-123/knowledge.jsonl')).toBe(
				true,
			);
			expect(exists(dir, 'dist/out.js')).toBe(false);
			expect(exists(dir, 'untracked-user-work.txt')).toBe(true);
		});

		test('baseline: a blanket `git clean -fdX` WOULD destroy .swarm/ (guards the test)', () => {
			seedWorkingState(dir);

			// The pre-fix invocation. Proves this harness can actually detect the bug —
			// so the scoped-clean test above is a meaningful guard, not a tautology.
			git(dir, ['clean', '-fdX']);

			expect(exists(dir, '.swarm/knowledge.jsonl')).toBe(false);
			expect(exists(dir, 'dist/out.js')).toBe(false);
		});

		test('allowlist contains only regenerable build output, never `.swarm`/`.claude`/`.opencode`', () => {
			for (const p of GITIGNORED_BUILD_ARTIFACTS) {
				const normalized = p.replace(/[\\/]+$/, '');
				expect(normalized).not.toBe('.');
				expect(normalized).not.toBe('.swarm');
				expect(normalized).not.toBe('.claude');
				expect(normalized).not.toBe('.opencode');
				expect(normalized).not.toBe('node_modules');
			}
		});

		test('confirmed close with pruning removes dist and a merged branch but preserves .swarm knowledge', async () => {
			const closeRunFinalizeStage = closeInternals.runFinalizeStage;
			const closeRunArchiveStage = closeInternals.runArchiveStage;
			const closeRunCleanStage = closeInternals.runCleanStage;
			const closeRunAlignStage = closeInternals.runAlignStage;
			const closeSnapshotInit =
				closeInternals.closeSnapshotCoordinationInitialization;
			const closeRewardSweep = closeInternals.runFinalizeRewardSweep;
			const closeResetState =
				closeInternals.resetSwarmStatePreservingSingletons;
			const closeEndSession = closeInternals.endAgentSession;
			const closeDetectFullAuto = closeInternals.detectFullAuto;
			try {
				seedWorkingState(dir);
				fs.writeFileSync(
					path.join(dir, '.swarm', 'plan.json'),
					JSON.stringify({ title: 'confirmed cleanup', phases: [] }),
				);
				fs.writeFileSync(path.join(dir, 'feature-marker.txt'), 'tracked\n');
				git(dir, ['add', 'feature-marker.txt']);
				git(dir, ['commit', '-qm', 'feature']);
				git(dir, ['branch', '-M', 'main']);
				git(dir, ['branch', 'feature']);
				git(dir, ['remote', 'add', 'origin', path.join(dir, 'remote.git')]);
				git(dir, ['init', '--bare', path.join(dir, 'remote.git')]);
				git(dir, ['push', '-qu', 'origin', 'main']);
				git(dir, ['push', '-qu', 'origin', 'feature']);
				git(dir, ['remote', 'set-head', 'origin', 'main']);
				git(dir, ['checkout', '-q', 'feature']);

				// Keep the confirmation, clean, and alignment boundaries real. The
				// unrelated finalize/archive work is stubbed so this regression stays
				// deterministic while exercising the production Git lifecycle.
				closeInternals.closeSnapshotCoordinationInitialization = async () => {};
				closeInternals.detectFullAuto = () => false;
				closeInternals.runFinalizeStage = async () => {};
				closeInternals.runFinalizeRewardSweep = async () => {};
				closeInternals.runArchiveStage = async () => {};
				closeInternals.runCleanStage = closeRunCleanStage;
				closeInternals.runAlignStage = closeRunAlignStage;
				closeInternals.resetSwarmStatePreservingSingletons = () => {};
				closeInternals.endAgentSession = () => {};

				const preview = await handleCloseCommand(dir, ['--prune-branches']);
				const output = await handleCloseCommand(dir, [
					'--prune-branches',
					`--confirm=${confirmToken(preview)}`,
				]);

				expect(output).toContain('Swarm finalized');
				expect(exists(dir, '.swarm/knowledge.jsonl')).toBe(true);
				expect(exists(dir, 'dist/out.js')).toBe(false);
				expect(branchExists(dir, 'feature')).toBe(false);
			} finally {
				closeInternals.runFinalizeStage = closeRunFinalizeStage;
				closeInternals.runArchiveStage = closeRunArchiveStage;
				closeInternals.runCleanStage = closeRunCleanStage;
				closeInternals.runAlignStage = closeRunAlignStage;
				closeInternals.closeSnapshotCoordinationInitialization =
					closeSnapshotInit;
				closeInternals.runFinalizeRewardSweep = closeRewardSweep;
				closeInternals.resetSwarmStatePreservingSingletons = closeResetState;
				closeInternals.endAgentSession = closeEndSession;
				closeInternals.detectFullAuto = closeDetectFullAuto;
			}
		});
	},
);
