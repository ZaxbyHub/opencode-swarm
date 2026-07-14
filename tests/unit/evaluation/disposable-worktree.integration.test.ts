import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	captureWorkingTreeFingerprint,
	DisposableWorktreeCleanupError,
	removeDisposableWorktree,
	withDisposableWorktree,
} from '../../../src/evaluation/disposable-worktree.js';
import {
	resolveExecutableFromPath,
	runExternalTool,
} from '../../../src/utils/external-tool-runner.js';

async function git(root: string, args: string[]): Promise<string> {
	const executable = resolveExecutableFromPath(['git']);
	if (!executable) throw new Error('git is required for this integration test');
	const result = await runExternalTool({
		executable,
		args: ['-C', root, ...args],
		cwd: root,
		timeoutMs: 30_000,
		maxStdoutBytes: 64 * 1024,
		maxStderrBytes: 64 * 1024,
	});
	if (result.status !== 'completed' || result.exitCode !== 0) {
		throw new Error(result.stderr || result.message || 'git failed');
	}
	return result.stdout.trim();
}

describe('disposable evaluation worktree', () => {
	test('regression P1: failed Git and filesystem cleanup cannot report evaluation success', async () => {
		// Previous code swallowed both cleanup failures and never checked Git's
		// registration, so an otherwise successful evaluation could leak a worktree.
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-cleanup-failure-')),
		);
		const projectRoot = path.join(root, 'project');
		const worktreeParent = path.join(root, 'opencode-swarm-evaluation');
		const worktreePath = path.join(worktreeParent, 'injected-leak');
		fs.mkdirSync(projectRoot, { recursive: true });
		fs.mkdirSync(worktreePath, { recursive: true });

		const originals = { ..._internals };
		const commands: string[] = [];
		try {
			_internals.tmpdir = () => root;
			_internals.resolveExecutableFromPath = () => 'git';
			_internals.rmSync = (() => {
				throw new Error('injected filesystem cleanup failure');
			}) as typeof fs.rmSync;
			_internals.runExternalTool = (async (options) => {
				const command = options.args.slice(2).join(' ');
				commands.push(command);
				const removeFailed = command.startsWith('worktree remove');
				const stdout = command.startsWith('worktree list')
					? `worktree ${worktreePath}\0HEAD deadbeef\0detached\0\0`
					: '';
				return {
					status: 'completed',
					exitCode: removeFailed ? 1 : 0,
					stdout,
					stderr: removeFailed ? 'injected git cleanup failure' : '',
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			}) as typeof _internals.runExternalTool;

			let cleanupError: unknown;
			try {
				await removeDisposableWorktree(projectRoot, worktreePath);
			} catch (error) {
				cleanupError = error;
			}

			expect(cleanupError).toBeInstanceOf(DisposableWorktreeCleanupError);
			const typed = cleanupError as DisposableWorktreeCleanupError;
			expect(typed.code).toBe('evaluation-worktree-cleanup-failed');
			expect(typed.pathPresent).toBe(true);
			expect(typed.registrationPresent).toBe(true);
			expect(typed.cleanupErrors.join('\n')).toContain('git-remove:');
			expect(typed.cleanupErrors.join('\n')).toContain('filesystem-remove:');
			expect(commands).toEqual([
				`worktree remove --force ${worktreePath}`,
				'worktree prune --expire now',
				'worktree list --porcelain -z',
			]);
		} finally {
			Object.assign(_internals, originals);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('regression P1: cleanup failure overrides a successful isolated callback', async () => {
		const originals = { ..._internals };
		const fingerprint = { head: 'a'.repeat(40), porcelainHash: 'clean' };
		const cleanupError = new DisposableWorktreeCleanupError(
			path.join(os.tmpdir(), 'injected-worktree'),
			true,
			true,
			['injected cleanup failure'],
		);
		try {
			// These seams isolate orchestration only. Real Git creation/removal and
			// fingerprint branches remain covered by the integration tests below.
			_internals.captureWorkingTreeFingerprint = async () => fingerprint;
			_internals.createDisposableWorktree = async (_root, baseSha) => ({
				path: cleanupError.worktreePath,
				baseSha,
			});
			_internals.removeDisposableWorktree = async () => {
				throw cleanupError;
			};

			await expect(
				withDisposableWorktree({
					projectRoot: os.tmpdir(),
					baseRef: fingerprint.head,
					run: async () => 'would-have-succeeded',
				}),
			).rejects.toBe(cleanupError);
		} finally {
			Object.assign(_internals, originals);
		}
	});

	test('ignores runtime state while detecting ordinary working-tree changes', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-fingerprint-')),
		);
		try {
			await git(root, ['init']);
			await git(root, ['config', 'user.email', 'evaluation@example.invalid']);
			await git(root, ['config', 'user.name', 'Evaluation Test']);
			fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
			await git(root, ['add', 'tracked.txt']);
			await git(root, ['commit', '-m', 'base']);

			const before = await captureWorkingTreeFingerprint(root);
			fs.mkdirSync(path.join(root, '.swarm', 'evaluation'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(root, '.swarm', 'evaluation', 'runtime.json'),
				'{}\n',
			);
			expect(await captureWorkingTreeFingerprint(root)).toEqual(before);

			fs.writeFileSync(path.join(root, 'ordinary-untracked.txt'), 'changed\n');
			expect(
				(await captureWorkingTreeFingerprint(root)).porcelainHash,
			).not.toBe(before.porcelainHash);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('preserves tracked and untracked active-tree identity on success and failure', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-git-')),
		);
		try {
			await git(root, ['init']);
			await git(root, ['config', 'user.email', 'evaluation@example.invalid']);
			await git(root, ['config', 'user.name', 'Evaluation Test']);
			fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
			await git(root, ['add', 'tracked.txt']);
			await git(root, ['commit', '-m', 'base']);
			fs.writeFileSync(path.join(root, 'untracked.txt'), 'keep\n');
			const head = await git(root, ['rev-parse', 'HEAD']);
			const before = await captureWorkingTreeFingerprint(root);
			let firstPath = '';
			await withDisposableWorktree({
				projectRoot: root,
				baseRef: head,
				run: async (worktree) => {
					firstPath = worktree.path;
					fs.writeFileSync(
						path.join(worktree.path, 'tracked.txt'),
						'changed\n',
					);
					fs.writeFileSync(path.join(worktree.path, 'new.txt'), 'temporary\n');
				},
			});
			expect(fs.existsSync(firstPath)).toBe(false);
			let failedPath = '';
			await expect(
				withDisposableWorktree({
					projectRoot: root,
					baseRef: head,
					run: async (worktree) => {
						failedPath = worktree.path;
						fs.writeFileSync(
							path.join(worktree.path, 'new.txt'),
							'temporary\n',
						);
						throw new Error('expected callback failure');
					},
				}),
			).rejects.toThrow('expected callback failure');
			expect(fs.existsSync(failedPath)).toBe(false);
			expect(await captureWorkingTreeFingerprint(root)).toEqual(before);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
