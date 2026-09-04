#!/usr/bin/env bun
/**
 * Issue #2094 — cross-platform TypeScript owner for the mock-cleanup diff
 * gate. The retained `.sh` file is a zero-logic shim only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
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

export interface DelegationViolation {
	line: number;
	spreadVar: string;
	property: string;
}

export interface MockFileAssessment {
	missingCleanup: boolean;
	spreadViolations: SpreadViolation[];
	delegationViolations: DelegationViolation[];
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

/** Remove JavaScript comments while preserving strings, newlines, and offsets. */
export function stripCommentsPreservingLines(content: string): string {
	const output = content.split('');
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		false,
		ts.LanguageVariant.Standard,
		content,
	);
	for (
		let token = scanner.scan();
		token !== ts.SyntaxKind.EndOfFileToken;
		token = scanner.scan()
	) {
		if (
			token !== ts.SyntaxKind.SingleLineCommentTrivia &&
			token !== ts.SyntaxKind.MultiLineCommentTrivia
		) {
			continue;
		}
		for (
			let index = scanner.getTokenPos();
			index < scanner.getTextPos();
			index += 1
		) {
			if (output[index] !== '\r' && output[index] !== '\n') output[index] = ' ';
		}
	}
	return output.join('');
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

function analyzeMockSyntax(content: string): {
	mockModuleCalls: Array<{ line: number; moduleName: string | null }>;
	hasCleanup: boolean;
	hasFileScopedReset: boolean;
} {
	const sourceFile = ts.createSourceFile(
		'assessed.test.ts',
		content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const calls: Array<{ line: number; moduleName: string | null }> = [];
	let hasCleanup = false;
	let hasFileScopedReset = false;
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === 'mock' &&
			node.expression.name.text === 'module'
		) {
			const first = node.arguments[0];
			calls.push({
				line:
					sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
				moduleName: first && ts.isStringLiteralLike(first) ? first.text : null,
			});
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === 'mock' &&
			node.expression.name.text === 'restore'
		) {
			hasCleanup = true;
		}
		if (
			ts.isIdentifier(node) &&
			(node.text === 'mockClear' || node.text === 'mockReset')
		) {
			hasFileScopedReset = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { mockModuleCalls: calls, hasCleanup, hasFileScopedReset };
}

export function assessMockFile(content: string): MockFileAssessment {
	const codeContent = stripCommentsPreservingLines(content);
	const { mockModuleCalls, hasCleanup, hasFileScopedReset } =
		analyzeMockSyntax(codeContent);
	const missingCleanup =
		mockModuleCalls.length > 0 &&
		!hasCleanup &&
		!hasFileScopedReset &&
		!EXCEPTION_PATTERN.test(codeContent);

	const spreadViolations: SpreadViolation[] = [];
	const seen = new Set<string>();
	const lines = codeContent.split(/\r?\n/);
	for (const call of mockModuleCalls) {
		if (!call.moduleName?.startsWith('node:')) continue;
		const moduleName = call.moduleName.slice('node:'.length);
		if (seen.has(moduleName)) {
			continue;
		}
		seen.add(moduleName);

		const spreadVar = toSpreadVar(moduleName);
		const spreadPattern = new RegExp(`\\.\\.\\.${spreadVar}(?:[^A-Za-z0-9_]|$)`);
		const asyncImportPattern = new RegExp(
			`const\\s+${spreadVar}\\s*=\\s*await\\s+import\\(['"]node:${moduleName}['"]`,
		);
		if (!spreadPattern.test(codeContent) && !asyncImportPattern.test(codeContent)) {
			spreadViolations.push({
				module: moduleName,
				line: call.line,
				spreadVar,
			});
		}
	}

	// Issue #2260 class: a mock.module factory that spreads a captured
	// namespace import (`...realX`) and then delegates an overridden export
	// back into that same namespace (`realX.overriddenFn(...)`). Bun's
	// mock.module retroactively patches the ORIGINAL module's export slots, so
	// the "pre-mock" namespace reference resolves the overridden export to the
	// mock wrapper itself — the delegation is infinite tail recursion (an
	// unkillable loop under JSC proper tail calls), not a stack overflow. Both
	// pkg-audit-composer test files shipped this shape and hung every CI shard
	// that co-located them with pkg-audit.test.ts.
	const delegationViolations: DelegationViolation[] = [];
	const hasMockModule = mockModuleCalls.length > 0;
	if (hasMockModule) {
		const codeLines = lines.map((text, index) => ({
			lineNo: index + 1,
			text,
		}));
		// Only identifiers that are DECLARED as module namespaces can carry
		// the recursion shape — `import * as V from …`, `const V = await
		// import(…)`, or `const V = require(…)`. This excludes array spreads
		// (`[...parts]` + `parts.join(...)`), which are not module objects.
		const namespaceVars = new Set<string>();
		for (const match of codeContent.matchAll(
			/import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]/g,
		)) {
			namespaceVars.add(match[1]);
		}
		for (const match of codeContent.matchAll(
			/const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+)?(?:import|require)\s*\(/g,
		)) {
			namespaceVars.add(match[1]);
		}
		const reportedPairs = new Set<string>();
		for (const namespaceVar of namespaceVars) {
			// The namespace must actually be spread inside the file for the
			// "spread the real module, then override one export" shape.
			const spreadPattern = new RegExp(
				`\\.\\.\\.${namespaceVar}(?:[^A-Za-z0-9_$]|$)`,
			);
			if (!spreadPattern.test(codeContent)) {
				continue;
			}
			const callPattern = new RegExp(
				`${namespaceVar}\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(`,
			);
			for (const entry of codeLines) {
				const call = entry.text.match(callPattern);
				if (!call) {
					continue;
				}
				const property = call[1];
				const pair = `${namespaceVar}.${property}`;
				if (reportedPairs.has(pair)) {
					continue;
				}
				// The property must also be re-defined as an object key (the
				// override inside the factory) for the recursion shape to hold.
				const overrideKeyPattern = new RegExp(
					`(?:^|\\n)\\s*${property}\\s*:`,
				);
				if (overrideKeyPattern.test(codeContent)) {
					reportedPairs.add(pair);
					// Each violation reports its OWN call-site line (review
					// F-004: all rows previously shared the first mock.module
					// line, which mislocated multiple-factory files).
					delegationViolations.push({
						line: entry.lineNo,
						spreadVar: namespaceVar,
						property,
					});
				}
			}
		}
	}

	return { missingCleanup, spreadViolations, delegationViolations };
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

	for (const { relFile, assessment, isPrFile } of records) {
		for (const violation of assessment.delegationViolations) {
			if (isPrFile) {
				console.log(
					`ERROR: ${relFile}:${violation.line} mock.module factory delegates '${violation.spreadVar}.${violation.property}(...)' back into the spread namespace '${violation.spreadVar}'`,
				);
				console.log(
					` Bun retroactively patches the original module's exports on mock.module, so this "real" call re-enters the mock itself — infinite tail recursion that hangs the shared test process (issue #2260).`,
				);
				console.log(
					` Capture the real function BEFORE mock.module registration, or (preferred) use an _internals DI seam instead of mock.module.`,
				);
				newViolations += 1;
			} else {
				console.log(
					`WARNING: ${relFile}:${violation.line} mock.module factory delegates '${violation.spreadVar}.${violation.property}(...)' back into the spread namespace '${violation.spreadVar}' (pre-existing)`,
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
