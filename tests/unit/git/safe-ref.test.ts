import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as branch from '../../../src/git/branch';
import {
	assertSafeGitRefArg,
	isSafeGitRefArg,
	UnsafeGitRefError,
} from '../../../src/git/safe-ref';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2476 AC3 (source issue #2265): a repository- or caller-derived ref
 * that begins with "-" must never reach a git argv ref position where git
 * would parse it as an option.
 */
describe('isSafeGitRefArg predicate (#2476 AC3)', () => {
	test('accepts every benign ref shape used by the src/git sinks', () => {
		for (const ok of [
			'main',
			'feature/x',
			'origin/main',
			'HEAD',
			'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
			'origin/main..HEAD',
			'main..feature/x',
			'refs/heads/lanes/42',
			'issue-2476-fix',
		]) {
			expect(isSafeGitRefArg(ok)).toBe(true);
		}
	});

	test('rejects dash-leading tokens, including each range side', () => {
		for (const bad of [
			'',
			'--evil',
			'-evil',
			'--force',
			'HEAD..--evil',
			'--evil..HEAD',
			'origin/main..-x',
			'-x..origin/main',
		]) {
			expect(isSafeGitRefArg(bad)).toBe(false);
		}
	});

	test('passes through non-injecting oddities for git to reject (adversarial parity)', () => {
		// Not option-injection risks: git itself errors on these as invalid
		// refs, and branch.adversarial pins pass-through for the traversal
		// shape — the guard must not widen beyond the injection class.
		for (const passthrough of ['../../../master', 'a..', '..b', 'a b']) {
			expect(isSafeGitRefArg(passthrough)).toBe(true);
		}
	});

	test('assertSafeGitRefArg returns the value when safe, throws typed otherwise', () => {
		expect(assertSafeGitRefArg('origin/main', 'ctx')).toBe('origin/main');
		expect(() => assertSafeGitRefArg('--evil', 'ctx')).toThrow(
			UnsafeGitRefError,
		);
		expect(() => assertSafeGitRefArg('--evil', 'ctx')).toThrow(/ctx/);
	});
});

describe('sink guards (#2476 AC3)', () => {
	const spawned: Array<{ cmd: string; args: string[] }> = [];
	const realInternals = { ...branch._internals };

	beforeEach(() => {
		spawned.length = 0;
		// Recording stub: every git call "succeeds" with empty output; the
		// assertions inspect the argv that reaches spawn.
		branch._internals.spawnSync = ((_cmd: string, args: string[]) => {
			spawned.push({ cmd: _cmd, args });
			return {
				status: 0,
				stdout: '',
				stderr: '',
				pid: 1,
				output: [],
				error: undefined,
			} as ReturnType<typeof branch._internals.spawnSync>;
		}) as typeof branch._internals.spawnSync;
		branch._internals.resolveGitExecutable = () => 'git';
		branch._internals.gitExec = ((args: string[]) => {
			spawned.push({ cmd: 'git', args });
			return '';
		}) as typeof branch._internals.gitExec;
		branch._internals.getDefaultBaseBranch = (() =>
			'main') as typeof branch._internals.getDefaultBaseBranch;
	});

	afterEach(() => {
		Object.assign(branch._internals, realInternals);
	});

	test('createBranch rejects a hostile branch name before any git call', () => {
		const dir = canonicalMkdtemp('saferef-');
		try {
			for (const hostile of ['--evil', '--force', '-x']) {
				spawned.length = 0;
				expect(() => branch.createBranch(dir, hostile)).toThrow(
					UnsafeGitRefError,
				);
				expect(spawned).toEqual([]);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('getChangedFiles rejects a hostile auto-detected base branch', () => {
		branch._internals.getDefaultBaseBranch = (() =>
			'--upload-pack=evil') as typeof branch._internals.getDefaultBaseBranch;
		expect(() => branch.getChangedFiles('/tmp')).toThrow(UnsafeGitRefError);
		expect(spawned).toEqual([]);
	});

	test('benign names still produce the historical argv (PRESERVING parity)', () => {
		const dir = canonicalMkdtemp('saferef2-');
		try {
			// rev-parse "fails" (branch absent everywhere) so createBranch walks
			// to its create-new arm; every other git call succeeds.
			branch._internals.spawnSync = ((_cmd: string, args: string[]) => {
				spawned.push({ cmd: _cmd, args });
				const status = args[0] === 'rev-parse' ? 128 : 0;
				return {
					status,
					stdout: '',
					stderr: '',
					pid: 1,
					output: [],
					error: undefined,
				} as ReturnType<typeof branch._internals.spawnSync>;
			}) as typeof branch._internals.spawnSync;
			branch.createBranch(dir, 'feature/benign');
			expect(
				spawned.some((s) =>
					s.args.join(' ').includes('checkout -b feature/benign'),
				),
			).toBe(true);
			// getChangedFiles benign diff argv unchanged (validation-only sink).
			spawned.length = 0;
			branch.getChangedFiles(dir, 'main');
			expect(
				spawned.some((s) =>
					s.args.join(' ').includes('diff --name-only main HEAD'),
				),
			).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
