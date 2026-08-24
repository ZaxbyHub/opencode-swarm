import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	beginCoderSettlement,
	_internals as settlementInternals,
} from '../../../src/workflow/coder-settlement';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		stderr: 'pipe',
		encoding: 'utf-8',
		timeout: 10_000,
		maxBuffer: 128 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

describe('issue #2271 bug 1 — CODER_SETTLEMENT_BASELINE_UNAVAILABLE structural guard', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('settlement-baseline-2271-');
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		git(directory, ['add', 'src/feature.ts']);
		git(directory, ['commit', '-m', 'test: seed']);
	});

	afterEach(() => {
		settlementInternals.liveDispatches.clear();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('a baseline with no git HEAD fails fast instead of settling into dispatch_no_mutation', async () => {
		// An unregistered worktree lane (plain directory outside any repo)
		// produces exactly this baseline shape: gitHead null, changedFiles null.
		const plainDir = canonicalMkdtemp('plain-lane-');
		try {
			const baseline = captureWorkspaceSnapshot(plainDir);
			expect(baseline.gitHead).toBeNull();
			expect(baseline.changedFiles).toBeNull();

			const error = await beginCoderSettlement({
				directory,
				taskId: '1.1',
				transitionId: 'coder:call-1',
				actor: 'architect',
				expectedGeneration: 0,
				context: {
					declaredFiles: ['src/feature.ts'],
					baseline,
					workflowGeneration: 0,
				},
			}).catch((caught: unknown) => caught as Error);

			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain('CODER_SETTLEMENT_BASELINE_UNAVAILABLE');
			expect(error.message).toContain('task 1.1');
			expect(error.message).toContain('not a git repository');
			expect(error.message).toContain('worktree.policy "disabled"');
			// No settlement state was created.
			const walPath = path.join(
				directory,
				'.swarm',
				'coder-settlements',
				'1.1.json',
			);
			expect(fs.existsSync(walPath)).toBe(false);
		} finally {
			fs.rmSync(plainDir, { recursive: true, force: true });
		}
	});

	test('a non-git PROJECT keeps the #2214 settle-abort contract (no dispatch block)', async () => {
		// When the project root itself is not a git repository, dispatch stays
		// allowed — coder work still lands in the tree and attribution aborts
		// cleanly at settle time (issue #2214). Only the unregistered-lane
		// case (root has git, observation dir does not) fails fast.
		const nonGitRoot = canonicalMkdtemp('nogit-root-');
		try {
			fs.mkdirSync(path.join(nonGitRoot, '.swarm'), { recursive: true });
			const planPath = path.join(nonGitRoot, '.swarm', 'plan.json');
			// A minimal plan is not required by beginCoderSettlement itself; the
			// evidence transaction materializes what it needs.
			void planPath;
			const baseline = captureWorkspaceSnapshot(nonGitRoot);
			expect(baseline.gitHead).toBeNull();

			await beginCoderSettlement({
				directory: nonGitRoot,
				taskId: '4.1',
				transitionId: 'coder:call-4',
				actor: 'architect',
				expectedGeneration: 0,
				context: {
					declaredFiles: ['src/feature.ts'],
					baseline,
					workflowGeneration: 0,
				},
			});
			const walPath = path.join(
				nonGitRoot,
				'.swarm',
				'coder-settlements',
				'4.1.json',
			);
			expect(fs.existsSync(walPath)).toBe(true);
		} finally {
			fs.rmSync(nonGitRoot, { recursive: true, force: true });
		}
	});

	test('a transient capture failure (changedFiles null, gitHead present) keeps #2214 retry semantics', async () => {
		const real = captureWorkspaceSnapshot(directory);
		expect(real.gitHead).not.toBeNull();
		const transient = { ...real, changedFiles: null };

		// Must NOT throw the structural error — the transient class stays
		// retryable at settle time per issue #2214.
		await beginCoderSettlement({
			directory,
			taskId: '2.1',
			transitionId: 'coder:call-2',
			actor: 'architect',
			expectedGeneration: 0,
			context: {
				declaredFiles: ['src/feature.ts'],
				baseline: transient,
				workflowGeneration: 0,
			},
		});
		const walPath = path.join(
			directory,
			'.swarm',
			'coder-settlements',
			'2.1.json',
		);
		expect(fs.existsSync(walPath)).toBe(true);
	});

	test('a healthy baseline dispatches normally (regression guard)', async () => {
		await beginCoderSettlement({
			directory,
			taskId: '3.1',
			transitionId: 'coder:call-3',
			actor: 'architect',
			expectedGeneration: 0,
			context: {
				declaredFiles: ['src/feature.ts'],
				baseline: captureWorkspaceSnapshot(directory),
				workflowGeneration: 0,
			},
		});
		const walPath = path.join(
			directory,
			'.swarm',
			'coder-settlements',
			'3.1.json',
		);
		expect(fs.existsSync(walPath)).toBe(true);
	});
});
