#!/usr/bin/env bun
/**
 * Issue #2078 — cross-platform port of the FR-006 500-line test-file cap
 * ratchet (originally `scripts/check-test-file-cap.sh`, issue #1781 E1).
 *
 * The Bash original could not run on a Windows host without Bash in PATH, so
 * Windows contributors had no way to verify the cap locally before pushing and
 * fell back to manual line counting (issue #2078). This TypeScript
 * implementation is the SINGLE source of truth for the cap value and the
 * ratchet semantics; `scripts/check-test-file-cap.sh` is now a zero-logic shim
 * that `exec`s this file, so the two entry points cannot drift.
 *
 * Run it anywhere (Windows PowerShell, macOS, Linux):
 *
 *   bun run check:test-file-cap
 *
 * Ratchet semantics (unchanged from the Bash original):
 *   - Pre-existing over-cap files NOT in the PR diff → non-blocking (silent).
 *   - NEW test files in the diff over the cap → ERROR (blocking).
 *   - MODIFIED test files in the diff that are over the cap AND grew →
 *     ERROR (ratchet arm).
 *   - MODIFIED over-cap files that shrank or stayed equal → pass.
 *   - Pre-existing violators never fail unrelated PRs.
 *
 * Escape hatch: TEST_CAP_ENFORCE. Default is ENFORCE (unset → hard-fail),
 * the opposite of DRIFT_CHECK_ENFORCE's default, because the ratchet is
 * already scoped to new/grown files only. Set
 *   TEST_CAP_ENFORCE=0|false|no|off
 * to soft-warn (print violations, exit 0) — useful for a deliberate growth PR.
 *
 * Line-ending handling: CR is stripped before counting so a pure CRLF→LF
 * normalization does not false-fail "grew by 1". Line counts match `wc -l`
 * semantics exactly (a trailing line without a newline is not counted), so a
 * file's number is identical to what the Bash original reported.
 *
 * Rename handling: `git diff --diff-filter=A --find-renames=100%` treats only
 * exact-content renames as renames (R); a renamed+grown file falls below 100%
 * similarity → classified as Added → flagged by the new-file arm.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The FR-006 cap. This is the ONLY place the value is declared. */
export const MAX_LINES = 500;

/** Base branches probed, in order, to resolve the PR base. */
export const BASE_BRANCH_CANDIDATES = [
	'origin/main',
	'origin/master',
	'main',
	'master',
] as const;

/** Only `*.test.ts` files participate in the cap. */
export const TEST_FILE_PATTERN = /\.test\.ts$/;

/**
 * TEST_CAP_ENFORCE truth table (issue #1781 re-critic B5):
 * unset OR any value other than 0/false/no/off → hard-fail (default enforce).
 * 0/false/no/off → soft-warn (exit 0).
 */
export function resolveEnforce(raw: string | undefined): boolean {
	if (raw === undefined) {
		return true;
	}
	// No trimming: the Bash original compared the raw value, so " off " meant
	// enforce. Trimming here would silently DISABLE the gate for a
	// whitespace-padded value — a divergence in the permissive direction.
	switch (raw.toLowerCase()) {
		case '0':
		case 'false':
		case 'no':
		case 'off':
			return false;
		default:
			return true;
	}
}

/**
 * `wc -l`-equivalent line count with CR stripped first. Counts newline
 * characters, so a file whose final line lacks a trailing newline reports the
 * same number the Bash original did.
 */
export function normalizedLineCount(content: string): number {
	let count = 0;
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10 /* \n */) {
			count++;
		}
	}
	return count;
}

export interface CapEvaluationInput {
	/** Files changed between the base branch and HEAD (repo-relative paths). */
	changedFiles: string[];
	/** Subset of `changedFiles` classified as added (or non-exact renames). */
	addedFiles: string[];
	/** Current normalized line count, or `null` if the path is not a file. */
	currentLineCount: (file: string) => number | null;
	/** Normalized line count at the base branch; 0 when absent at base. */
	baseLineCount: (file: string) => number;
	maxLines?: number;
	enforce: boolean;
}

export interface CapEvaluationResult {
	messages: string[];
	newFileViolations: number;
	ratchetViolations: number;
	violations: number;
	exitCode: number;
}

/**
 * Pure ratchet evaluation. All I/O (git, filesystem) is injected so the
 * decision table is directly unit-testable without a temp git repository.
 */
export function evaluateCap(input: CapEvaluationInput): CapEvaluationResult {
	const maxLines = input.maxLines ?? MAX_LINES;
	const added = new Set(input.addedFiles);
	const messages: string[] = [];
	let newFileViolations = 0;
	let ratchetViolations = 0;

	for (const file of input.changedFiles) {
		if (!file || !TEST_FILE_PATTERN.test(file)) {
			continue;
		}
		const nowLines = input.currentLineCount(file);
		if (nowLines === null) {
			// Deleted in the diff, or otherwise not a regular file in the tree.
			continue;
		}
		if (nowLines <= maxLines) {
			continue;
		}

		if (added.has(file)) {
			messages.push(
				`ERROR (new file): ${file} is ${nowLines} lines (cap ${maxLines}, FR-006).`,
			);
			messages.push(
				'  Split it by behavior/feature into focused files under 500 lines.',
			);
			newFileViolations++;
			continue;
		}

		const baseLines = input.baseLineCount(file);
		if (baseLines === 0) {
			// File did not exist at base under this path (rename/delete-readd) →
			// treat as new.
			messages.push(
				`ERROR (new path): ${file} is ${nowLines} lines (cap ${maxLines}, FR-006); not present at base.`,
			);
			newFileViolations++;
			continue;
		}

		if (nowLines > baseLines) {
			messages.push(
				`ERROR (ratchet): ${file} grew from ${baseLines} to ${nowLines} lines (cap ${maxLines}, FR-006).`,
			);
			messages.push(
				'  Over-cap files must not grow. Split the new behavior into a separate file.',
			);
			ratchetViolations++;
			continue;
		}

		// Over cap but shrank or equal → pass (ratchet allows shrinkage).
	}

	const violations = newFileViolations + ratchetViolations;

	messages.push('');
	messages.push('=== Test file cap (FR-006) summary ===');
	messages.push(`New-file violations: ${newFileViolations}`);
	messages.push(`Ratchet violations:  ${ratchetViolations}`);

	let exitCode = 0;
	if (violations > 0) {
		if (input.enforce) {
			messages.push('TEST_CAP_ENFORCE is on (default). Failing the build.');
			exitCode = 1;
		} else {
			messages.push('TEST_CAP_ENFORCE is off — soft-warn (non-blocking).');
		}
	} else {
		messages.push('All test-file-cap checks passed.');
	}

	return {
		messages,
		newFileViolations,
		ratchetViolations,
		violations,
		exitCode,
	};
}

// --- git plumbing -----------------------------------------------------------

interface GitResult {
	exitCode: number;
	stdout: string;
}

function runGit(args: string[], cwd: string): GitResult {
	let proc: ReturnType<typeof Bun.spawnSync>;
	try {
		proc = Bun.spawnSync({
			cmd: ['git', ...args],
			cwd,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
	} catch (error) {
		// `git` missing from PATH would otherwise surface as a raw Bun stack
		// trace with no hint about what the gate needs.
		throw new Error(
			`check-test-file-cap: failed to run \`git ${args.join(' ')}\` — is git on PATH? (${String(error)})`,
		);
	}
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
	};
}

/**
 * Resolve the repository root so the gate behaves identically no matter which
 * directory a contributor runs it from. `git diff --name-only` emits
 * root-relative paths; resolving them against an arbitrary cwd made every
 * `statSync` miss, which the gate reported as "all checks passed" — a silent
 * vacuous pass (issue #2078 review finding 2). Falls back to `cwd` when the
 * directory is not a git worktree, where there is nothing to compare anyway.
 */
export function resolveRepoRoot(cwd: string): string {
	const top = runGit(['rev-parse', '--show-toplevel'], cwd);
	if (top.exitCode !== 0) {
		return cwd;
	}
	const trimmed = top.stdout.trim();
	return trimmed.length > 0 ? path.resolve(trimmed) : cwd;
}

/** Split a NUL-separated `git -z` path list. */
export function splitNulList(raw: string): string[] {
	return raw.split('\0').filter((entry) => entry.length > 0);
}

export function resolveBaseBranch(cwd: string): string | null {
	for (const branch of BASE_BRANCH_CANDIDATES) {
		if (runGit(['rev-parse', branch], cwd).exitCode === 0) {
			return branch;
		}
	}
	return null;
}

export function main(startDir: string = process.cwd()): number {
	const cwd = resolveRepoRoot(startDir);
	const baseBranch = resolveBaseBranch(cwd);

	let changedFiles: string[] = [];
	let addedFiles: string[] = [];
	if (baseBranch) {
		const changed = runGit(['diff', '--name-only', '-z', baseBranch, 'HEAD'], cwd);
		if (changed.exitCode === 0) {
			changedFiles = splitNulList(changed.stdout);
		}
		const addedResult = runGit(
			[
				'diff',
				'--diff-filter=A',
				'--name-only',
				'-z',
				'--find-renames=100%',
				baseBranch,
				'HEAD',
			],
			cwd,
		);
		if (addedResult.exitCode === 0) {
			addedFiles = splitNulList(addedResult.stdout);
		}
	}

	const result = evaluateCap({
		changedFiles,
		addedFiles,
		enforce: resolveEnforce(process.env.TEST_CAP_ENFORCE),
		currentLineCount: (file) => {
			const abs = path.resolve(cwd, file);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(abs);
			} catch {
				return null;
			}
			if (!stat.isFile()) {
				return null;
			}
			return normalizedLineCount(fs.readFileSync(abs, 'utf-8').replace(/\r/g, ''));
		},
		baseLineCount: (file) => {
			if (!baseBranch) {
				return 0;
			}
			const show = runGit(['show', `${baseBranch}:${file}`], cwd);
			if (show.exitCode !== 0) {
				return 0;
			}
			return normalizedLineCount(show.stdout.replace(/\r/g, ''));
		},
	});

	for (const line of result.messages) {
		console.log(line);
	}
	return result.exitCode;
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) ===
		path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
	process.exit(main());
}
