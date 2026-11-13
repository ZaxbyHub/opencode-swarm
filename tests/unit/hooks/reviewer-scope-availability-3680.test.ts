import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import {
	buildReviewerTaskScope,
	classifyWorkspaceGitHealth,
	_internals as receiptScopeInternals,
} from '../../../src/hooks/review-receipt-scope';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let directory: string;
const originalSpawn = receiptScopeInternals.spawn;

function git(args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
}

function makeHealthyRepo(): void {
	git(['init']);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'src', 'actual.ts'),
		'export const n = 1;\n',
	);
	git(['add', 'src/actual.ts']);
	git([
		'-c',
		'user.name=Scope Test',
		'-c',
		'user.email=scope@example.invalid',
		'commit',
		'-m',
		'baseline',
	]);
}

function currentBranchRef(): string {
	const result = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 5_000,
	});
	if (result.status !== 0 || !result.stdout) {
		throw new Error('fixture has no symbolic HEAD');
	}
	return result.stdout.trim();
}

beforeEach(() => {
	receiptScopeInternals.spawn = originalSpawn;
	directory = canonicalMkdtemp('reviewer-scope-availability-3680-');
});

afterEach(() => {
	receiptScopeInternals.spawn = originalSpawn;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('classifyWorkspaceGitHealth (#3680)', () => {
	test('no-git workspace denies terminal no_git_workspace', async () => {
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'no_git_workspace',
			retryable: false,
		});
	}, 60_000);

	test('unborn HEAD stays transient head_timeout', async () => {
		git(['init']);
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'head_timeout',
			retryable: true,
		});
	}, 60_000);

	test('healthy repository resolves its HEAD', async () => {
		makeHealthyRepo();
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health.kind).toBe('head');
		if (health.kind !== 'head') return;
		expect(health.sha).toMatch(/^[0-9a-f]{40,64}$/i);
	}, 60_000);

	test('corrupt loose branch ref denies terminal git_unhealthy', async () => {
		makeHealthyRepo();
		const ref = currentBranchRef();
		fs.writeFileSync(
			path.join(directory, '.git', ref),
			'not-a-valid-object-name\n',
			'utf-8',
		);
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'git_unhealthy',
			retryable: false,
		});
	}, 60_000);

	test('packed ref to a missing object denies terminal git_unhealthy', async () => {
		makeHealthyRepo();
		const ref = currentBranchRef();
		const packed = path.join(directory, '.git', 'packed-refs');
		fs.writeFileSync(packed, `${'0'.repeat(40)} ${ref}\n`, 'utf-8');
		fs.rmSync(path.join(directory, '.git', ref), { force: true });
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'git_unhealthy',
			retryable: false,
		});
	}, 60_000);

	test('detached HEAD to a missing object denies terminal git_unhealthy', async () => {
		makeHealthyRepo();
		git(['checkout', '--detach']);
		fs.writeFileSync(
			path.join(directory, '.git', 'HEAD'),
			`${'f'.repeat(40)}\n`,
			'utf-8',
		);
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'git_unhealthy',
			retryable: false,
		});
	}, 60_000);

	test('missing git executable denies terminal git_unavailable', async () => {
		receiptScopeInternals.spawn = (() => {
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: () => true,
			});
			queueMicrotask(() => {
				child.emit(
					'error',
					Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
				);
			});
			return child;
		}) as typeof originalSpawn;
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'git_unavailable',
			retryable: false,
		});
	}, 60_000);

	test('a slow git probe stays transient head_timeout', async () => {
		receiptScopeInternals.spawn = (() => {
			// Closes only AFTER the classifier's bounded probe budget (2 s
			// default) expires, via a REFERENCED timer — an unref'd one is
			// the only handle here against a fully fake child and would
			// never fire. No deadline argument: the default budget is the
			// surface under test.
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: () => true,
			}) as unknown as ReturnType<typeof originalSpawn>;
			setTimeout(() => {
				child.emit('close', 0);
			}, 3_000);
			return child;
		}) as typeof originalSpawn;
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'head_timeout',
			retryable: true,
		});
	}, 60_000);

	test('dubious ownership denies terminal git_dubious_ownership', async () => {
		makeHealthyRepo();
		receiptScopeInternals.spawn = (() => {
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout,
				stderr,
				kill: () => true,
			}) as unknown as ReturnType<typeof originalSpawn>;
			queueMicrotask(() => {
				stderr.write(
					"fatal: detected dubious ownership in repository at 'E:/somewhere'\n",
				);
				stderr.end();
				stdout.end();
				child.emit('close', 128);
			});
			return child;
		}) as typeof originalSpawn;
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'git_dubious_ownership',
			retryable: false,
		});
	}, 60_000);
});

describe('buildReviewerTaskScope git-environment denials (#3680)', () => {
	test('no-git workspace fails before any capture', async () => {
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'a.ts'),
			'export const a = 1;\n',
		);
		const result = await buildReviewerTaskScope(directory, ['src/a.ts']);
		expect(result).toMatchObject({
			ok: false,
			code: 'no_git_workspace',
			retryable: false,
		});
	}, 60_000);

	test('healthy repository builds its scope', async () => {
		makeHealthyRepo();
		const result = await buildReviewerTaskScope(directory, ['src/actual.ts']);
		expect(result.ok).toBe(true);
	}, 60_000);
});
