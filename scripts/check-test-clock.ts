#!/usr/bin/env bun
/**
 * Issue #2094 — cross-platform TypeScript owner for the test-clock diff gate.
 *
 * The historical Bash implementation only ran where Bash and GNU grep were
 * available. This TypeScript file is now the single source of truth for the
 * gate semantics; `scripts/check-test-clock.sh` is retained as a zero-logic
 * shim so the legacy path still works.
 *
 * Semantics preserved from the Bash gate:
 * - File-scoped helper detection: a file that references the freeze-clock
 *   helpers at all is accepted.
 * - Line-scoped enforcement: only ADDED raw-clock lines in PR-touched files are
 *   blocking.
 * - Files outside the diff, or already-violating files merely touched for other
 *   reasons, count as pre-existing non-blocking warnings.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit as runGitBase } from './gate-utils';

export const BASE_BRANCH_CANDIDATES = [
	'origin/main',
	'origin/master',
	'main',
	'master',
] as const;

export const RAW_CLOCK_PATTERN =
	/Date\.now\(\)|new Date[ \t]*\([ \t]*\)|spyOn\(Date/;

export const HELPER_IMPORT_PATTERN =
	/from ['"][^'"]*(test-clock|test-isolation)\.js['"]/;

export const HELPER_CALL_PATTERN =
	/(withFrozenClock|freezeClock|withFrozenClockAsync|withIsolatedState|setupIsolatedState)\s*\(/;

export interface ClockEvaluationInput {
	file: string;
	content: string;
	inDiff: boolean;
	addedLines: string[];
}

export interface ClockEvaluationResult {
	blockingViolations: string[];
	preExistingViolations: string[];
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
			`check-test-clock: failed to run \`git ${args.join(' ')}\` — is git on PATH? (${String(error)})`,
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

export function splitNulList(raw: string): string[] {
	return raw.split('\0').filter((entry) => entry.length > 0);
}

export function normalizeRelativePath(file: string): string {
	return file.replaceAll(path.sep, '/');
}

export function fileHasClockHelper(content: string): boolean {
	return (
		HELPER_IMPORT_PATTERN.test(content) || HELPER_CALL_PATTERN.test(content)
	);
}

export function contentUsesRawClock(content: string): boolean {
	return RAW_CLOCK_PATTERN.test(content);
}

export function diffAddsRawClockLine(addedLines: string[]): boolean {
	return addedLines.some((line) => RAW_CLOCK_PATTERN.test(line));
}

export function parseAddedLines(diffOutput: string): string[] {
	return diffOutput
		.split(/\r?\n/)
		.filter((line) => line.startsWith('+') && !line.startsWith('+++'))
		.map((line) => line.slice(1));
}

export function evaluateClockFile(
	input: ClockEvaluationInput,
): ClockEvaluationResult {
	if (!contentUsesRawClock(input.content) || fileHasClockHelper(input.content)) {
		return { blockingViolations: [], preExistingViolations: [] };
	}

	if (input.inDiff && diffAddsRawClockLine(input.addedLines)) {
		return {
			blockingViolations: [
				`ERROR: ${input.file} uses the real clock (Date.now / new Date() / spyOn(Date)) but does not import or call the freezeClock helper.`,
				"       Import from '../../helpers/test-clock.js' (adjust depth) and wrap",
				'       time-sensitive assertions in withFrozenClock(() => { ... }).',
				'       (A comment mentioning the helper does NOT satisfy this check —',
				'       you must import or call it.)',
				'       See docs/testing/test-stability.md (issue #1782).',
			],
			preExistingViolations: [],
		};
	}

	return {
		blockingViolations: [],
		preExistingViolations: [input.file],
	};
}

function collectTestFiles(root: string): string[] {
	const testsRoot = path.join(root, 'tests');
	if (!fs.existsSync(testsRoot)) {
		return [];
	}

	const results: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (
				entry.isDirectory() &&
				(entry.name === 'node_modules' || entry.name === 'dist')
			) {
				continue;
			}
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}
			if (entry.isFile() && fullPath.endsWith('.test.ts')) {
				results.push(fullPath);
			}
		}
	};

	walk(testsRoot);
	results.sort();
	return results;
}

export async function main(startDir: string = process.cwd()): Promise<number> {
	const cwd = await resolveRepoRoot(startDir);
	const baseBranch = await resolveBaseBranch(cwd);
	const changedFiles = new Set<string>();

	if (baseBranch) {
		const changed = await runGit(
			['diff', '--name-only', '-z', baseBranch, 'HEAD'],
			cwd,
		);
		if (changed.exitCode === 0) {
			for (const file of splitNulList(changed.stdout)) {
				changedFiles.add(file);
			}
		}
	}

	let violations = 0;
	let newViolations = 0;
	let preExistingViolations = 0;

	for (const absFile of collectTestFiles(cwd)) {
		const relFile = normalizeRelativePath(path.relative(cwd, absFile));
		const content = fs.readFileSync(absFile, 'utf-8');
		if (!contentUsesRawClock(content)) {
			continue;
		}

		const addedLines =
			baseBranch && changedFiles.has(relFile)
				? parseAddedLines(
						(
							await runGit(['diff', baseBranch, 'HEAD', '--', relFile], cwd)
						).stdout,
					)
				: [];
		const result = evaluateClockFile({
			file: relFile,
			content,
			inDiff: changedFiles.has(relFile),
			addedLines,
		});

		for (const line of result.blockingViolations) {
			console.log(line);
		}
		if (result.blockingViolations.length > 0) {
			violations += 1;
			newViolations += 1;
			continue;
		}
		if (result.preExistingViolations.length > 0) {
			preExistingViolations += result.preExistingViolations.length;
		}
	}

	console.log('');
	console.log('=== Summary ===');
	console.log(`New violations (blocking): ${newViolations}`);
	console.log(
		`Pre-existing violations (non-blocking warnings): ${preExistingViolations}`,
	);

	if (violations > 0) {
		return 1;
	}

	console.log('All test-clock checks passed.');
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
