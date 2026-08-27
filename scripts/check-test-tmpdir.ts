#!/usr/bin/env bun
/**
 * Issue #2094 — cross-platform TypeScript owner for the tmpdir diff gate.
 *
 * This file preserves the Bash gate's line-scoped semantics while making the
 * policy available on Windows without Bash. `scripts/check-test-tmpdir.sh` is a
 * retained zero-logic shim only.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit as runGitBase } from './gate-utils';

export const BASE_BRANCH_CANDIDATES = [
	'origin/main',
	'origin/master',
	'main',
	'master',
] as const;

export const RAW_TMPDIR_PATTERN = /tmpdir\(\)/;
export const REALPATH_PATTERN = /realpathSync/;
export const PROJECT_RELATIVE_TEMP_PATTERN =
	/(baseDir|tempDir|tmpDir)[ \t]*=[ \t]*['"]tmp['"]|(mkdtemp|mkdtempSync|mkdir|mkdirSync)\([^)]*['"]tmp['"]/;

export interface AddedLine {
	file: string;
	line: number;
	content: string;
}

export interface TmpdirEvaluationResult {
	messages: string[];
	violations: number;
}

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const GIT_TIMEOUT_MS = 30_000;

async function runGit(args: string[], cwd: string): Promise<GitResult> {
	try {
		return await runGitBase(args, cwd, GIT_TIMEOUT_MS);
	} catch (error) {
		throw new Error(
			`check-test-tmpdir: failed to run \`git ${args.join(' ')}\` — is git on PATH? (${String(error)})`,
		);
	}
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
	const top = await runGit(['rev-parse', '--show-toplevel'], cwd);
	if (top.exitCode !== 0) {
		return cwd;
	}
	const trimmed = top.stdout.trim();
	return trimmed.length > 0 ? path.resolve(trimmed) : cwd;
}

export async function resolveBaseBranch(cwd: string): Promise<string | null> {
	for (const branch of BASE_BRANCH_CANDIDATES) {
		if ((await runGit(['rev-parse', branch], cwd)).exitCode === 0) {
			return branch;
		}
	}
	return null;
}

export function parseUnifiedZeroAddedLines(diffOutput: string): AddedLine[] {
	const added: AddedLine[] = [];
	let currentFile = '';
	let currentLine = 0;

	for (const rawLine of diffOutput.split(/\r?\n/)) {
		if (rawLine.startsWith('+++ ')) {
			currentFile = rawLine.slice(4).replace(/^b\//, '');
			continue;
		}
		if (rawLine.startsWith('@@ ')) {
			const match = rawLine.match(/\+(\d+)/);
			currentLine = match ? Number.parseInt(match[1], 10) : 0;
			continue;
		}
		if (rawLine.startsWith('--- ')) {
			continue;
		}
		if (rawLine.startsWith('+')) {
			added.push({
				file: currentFile,
				line: currentLine,
				content: rawLine.slice(1),
			});
			currentLine += 1;
		}
	}

	return added;
}

export function evaluateTmpdirAddedLines(
	addedLines: AddedLine[],
): TmpdirEvaluationResult {
	const messages: string[] = [];
	let violations = 0;

	for (const line of addedLines) {
		if (RAW_TMPDIR_PATTERN.test(line.content) && !REALPATH_PATTERN.test(line.content)) {
			messages.push(
				`ERROR: ${line.file}:${line.line} adds a raw tmpdir() call not wrapped in realpathSync.`,
			);
			messages.push(
				'       Use canonicalTmpDir() / canonicalMkdtemp(prefix) from tests/helpers/tmpdir.ts',
			);
			messages.push(
				'       (or wrap with fs.realpathSync(...) on the same line) to close the macOS',
			);
			messages.push(
				'       /var -> /private/var symlink gap. See FR-011 (issue #1737).',
			);
			violations += 1;
		}
		if (PROJECT_RELATIVE_TEMP_PATTERN.test(line.content)) {
			messages.push(
				`ERROR: ${line.file}:${line.line} adds a project-relative test temp root.`,
			);
			messages.push(
				'       Use canonicalMkdtemp(prefix) from tests/helpers/tmpdir.ts so fixtures',
			);
			messages.push(
				'       remain outside the repository and are realpath-canonicalized.',
			);
			violations += 1;
		}
	}

	return { messages, violations };
}

export async function main(startDir: string = process.cwd()): Promise<number> {
	const cwd = await resolveRepoRoot(startDir);
	const baseBranch = await resolveBaseBranch(cwd);

	if (!baseBranch) {
		console.log(
			'check-test-tmpdir: no base branch found (no PR context) — skipping (non-blocking).',
		);
		return 0;
	}

	const diffOutput = (
		await runGit(
		['diff', '--unified=0', baseBranch, 'HEAD', '--', '*.test.ts'],
		cwd,
		)
	).stdout;

	if (diffOutput.length === 0) {
		console.log(
			'check-test-tmpdir: no test file changes in diff — nothing to check.',
		);
		return 0;
	}

	const result = evaluateTmpdirAddedLines(parseUnifiedZeroAddedLines(diffOutput));
	for (const line of result.messages) {
		console.log(line);
	}

	console.log('');
	console.log('=== Summary ===');
	console.log(`New violations (blocking): ${result.violations}`);

	if (result.violations > 0) {
		return 1;
	}

	console.log('All new/changed test temp roots are external and canonicalized.');
	return 0;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
	void main()
		.then((exitCode) => {
			process.exit(exitCode);
		})
		.catch((error) => {
			throw error;
		});
}
