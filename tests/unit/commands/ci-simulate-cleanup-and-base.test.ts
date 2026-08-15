/**
 * Issue #2131 criterion E — split from ci-simulate.test.ts (FR-006 line cap):
 * fail-closed worktree cleanup and the validated explicit --base flag.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const { _internals, handleCiSimulateCommand } = await import(
	'../../../src/commands/ci-simulate.js'
);
const realRunExternalTool = _internals.runExternalTool;
const realDetectDefaultRemoteBranch = _internals.detectDefaultRemoteBranch;
const realFs = _internals.fs;

function runGit(dir: string, args: string[]): void {
	execFileSync('git', args, {
		cwd: dir,
		stdio: 'ignore',
		timeout: 30_000,
	});
}

function gitInit(dir: string): void {
	runGit(dir, ['init']);
	runGit(dir, ['config', 'user.email', 'test@test.com']);
	runGit(dir, ['config', 'user.name', 'Test']);
	runGit(dir, ['branch', '-M', 'main']);
}

describe('handleCiSimulateCommand cleanup + explicit base (issue #2131 E)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('ci-simulate-cleanup-');
		gitInit(tempDir);
		runGit(tempDir, ['commit', '--allow-empty', '-m', 'initial commit']);
	});

	afterEach(() => {
		_internals.runExternalTool = realRunExternalTool;
		_internals.detectDefaultRemoteBranch = realDetectDefaultRemoteBranch;
		_internals.fs = realFs;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	});

	it('surfaces BLOCKED cleanup and never force-deletes when git worktree remove fails', async () => {
		let createdWorktreePath = '';
		const rmSyncCalls: string[] = [];
		_internals.detectDefaultRemoteBranch = () => 'main';
		_internals.fs = {
			existsSync: realFs.existsSync,
			realpathSync: realFs.realpathSync.native,
			rmSync: (target: string) => {
				rmSyncCalls.push(target);
			},
		};
		_internals.runExternalTool = mock(async (options) => {
			if (options.args[0] === 'worktree' && options.args[1] === 'add') {
				createdWorktreePath = options.args[3] ?? '';
			}
			if (
				options.args[0] === 'worktree' &&
				options.args[1] === 'list' &&
				createdWorktreePath
			) {
				return {
					status: 'completed',
					exitCode: 0,
					stdout: `worktree ${tempDir}\nworktree ${createdWorktreePath}\n`,
					stderr: '',
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			}
			if (options.args[0] === 'worktree' && options.args[1] === 'remove') {
				return {
					status: 'completed',
					exitCode: 1,
					stdout: '',
					stderr: 'fatal: the working directory is dirty',
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			}
			const conflict = options.args[0] === 'merge';
			return {
				status: 'completed',
				exitCode: conflict ? 1 : 0,
				stdout: '',
				stderr: conflict ? 'CONFLICT (content): Merge conflict' : '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunExternalTool;

		const result = await handleCiSimulateCommand(tempDir, ['main']);

		expect(result).toContain('WORKTREE CLEANUP BLOCKED');
		expect(result).toContain('dirty');
		// Never force-deleted the directory.
		expect(rmSyncCalls).toHaveLength(0);
	});

	it('--base validates the ref exists in the repository before use', async () => {
		_internals.detectDefaultRemoteBranch = () => 'main';
		const verifiedRefs: string[] = [];
		_internals.runExternalTool = mock(async (options) => {
			if (options.args[0] === 'rev-parse' && options.args[1] === '--verify') {
				const target = options.args[options.args.length - 1];
				verifiedRefs.push(target);
				// Only origin/main resolves; origin/release-9x does not.
				return {
					status: 'completed',
					exitCode: target === 'origin/main' ? 0 : 1,
					stdout: '',
					stderr: '',
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			}
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunExternalTool;

		// A resolving explicit base is verified and used.
		const ok = await handleCiSimulateCommand(tempDir, [
			'main',
			'--base',
			'origin/main',
		]);
		expect(verifiedRefs).toContain('origin/main');
		expect(ok).not.toContain('does not resolve');

		// A non-resolving explicit base fails closed with remediation.
		const blocked = await handleCiSimulateCommand(tempDir, [
			'main',
			'--base',
			'origin/release-9x',
		]);
		expect(blocked).toContain('does not resolve in this repository');

		// A --base without a ref value is rejected before git runs.
		const malformed = await handleCiSimulateCommand(tempDir, [
			'main',
			'--base',
		]);
		expect(malformed).toContain('--base must be followed by');
	});
});
