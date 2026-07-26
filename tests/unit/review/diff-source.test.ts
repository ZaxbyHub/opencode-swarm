import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	collectReviewDiff,
	parseReviewDiffSelector,
	parseUnifiedDiffScope,
} from '../../../src/review/diff-source';
import type {
	BunCompatSpawnOptions,
	BunCompatSubprocess,
} from '../../../src/utils/bun-compat';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);

function stream(text: string) {
	const bytes = new TextEncoder().encode(text);
	return {
		async text() {
			return text;
		},
		async bytes() {
			return bytes;
		},
		getReader() {
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}).getReader();
		},
	};
}

function proc(
	stdout: string,
	exitCode = 0,
	onKill: () => void = () => {},
): BunCompatSubprocess {
	return {
		stdout: stream(stdout),
		stderr: stream(exitCode === 0 ? '' : 'git failed'),
		exited: Promise.resolve(exitCode),
		exitCode,
		kill: onKill,
	};
}

const realSpawn = _internals.bunSpawn;
const realLstat = _internals.lstatSync;
const realOpen = _internals.openSync;

function fixtureGit(directory: string, args: string[]): string {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args[0]} failed`);
	}
	return result.stdout;
}

afterEach(() => {
	_internals.bunSpawn = realSpawn;
	_internals.lstatSync = realLstat;
	_internals.openSync = realOpen;
});

describe('parseReviewDiffSelector', () => {
	test('accepts the documented selectors and composable --json flag', () => {
		expect(parseReviewDiffSelector([])).toEqual({
			ok: true,
			selector: { kind: 'default' },
			json: false,
		});
		expect(
			parseReviewDiffSelector(['--base', 'origin/main', '--json']),
		).toEqual({
			ok: true,
			selector: { kind: 'base', ref: 'origin/main' },
			json: true,
		});
		expect(parseReviewDiffSelector(['--range', 'v1..feature/x'])).toEqual({
			ok: true,
			selector: {
				kind: 'range',
				from: 'v1',
				to: 'feature/x',
				operator: '..',
			},
			json: false,
		});
		expect(parseReviewDiffSelector(['--range', 'main...HEAD'])).toEqual({
			ok: true,
			selector: {
				kind: 'range',
				from: 'main',
				to: 'HEAD',
				operator: '...',
			},
			json: false,
		});
		expect(parseReviewDiffSelector(['--working-tree'])).toEqual({
			ok: true,
			selector: { kind: 'working-tree' },
			json: false,
		});
	});

	test.each([
		['--base'],
		['--base', '-danger'],
		['--base', 'main branch'],
		['--base', 'main;touch'],
		['--range', 'main'],
		['--range', 'a..b..c'],
		['--range', '..HEAD'],
		['--working-tree', '--base', 'main'],
		['--wat'],
	])('rejects unsafe, malformed, and ambiguous argv: %p', (...argv) => {
		const parsed = parseReviewDiffSelector(argv);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.code).toBeString();
	});
});

const MULTI_FILE_DIFF = [
	'diff --git a/src/a.ts b/src/a.ts',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -1,3 +1,3 @@',
	' same',
	'-old',
	'+new',
	' tail',
	'diff --git a/src/new.ts b/src/new.ts',
	'new file mode 100644',
	'--- /dev/null',
	'+++ b/src/new.ts',
	'@@ -0,0 +1,2 @@',
	'+one',
	'+two',
	'diff --git a/src/gone.ts b/src/gone.ts',
	'deleted file mode 100644',
	'--- a/src/gone.ts',
	'+++ /dev/null',
	'@@ -2,2 +0,0 @@',
	'-gone',
	'-gone too',
	'diff --git a/src/old-name.ts b/src/new-name.ts',
	'similarity index 80%',
	'rename from src/old-name.ts',
	'rename to src/new-name.ts',
	'--- a/src/old-name.ts',
	'+++ b/src/new-name.ts',
	'@@ -5 +5 @@',
	'-before',
	'+after',
	'',
].join('\n');

describe('parseUnifiedDiffScope', () => {
	test('maps only exact sent current-side lines and retains deletion evidence', () => {
		const parsed = parseUnifiedDiffScope(MULTI_FILE_DIFF);
		expect(parsed.changedLines.get('src/a.ts')).toEqual([{ start: 2, end: 2 }]);
		expect(parsed.changedLines.get('src/new.ts')).toEqual([
			{ start: 1, end: 2 },
		]);
		expect(parsed.changedLines.get('src/new-name.ts')).toEqual([
			{ start: 5, end: 5 },
		]);
		expect(parsed.deletedLines.get('src/gone.ts')).toEqual([
			{ start: 2, end: 3 },
		]);
		expect(parsed.deletedLines.get('src/old-name.ts')).toEqual([
			{ start: 5, end: 5 },
		]);
		expect(parsed.files.get('src/new-name.ts')?.kind).toBe('renamed');
		expect(parsed.files.get('src/gone.ts')?.kind).toBe('deleted');
	});

	test('does not claim unsent hunk lines after line-boundary truncation', () => {
		const partial = [
			'--- a/a.ts',
			'+++ b/a.ts',
			'@@ -10,4 +10,4 @@',
			'--- source text that resembles a file header',
			'+++ source text that resembles a file header',
			'... [review diff truncated: max_bytes]',
		].join('\n');
		const parsed = parseUnifiedDiffScope(partial);
		expect(parsed.changedLines.get('a.ts')).toEqual([{ start: 10, end: 10 }]);
		expect(parsed.deletedLines.get('a.ts')).toEqual([{ start: 10, end: 10 }]);
	});

	test('normalizes Windows separators in valid relative diff paths', () => {
		const parsed = parseUnifiedDiffScope(
			'--- a/src\\win.ts\n+++ b/src\\win.ts\n@@ -1 +1 @@\n-old\n+new\n',
		);
		expect(parsed.changedLines.get('src/win.ts')).toEqual([
			{ start: 1, end: 1 },
		]);
	});
});

function installGitStub(options: {
	root: string;
	diff?: string;
	untracked?: string;
	failCommand?: string;
	onCall?: (cmd: string[], opts?: BunCompatSpawnOptions) => void;
	onKill?: () => void;
}): void {
	_internals.bunSpawn = ((cmd, spawnOptions) => {
		options.onCall?.(cmd, spawnOptions);
		const joined = cmd.join(' ');
		if (options.failCommand && joined.includes(options.failCommand)) {
			return proc('', 1, options.onKill);
		}
		if (joined.includes('rev-parse --show-toplevel'))
			return proc(`${options.root}\n`, 0, options.onKill);
		if (joined.includes('HEAD^{commit}'))
			return proc(`${HEAD}\n`, 0, options.onKill);
		if (joined.includes('symbolic-ref'))
			return proc('origin/main\n', 0, options.onKill);
		if (
			joined.includes('origin/main^{commit}') ||
			joined.includes('main^{commit}')
		)
			return proc(`${BASE}\n`, 0, options.onKill);
		if (joined.includes('merge-base'))
			return proc(`${MERGE_BASE}\n`, 0, options.onKill);
		if (joined.includes('ls-files'))
			return proc(options.untracked ?? '', 0, options.onKill);
		if (joined.includes(' diff '))
			return proc(options.diff ?? '', 0, options.onKill);
		return proc('', 1, options.onKill);
	}) as typeof realSpawn;
}

describe('collectReviewDiff', () => {
	test('works against a real repository with branch and working-tree changes', async () => {
		const fixture = createSafeTestDir('review-real-git-');
		try {
			fixtureGit(fixture.dir, ['init', '-b', 'main']);
			fixtureGit(fixture.dir, [
				'config',
				'user.email',
				'review@example.invalid',
			]);
			fixtureGit(fixture.dir, ['config', 'user.name', 'Review Fixture']);
			fs.writeFileSync(path.join(fixture.dir, 'tracked.txt'), 'before\n');
			fixtureGit(fixture.dir, ['add', '--', 'tracked.txt']);
			fixtureGit(fixture.dir, ['commit', '-m', 'base']);
			fixtureGit(fixture.dir, ['checkout', '-b', 'feature']);
			fs.writeFileSync(path.join(fixture.dir, 'tracked.txt'), 'after\n');
			fs.writeFileSync(path.join(fixture.dir, 'untracked.txt'), 'new\n');

			const result = await collectReviewDiff({ directory: fixture.dir });
			expect(result.status).toBe('ok');
			if (result.status !== 'ok') throw new Error('expected ok');
			expect(result.baseRef).toBe('main');
			expect(result.mergeBase).toMatch(/^[0-9a-f]{40}$/);
			expect(result.canonicalText).toContain('+after');
			expect(result.canonicalText).toContain('+++ b/untracked.txt');
			expect(result.changedLines.get('tracked.txt')).toEqual([
				{ start: 1, end: 1 },
			]);
			expect(result.changedLines.get('untracked.txt')).toEqual([
				{ start: 1, end: 1 },
			]);
		} finally {
			fixture.cleanup();
		}
	});

	test('collects merge-base through tracked working tree plus safe untracked text', async () => {
		const fixture = createSafeTestDir('review-diff-');
		try {
			fs.writeFileSync(path.join(fixture.dir, 'note.txt'), 'alpha\nbeta\n');
			const calls: Array<{ cmd: string[]; opts?: BunCompatSpawnOptions }> = [];
			let kills = 0;
			installGitStub({
				root: fixture.dir,
				diff: MULTI_FILE_DIFF,
				untracked: 'note.txt\0',
				onCall: (cmd, opts) => calls.push({ cmd, opts }),
				onKill: () => {
					kills++;
				},
			});

			const result = await collectReviewDiff({ directory: fixture.dir });
			expect(result.status).toBe('ok');
			if (result.status !== 'ok') throw new Error('expected ok');
			expect(result.baseRef).toBe('origin/main');
			expect(result.baseSha).toBe(BASE);
			expect(result.mergeBase).toBe(MERGE_BASE);
			expect(result.headSha).toBe(HEAD);
			expect(result.canonicalText).toContain(`@@ -0,0 +1,2 @@\n+alpha\n+beta`);
			expect(result.changedLines.get('note.txt')).toEqual([
				{ start: 1, end: 2 },
			]);
			expect(result.reviewTextBytes).toBe(
				Buffer.byteLength(result.canonicalText, 'utf8'),
			);
			expect(result.scopeHash).toMatch(/^[0-9a-f]{64}$/);
			expect(result.completeness.complete).toBe(true);
			expect(result.staleness.includesWorkingTree).toBe(true);
			expect(kills).toBe(calls.length);
			for (const call of calls) {
				expect(call.cmd[0]).toBe('git');
				expect(call.opts?.cwd).toBe(fixture.dir);
				expect(call.opts?.stdin).toBe('ignore');
				expect(call.opts?.timeout).toBeGreaterThan(0);
				expect(call.opts?.stdout).toBe('pipe');
				expect(call.opts?.stderr).toBe('pipe');
			}
		} finally {
			fixture.cleanup();
		}
	});

	test('keeps exact ranges committed-only and distinguishes clean/error', async () => {
		const fixture = createSafeTestDir('review-range-');
		try {
			const seen: string[] = [];
			installGitStub({
				root: fixture.dir,
				onCall: (cmd) => seen.push(cmd.join(' ')),
			});
			const clean = await collectReviewDiff({
				directory: fixture.dir,
				selector: {
					kind: 'range',
					from: 'main',
					to: 'HEAD',
					operator: '...',
				},
			});
			expect(clean.status).toBe('clean');
			expect(seen.some((line) => line.includes('ls-files'))).toBe(false);
			expect(seen.some((line) => line.includes(`${BASE}...${HEAD}`))).toBe(
				true,
			);

			installGitStub({
				root: fixture.dir,
				failCommand: 'rev-parse --show-toplevel',
			});
			const failed = await collectReviewDiff({ directory: fixture.dir });
			expect(failed.status).toBe('error');
			if (failed.status === 'error') {
				expect(failed.code).toBe('NOT_REPOSITORY_ROOT');
				expect(failed.reason).toBeString();
			}
		} finally {
			fixture.cleanup();
		}
	});

	test('rejects unsafe/binary/special paths and reports per-file and total caps', async () => {
		const fixture = createSafeTestDir('review-untracked-');
		try {
			fs.writeFileSync(path.join(fixture.dir, 'large.txt'), 'x'.repeat(80));
			fs.writeFileSync(
				path.join(fixture.dir, 'binary.bin'),
				Buffer.from([1, 0, 2]),
			);
			fs.writeFileSync(path.join(fixture.dir, 'unreadable.txt'), 'blocked');
			fs.mkdirSync(path.join(fixture.dir, 'directory'));
			_internals.openSync = ((candidate, flags) => {
				if (String(candidate).endsWith('unreadable.txt')) {
					throw Object.assign(new Error('denied'), { code: 'EACCES' });
				}
				return realOpen(candidate, flags);
			}) as typeof realOpen;
			const names = [
				'large.txt',
				'binary.bin',
				'directory',
				'unreadable.txt',
				'../escape.txt',
				'/absolute.txt',
				'C:\\drive.txt',
				'\\\\server\\share.txt',
				'bad\u0001name.txt',
			].join('\0');
			installGitStub({ root: fixture.dir, untracked: `${names}\0` });
			const result = await collectReviewDiff({
				directory: fixture.dir,
				selector: { kind: 'working-tree' },
				maxBytes: 120,
				maxUntrackedFileBytes: 20,
			});
			expect(result.status).toBe('ok');
			if (result.status !== 'ok') throw new Error('expected ok');
			expect(result.completeness.complete).toBe(false);
			expect(result.completeness.truncated).toBe(true);
			const codes = result.completeness.skipReasons.map((item) => item.code);
			expect(codes).toContain('UNTRACKED_FILE_TRUNCATED');
			expect(codes).toContain('BINARY_FILE');
			expect(codes).toContain('NON_REGULAR_FILE');
			expect(codes).toContain('UNREADABLE_FILE');
			expect(codes).toContain('UNSAFE_PATH');
		} finally {
			fixture.cleanup();
		}
	});

	test('times out a stuck subprocess and always attempts cleanup', async () => {
		const fixture = createSafeTestDir('review-timeout-');
		let killed = 0;
		try {
			const never = new Promise<number>(() => {});
			_internals.bunSpawn = (() => ({
				stdout: stream(''),
				stderr: stream(''),
				exited: never,
				exitCode: null,
				kill: () => {
					killed++;
				},
			})) as typeof realSpawn;
			const result = await collectReviewDiff({
				directory: fixture.dir,
				timeoutMs: 20,
			});
			expect(result.status).toBe('error');
			if (result.status === 'error') expect(result.code).toBe('GIT_TIMEOUT');
			expect(killed).toBe(1);
		} finally {
			fixture.cleanup();
		}
	});

	test('rejects a symlink or junction, with a platform-safe creation fallback', async () => {
		const fixture = createSafeTestDir('review-link-');
		const outside = createSafeTestDir('review-outside-');
		try {
			fs.writeFileSync(path.join(outside.dir, 'secret.txt'), 'secret');
			let linked = true;
			try {
				fs.symlinkSync(
					path.join(outside.dir, 'secret.txt'),
					path.join(fixture.dir, 'linked.txt'),
					'file',
				);
			} catch {
				linked = false;
			}
			if (!linked) {
				fs.writeFileSync(path.join(fixture.dir, 'linked.txt'), 'fallback');
				const original = _internals.lstatSync;
				_internals.lstatSync = ((candidate) => {
					if (String(candidate).endsWith('linked.txt')) {
						return {
							isSymbolicLink: () => true,
							isFile: () => false,
						} as fs.Stats;
					}
					return original(candidate);
				}) as typeof original;
			}
			installGitStub({ root: fixture.dir, untracked: 'linked.txt\0' });
			const result = await collectReviewDiff({
				directory: fixture.dir,
				selector: { kind: 'working-tree' },
			});
			expect(result.status).toBe('ok');
			if (result.status !== 'ok') throw new Error('expected ok');
			expect(result.completeness.skipReasons).toContainEqual(
				expect.objectContaining({
					path: 'linked.txt',
					code: 'SYMLINK_OR_REPARSE',
				}),
			);
		} finally {
			fixture.cleanup();
			outside.cleanup();
		}
	});
});
