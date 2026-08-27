#!/usr/bin/env bun
/**
 * Issue #2094 — cross-platform TypeScript owner for the mock-cleanup diff
 * gate. The retained `.sh` file is a zero-logic shim only.
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

export const MOCK_MODULE_PATTERN = /mock\.module\(/;
export const CLEANUP_PATTERN = /mock\.restore/;
export const FILE_SCOPED_PATTERN = /mockClear|mockReset/;
export const EXCEPTION_PATTERN =
	/skip.*mock\.restore|NOT.*mock\.restore|no.*mock\.restore|file-scoped|mockClear|mockReset/;

export interface SpreadViolation {
	module: string;
	line: number;
	spreadVar: string;
}

export interface MockFileAssessment {
	missingCleanup: boolean;
	spreadViolations: SpreadViolation[];
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
			`check-mock-cleanup: failed to run \`git ${args.join(' ')}\` — is git on PATH? (${String(error)})`,
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

export function toSpreadVar(moduleName: string): string {
	let camel = '';
	let upperNext = true;
	for (const char of moduleName) {
		if (char === '_' || char === '/') {
			upperNext = true;
			continue;
		}
		if (upperNext) {
			camel += char.toUpperCase();
			upperNext = false;
			continue;
		}
		camel += char;
	}
	return `real${camel}`;
}

export function listCandidateTestFiles(root: string): string[] {
	const results: string[] = [];
	for (const topLevel of ['tests', 'src']) {
		const start = path.join(root, topLevel);
		if (!fs.existsSync(start)) {
			continue;
		}
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(fullPath);
					continue;
				}
				if (!entry.isFile() || !fullPath.endsWith('.test.ts')) {
					continue;
				}
				const rel = normalizeRelativePath(path.relative(root, fullPath));
				if (
					rel.startsWith('tests/unit/scripts/temp-test-files/') ||
					rel === 'tests/unit/scripts/check-mock-cleanup.test.ts'
				) {
					continue;
				}
				results.push(fullPath);
			}
		};
		walk(start);
	}
	return results;
}

export function assessMockFile(content: string): MockFileAssessment {
	const missingCleanup =
		MOCK_MODULE_PATTERN.test(content) &&
		!CLEANUP_PATTERN.test(content) &&
		!FILE_SCOPED_PATTERN.test(content) &&
		!EXCEPTION_PATTERN.test(content);

	const spreadViolations: SpreadViolation[] = [];
	const seen = new Set<string>();
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(/mock\.module\(['"]node:([^'"]+)['"]/);
		if (!match) {
			continue;
		}
		const moduleName = match[1];
		if (seen.has(moduleName)) {
			continue;
		}
		seen.add(moduleName);

		const spreadVar = toSpreadVar(moduleName);
		const spreadPattern = new RegExp(`\\.\\.\\.${spreadVar}(?:[^A-Za-z0-9_]|$)`);
		const asyncImportPattern = new RegExp(
			`const\\s+${spreadVar}\\s*=\\s*await\\s+import\\(['"]node:${moduleName}['"]`,
		);
		if (!spreadPattern.test(content) && !asyncImportPattern.test(content)) {
			spreadViolations.push({
				module: moduleName,
				line: index + 1,
				spreadVar,
			});
		}
	}

	return { missingCleanup, spreadViolations };
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

	let newViolations = 0;
	let preExistingViolations = 0;
	const records = listCandidateTestFiles(cwd).flatMap((absFile) => {
		const relFile = normalizeRelativePath(path.relative(cwd, absFile));
		const content = fs.readFileSync(absFile, 'utf-8');
		if (!MOCK_MODULE_PATTERN.test(content)) {
			return [];
		}
		return [{ relFile, assessment: assessMockFile(content), isPrFile: changedFiles.has(relFile) }];
	});

	// Preserve the Bash owner's two-pass output order: cleanup findings first,
	// then node:* spread findings. This order is part of the byte-parity contract.
	for (const { relFile, assessment, isPrFile } of records) {
		if (assessment.missingCleanup) {
			if (isPrFile) {
				console.log(
					`ERROR: ${relFile} uses mock.module but has no afterEach(mock.restore()) cleanup`,
				);
				console.log(
					'       Add afterEach(() => mock.restore()), or use file-scoped pattern',
				);
				console.log(
					'       (mock.module at top + mockClear/mockReset in beforeEach),',
				);
				console.log("       or document why it's skipped");
				newViolations += 1;
			} else {
				console.log(
					`WARNING: ${relFile} uses mock.module but has no afterEach(mock.restore()) cleanup (pre-existing)`,
				);
				preExistingViolations += 1;
			}
		}
	}

	for (const { relFile, assessment, isPrFile } of records) {
		for (const violation of assessment.spreadViolations) {
			if (isPrFile) {
				console.log(
					`ERROR: ${relFile}:${violation.line} uses mock.module('node:${violation.module}', ...) without spreading real exports`,
				);
				console.log(
					` Add ...${violation.spreadVar} to the returned object, e.g.:`,
				);
				console.log(
					` mock.module('node:${violation.module}', () => ({ ...${violation.spreadVar}, ... }))`,
				);
				console.log(' or:');
				console.log(
					` mock.module('node:${violation.module}', async () => { const ${violation.spreadVar} = await import('node:${violation.module}'); return { ...${violation.spreadVar}, ... } })`,
				);
				newViolations += 1;
			} else {
				console.log(
					`WARNING: ${relFile}:${violation.line} uses mock.module('node:${violation.module}', ...) without spreading real exports (pre-existing)`,
				);
				preExistingViolations += 1;
			}
		}
	}

	if (newViolations > 0) {
		console.log('');
		console.log(`${newViolations} NEW violation(s) introduced by this PR. See errors above.`);
		console.log(
			`${preExistingViolations} pre-existing violation(s) also found (non-blocking).`,
		);
		return 1;
	}

	if (preExistingViolations > 0) {
		console.log('');
		console.log(
			`${preExistingViolations} pre-existing violation(s) found (non-blocking).`,
		);
		console.log(
			'All test files with mock.module have proper cleanup and spread real exports.',
		);
		return 0;
	}

	console.log(
		'All test files with mock.module have proper cleanup and spread real exports.',
	);
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
