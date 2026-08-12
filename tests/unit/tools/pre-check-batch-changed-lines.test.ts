import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	classifySastFindings,
	getChangedLineRanges,
} from '../../../src/tools/pre-check-batch';
import type { SastScanFinding } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalRunExternalTool = _internals.runExternalTool;
const originalPlatform = _internals.platform;
const tempDirs: string[] = [];

function git(cwd: string, args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: 'ignore',
		timeout: 10_000,
		windowsHide: true,
	});
}

function write(root: string, file: string, content: string): void {
	const target = path.join(root, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

function finding(root: string, file: string, line: number): SastScanFinding {
	return {
		rule_id: `${file}:${line}`,
		severity: 'high',
		message: 'test',
		location: { file: path.join(root, file), line },
	};
}

afterEach(() => {
	_internals.runExternalTool = originalRunExternalTool;
	_internals.platform = originalPlatform;
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('getChangedLineRanges union', () => {
	test('unions committed, staged, unstaged, renamed, and untracked sources', async () => {
		const root = canonicalMkdtemp('precheck-lines-');
		tempDirs.push(root);
		git(root, ['init', '-b', 'main']);
		git(root, ['config', 'user.email', 'test@example.com']);
		git(root, ['config', 'user.name', 'Test']);
		for (const file of [
			'committed.ts',
			'staged space.ts',
			'unstaged-☃.ts',
			'legacy.ts',
			'old name.ts',
			'a/security.ts',
			'b/security.ts',
		]) {
			write(root, file, 'one\ntwo\nthree\n');
		}
		git(root, ['add', '.']);
		git(root, ['commit', '-m', 'base']);
		git(root, ['checkout', '-b', 'feature']);

		write(root, 'committed.ts', 'one\ncommitted\nthree\n');
		git(root, ['add', 'committed.ts']);
		git(root, ['commit', '-m', 'feature']);
		write(root, 'staged space.ts', 'one\nstaged\nthree\n');
		git(root, ['add', 'staged space.ts']);
		write(root, 'a/security.ts', 'one\nnew staged finding\nthree\n');
		git(root, ['add', 'a/security.ts']);
		write(root, 'b/security.ts', 'one\nnew unstaged finding\nthree\n');
		write(root, 'unstaged-☃.ts', 'one\nunstaged\nthree\n');
		git(root, ['mv', 'old name.ts', 'renamed name.ts']);
		write(root, 'renamed name.ts', 'one\nrenamed\nthree\n');
		write(root, 'untracked &(新).ts', 'new\nsecret\n');

		const ranges = await getChangedLineRanges(root);
		expect(ranges).not.toBeNull();
		expect(ranges?.get('committed.ts')?.has(2)).toBe(true);
		expect(ranges?.get('staged space.ts')?.has(2)).toBe(true);
		expect(ranges?.get('unstaged-☃.ts')?.has(2)).toBe(true);
		expect(ranges?.has('renamed name.ts')).toBe(true);
		expect(ranges?.get('a/security.ts')?.has(2)).toBe(true);
		expect(ranges?.get('b/security.ts')?.has(2)).toBe(true);
		const prefixedPathClassification = classifySastFindings(
			[finding(root, 'a/security.ts', 2), finding(root, 'b/security.ts', 2)],
			ranges,
			root,
		);
		expect(prefixedPathClassification.newFindings).toHaveLength(2);
		expect(prefixedPathClassification.preexistingFindings).toHaveLength(0);

		const classified = classifySastFindings(
			[finding(root, 'untracked &(新).ts', 999), finding(root, 'legacy.ts', 2)],
			ranges,
			root,
		);
		expect(classified.newFindings).toHaveLength(1);
		expect(classified.preexistingFindings).toHaveLength(1);
	});

	test('a required Git-source failure returns unavailable evidence', async () => {
		_internals.runExternalTool = async (options) => {
			const base = {
				exitCode: 0,
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			} as const;
			if (options.args.includes('--cached')) {
				return { ...base, status: 'timeout', exitCode: null, stdout: '' };
			}
			return {
				...base,
				status: 'completed',
				stdout: options.args[0] === 'merge-base' ? `${'a'.repeat(40)}\n` : '',
			};
		};
		expect(await getChangedLineRanges(path.resolve('.'))).toBeNull();
	});

	test.each([
		['unknown status code', 'ZZ file.ts\0'],
		['rename without source path', 'R  renamed.ts\0'],
		[
			'rename consuming a following status record',
			'R  renamed.ts\0?? secret.ts\0',
		],
	] as const)('malformed porcelain status (%s) returns unavailable evidence', async (_name, statusOutput) => {
		_internals.runExternalTool = async (options) => ({
			status: 'completed',
			exitCode: 0,
			stdout:
				options.args[0] === 'merge-base'
					? `${'a'.repeat(40)}\n`
					: options.args.includes('status')
						? statusOutput
						: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		const root = path.resolve('.');
		const ranges = await getChangedLineRanges(root);
		expect(ranges).toBeNull();
		const classified = classifySastFindings(
			[finding(root, 'secret.ts', 1)],
			ranges,
			root,
		);
		expect(classified.newFindings).toHaveLength(1);
		expect(classified.preexistingFindings).toHaveLength(0);
	});

	test.each([
		'committed',
		'staged',
		'unstaged',
	] as const)('malformed %s diff returns unavailable evidence and findings fail closed', async (malformedSource) => {
		const malformedDiff = [
			'diff --git src/security.ts src/security.ts',
			'--- src/security.ts',
			'+++ src/security.ts',
			'@@ malformed @@',
		].join('\n');
		_internals.runExternalTool = async (options) => {
			const args = options.args;
			const source = args.includes('--cached')
				? 'staged'
				: args.some((arg) => arg.endsWith('..HEAD'))
					? 'committed'
					: args.includes('diff')
						? 'unstaged'
						: 'other';
			return {
				status: 'completed',
				exitCode: 0,
				stdout:
					args[0] === 'merge-base'
						? `${'a'.repeat(40)}\n`
						: source === malformedSource
							? malformedDiff
							: '',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		const ranges = await getChangedLineRanges(path.resolve('.'));
		expect(ranges).toBeNull();
		const classified = classifySastFindings(
			[finding(path.resolve('.'), 'src/security.ts', 7)],
			ranges,
			path.resolve('.'),
		);
		expect(classified.newFindings).toHaveLength(1);
		expect(classified.preexistingFindings).toHaveLength(0);
	});

	test('an empty destination path makes changed-line evidence unavailable', async () => {
		const malformedDiff =
			'diff --git src/security.ts src/security.ts\n--- src/security.ts\n+++ \n@@ -1 +1 @@\n';
		_internals.runExternalTool = async (options) => ({
			status: 'completed',
			exitCode: 0,
			stdout:
				options.args[0] === 'merge-base'
					? `${'a'.repeat(40)}\n`
					: options.args.includes('--cached')
						? malformedDiff
						: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		expect(await getChangedLineRanges(path.resolve('.'))).toBeNull();
	});

	test('preserves non-BMP Unicode adjacent to Git path escapes', async () => {
		const repoPath = 'src/😀\tunsafe.ts';
		const quotedPath = '"src/😀\\tunsafe.ts"';
		const diff = `diff --git ${quotedPath} ${quotedPath}\n--- ${quotedPath}\n+++ ${quotedPath}\n@@ -0,0 +1 @@\n`;
		_internals.runExternalTool = async (options) => ({
			status: 'completed',
			exitCode: 0,
			stdout:
				options.args[0] === 'merge-base'
					? `${'a'.repeat(40)}\n`
					: options.args.includes('--cached')
						? diff
						: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		const root = path.resolve('.');
		const ranges = await getChangedLineRanges(root);
		expect(ranges?.get(repoPath)?.has(1)).toBe(true);
		const classified = classifySastFindings(
			[finding(root, repoPath, 1)],
			ranges,
			root,
		);
		expect(classified.newFindings).toHaveLength(1);
		expect(classified.preexistingFindings).toHaveLength(0);
	});

	test('an implausibly large hunk is rejected without iterating its range', async () => {
		const hugeDiff = [
			'diff --git src/security.ts src/security.ts',
			'--- src/security.ts',
			'+++ src/security.ts',
			'@@ -1 +1,2147483647 @@',
		].join('\n');
		_internals.runExternalTool = async (options) => ({
			status: 'completed',
			exitCode: 0,
			stdout:
				options.args[0] === 'merge-base'
					? `${'a'.repeat(40)}\n`
					: options.args.includes('--cached')
						? hugeDiff
						: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		});

		expect(await getChangedLineRanges(path.resolve('.'))).toBeNull();
	});

	test('matches changed paths case-insensitively on Windows', () => {
		_internals.platform = () => 'win32';
		const root = path.resolve('C:\\repo');
		const ranges = new Map([['src/security.ts', new Set([7])]]);

		const classified = classifySastFindings(
			[finding(root, 'SRC/SECURITY.TS', 7)],
			ranges,
			root,
		);

		expect(classified.newFindings).toHaveLength(1);
		expect(classified.preexistingFindings).toHaveLength(0);
	});
});
