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

/**
 * A test fixture root aimed at the process cwd — the plugin checkout under
 * `bun test`. Tools then write `.swarm/` state (and traversal probes resolve)
 * inside the developer's repository.
 *
 * Matches `<name> = process.cwd()`, `<name>: process.cwd()` (object literals,
 * including the ToolContext `{ directory: process.cwd() }`), and the same with
 * `path.join(process.cwd(), ...)` / `resolve(process.cwd(), ...)`, where
 * `<name>` looks like a directory holder (dir/root/tmp/temp/project/workspace/
 * base/cwd-ish). Names that save the cwd for restoring it (originalCwd,
 * savedDir, prevRoot, ...) and pure reads such as `expect(x).toBe(process.cwd())`
 * are not flagged. Comment lines are skipped by the evaluator.
 */
export const CWD_TEST_ROOT_PATTERN =
	/\b(?!(?:orig|original|saved|prev|previous|old|before|initial)\w*[ \t]*[=:])\w*(?:[Dd]ir|[Dd]irectory|[Rr]oot|[Tt]emp|[Tt]mp|[Pp]roject|[Ww]orkspace|[Bb]ase|[Cc]heckout)\w*[ \t]*[=:][ \t]*(?:(?:path\.)?(?:join|resolve)\([ \t]*)?process\.cwd\(\)/;
const FS_WRITE_FNS =
	'(?:writeFileSync|mkdirSync|appendFileSync|writeFile|mkdir|copyFileSync|copyFile|cpSync|cp|renameSync|rename|symlinkSync|mkdtempSync|mkdtemp)';
/**
 * A test fs write aimed at the developer's real home directory. Bun's
 * os.homedir() ignores HOME/USERPROFILE overrides, so these land in the real
 * home even under an "isolated" env (tests/helpers/isolated-test-env.ts).
 *
 * A homedir held in a variable (`const real = os.homedir();` then
 * `writeFileSync(join(real, ...))`) is caught by tracking, per file, the names
 * assigned from homedir() on ADDED lines (see evaluateTmpdirAddedLines).
 */
export const HOMEDIR_WRITE_PATTERN = new RegExp(
	String.raw`\b${FS_WRITE_FNS}\([^;]*homedir\(\)`,
);
/** `<name> = (os.)homedir()` — captures the variable holding the real home. */
export const HOMEDIR_ASSIGN_PATTERN =
	/(?<![\w$])([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:\w+\.)?homedir\(\)/;

function isCommentLine(content: string): boolean {
	const trimmed = content.trim();
	return (
		trimmed.startsWith('//') ||
		trimmed.startsWith('*') ||
		trimmed.startsWith('/*')
	);
}

function writesViaHomeVariable(content: string, names: Set<string>): boolean {
	for (const name of names) {
		const escaped = name.replace(/[$]/g, String.raw`\$`);
		const pattern = new RegExp(
			String.raw`\b${FS_WRITE_FNS}\([^;]*(?<![\w$.])${escaped}(?![\w$])`,
		);
		if (pattern.test(content)) return true;
	}
	return false;
}

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
	const homeVars = new Map<string, Set<string>>();

	for (const line of addedLines) {
		const isComment = isCommentLine(line.content);
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
		if (!isComment && CWD_TEST_ROOT_PATTERN.test(line.content)) {
			messages.push(
				`ERROR: ${line.file}:${line.line} roots a test fixture at process.cwd() (the checkout).`,
			);
			messages.push(
				'       Use canonicalMkdtemp(prefix) from tests/helpers/tmpdir.ts (or',
			);
			messages.push(
				'       enterCwdSandbox from tests/helpers/cwd-sandbox.ts for cwd-relative probes).',
			);
			violations += 1;
		}
		const assigned = isComment
			? null
			: HOMEDIR_ASSIGN_PATTERN.exec(line.content);
		if (assigned) {
			const names = homeVars.get(line.file) ?? new Set<string>();
			names.add(assigned[1]);
			homeVars.set(line.file, names);
		}
		if (
			!isComment &&
			(HOMEDIR_WRITE_PATTERN.test(line.content) ||
				writesViaHomeVariable(
					line.content,
					homeVars.get(line.file) ?? new Set<string>(),
				))
		) {
			messages.push(
				`ERROR: ${line.file}:${line.line} writes under os.homedir() (the developer's real home).`,
			);
			messages.push(
				'       Bun ignores HOME overrides for os.homedir(); write under a temp root',
			);
			messages.push(
				'       (createIsolatedTestEnv / canonicalMkdtemp) instead.',
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
