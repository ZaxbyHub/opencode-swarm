/**
 * Directive verification predicate runner (Swarm Learning System, Change 2 /
 * Task 2.2).
 *
 * Executes a small, fail-closed predicate DSL attached to a knowledge directive
 * (`verification_predicate`). Handlers:
 *
 *   grep:<regex>:<path-glob>   PASS when ripgrep finds zero matches in the glob.
 *                              (A "forbidden pattern" predicate: absence = pass.)
 *   tool:<argv>                PASS when the command exits 0. Shell-free (argv
 *                              array), binary must be on a conservative allowlist.
 *   file_not_modified:<path>   PASS when <path> is unchanged in the working tree.
 *   file_modified:<path>       PASS when <path> is changed in the working tree.
 *
 * Security posture (the adversarial contract):
 *   - No shell, ever. Commands run via argv arrays (`bunSpawn`), so shell
 *     metacharacters (; | && $() ` > <) are inert literals.
 *   - Path/glob arguments are validated to stay inside the working directory:
 *     null bytes, absolute paths, and `..` traversal are rejected.
 *   - `tool:` binaries are restricted to a conservative read-only allowlist;
 *     code interpreters (node/bun/python/deno/npx) are intentionally excluded.
 *   - Hard 15s timeout; the child is killed on timeout.
 *   - Fail-closed: any parse error, unknown handler, disallowed path, or
 *     unexpected state returns `result:'error'` (never silently `pass`).
 *
 * Residual risk: true network isolation is not available in this runtime. The
 * mitigation is the absence of network-capable binaries from the allowlist plus
 * the hard timeout. Build tools that can run arbitrary scripts (cargo/go) are
 * NOT on the allowlist for this reason.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { bunSpawn } from '../utils/bun-compat.js';
import { warn } from '../utils/logger.js';

export type PredicateResult = 'pass' | 'fail' | 'error';

export interface PredicateOutcome {
	result: PredicateResult;
	detail: string;
}

/** Hard wall-clock cap for any single predicate execution. */
export const PREDICATE_TIMEOUT_MS = 15_000;

/**
 * Conservative allowlist of `tool:` binaries. Read-only verification/lint tools
 * only. Code interpreters and arbitrary build runners are deliberately excluded
 * because they can execute attacker-influenced code or reach the network.
 */
export const TOOL_BINARY_ALLOWLIST: ReadonlySet<string> = new Set([
	'rg',
	'grep',
	'git',
	'biome',
	'eslint',
	'tsc',
	'ruff',
]);

// ============================================================================
// Path validation
// ============================================================================

/**
 * Validate that a repo-relative path/glob stays inside `directory`. Returns the
 * trimmed value on success or null when it is unsafe. Globs (`*`, `**`, `?`,
 * `{}`) are permitted; traversal and absolute paths are not.
 */
export function validateRepoRelativeGlob(
	directory: string,
	value: string,
): string | null {
	const v = value.trim();
	if (!v) return null;
	if (v.includes('\0')) return null;
	// Reject absolute paths (POSIX and Windows).
	if (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\')) {
		return null;
	}
	// Reject any parent traversal segment.
	const segments = v.split(/[/\\]/);
	if (segments.some((s) => s === '..')) return null;
	// Defense-in-depth: resolve the non-glob prefix and confirm containment.
	const globStart = v.search(/[*?{[]/);
	const concrete = globStart === -1 ? v : v.slice(0, globStart);
	if (concrete) {
		const baseDir = path.resolve(directory);
		const resolved = path.resolve(baseDir, concrete);
		const rel = path.relative(baseDir, resolved);
		if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	}
	return v;
}

// ============================================================================
// Subprocess helper
// ============================================================================

/** Find a binary on PATH (Bun.which misses runtime PATH changes). */
function findBinaryInPath(binary: string): string | null {
	const isWindows = process.platform === 'win32';
	const exeName = isWindows ? `${binary}.exe` : binary;
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, exeName);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

interface RunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Minimal, network-poor environment for predicate subprocesses. */
function safeChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	if (process.env.PATH) env.PATH = process.env.PATH;
	if (process.env.HOME) env.HOME = process.env.HOME;
	if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
	if (process.env.TEMP) env.TEMP = process.env.TEMP;
	if (process.env.TMP) env.TMP = process.env.TMP;
	return env;
}

/** Run an argv array, shell-free, with a hard timeout. Never throws.
 *  AGENTS.md invariant 3: stdin is 'ignore' (a never-closed stdin pipe can
 *  block the child from exiting under Bun on Windows) and the child is
 *  best-effort killed in `finally` so no code path leaks a process. */
export async function runArgv(argv: string[], cwd: string): Promise<RunResult> {
	const proc = bunSpawn(argv, {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		cwd,
		env: safeChildEnv(),
	});
	let finished = false;
	try {
		const timeout = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), PREDICATE_TIMEOUT_MS),
		);
		const raced = await Promise.race([proc.exited, timeout]);
		if (raced === 'timeout') {
			return { exitCode: null, stdout: '', stderr: '', timedOut: true };
		}
		// Each read is independently guarded with `.catch(() => '')`, so a stream
		// read failure resolves to '' rather than rejecting. Promise.all therefore
		// cannot reject here, guaranteeing `finished = true` is reached on every
		// non-timeout path — the `finally` kill only fires on the timeout return.
		const [stdout, stderr] = await Promise.all([
			proc.stdout.text().catch(() => ''),
			proc.stderr.text().catch(() => ''),
		]);
		finished = true;
		return { exitCode: proc.exitCode, stdout, stderr, timedOut: false };
	} finally {
		if (!finished) {
			try {
				proc.kill();
			} catch {
				/* best-effort */
			}
		}
	}
}

// ============================================================================
// Handlers
// ============================================================================

async function runGrepPredicate(
	rest: string,
	directory: string,
): Promise<PredicateOutcome> {
	// Format: <regex>:<path-glob>. Split on the LAST colon so regexes may
	// contain colons; the glob never legitimately does.
	const lastColon = rest.lastIndexOf(':');
	if (lastColon <= 0 || lastColon === rest.length - 1) {
		return { result: 'error', detail: 'grep: expected <regex>:<path-glob>' };
	}
	const regex = rest.slice(0, lastColon);
	const rawGlob = rest.slice(lastColon + 1);
	const glob = validateRepoRelativeGlob(directory, rawGlob);
	if (glob === null) {
		return {
			result: 'error',
			detail: `grep: unsafe or empty path-glob "${rawGlob}"`,
		};
	}
	const rg = findBinaryInPath('rg');
	if (!rg) return { result: 'error', detail: 'grep: ripgrep (rg) not found' };
	// `--` terminates option parsing so a regex starting with `-` is not a flag.
	const argv = [
		rg,
		'--count-matches',
		'--no-messages',
		'--glob',
		glob,
		'--',
		regex,
		'.',
	];
	const res = await runArgv(argv, directory);
	if (res.timedOut) {
		return { result: 'error', detail: 'grep: timed out' };
	}
	// ripgrep exit: 0 = matches found, 1 = no matches, 2 = error.
	if (res.exitCode === 1) {
		return { result: 'pass', detail: 'grep: zero matches' };
	}
	if (res.exitCode === 0) {
		const count = res.stdout
			.split('\n')
			.map((l) => Number.parseInt(l.split(':').pop() ?? '0', 10))
			.filter((n) => !Number.isNaN(n))
			.reduce((a, b) => a + b, 0);
		return { result: 'fail', detail: `grep: ${count} match(es) found` };
	}
	return {
		result: 'error',
		detail: `grep: ripgrep error (exit ${res.exitCode}) ${res.stderr.slice(0, 200)}`,
	};
}

async function runToolPredicate(
	rest: string,
	directory: string,
): Promise<PredicateOutcome> {
	const raw = rest.trim();
	if (!raw) return { result: 'error', detail: 'tool: empty command' };
	if (raw.includes('\0')) {
		return { result: 'error', detail: 'tool: null byte in command' };
	}
	// Shell-free argv split on whitespace. No shell means metacharacters are
	// inert, but we still split deterministically.
	const argvParts = raw.split(/\s+/).filter((p) => p.length > 0);
	if (argvParts.length === 0) {
		return { result: 'error', detail: 'tool: empty command' };
	}
	const binary = argvParts[0];
	// Reject path-qualified binaries — only bare allowlisted names are permitted.
	if (binary.includes('/') || binary.includes('\\')) {
		return {
			result: 'error',
			detail: `tool: path-qualified binary "${binary}" is not allowed`,
		};
	}
	if (!TOOL_BINARY_ALLOWLIST.has(binary)) {
		return {
			result: 'error',
			detail: `tool: binary "${binary}" is not on the allowlist`,
		};
	}
	const resolved = findBinaryInPath(binary);
	if (!resolved) {
		return { result: 'error', detail: `tool: binary "${binary}" not found` };
	}
	const res = await runArgv([resolved, ...argvParts.slice(1)], directory);
	if (res.timedOut) return { result: 'error', detail: 'tool: timed out' };
	if (res.exitCode === 0) return { result: 'pass', detail: 'tool: exit 0' };
	return {
		result: 'fail',
		detail: `tool: exit ${res.exitCode} ${res.stderr.slice(0, 200)}`,
	};
}

/** Return the set of paths changed in the working tree (tracked + untracked). */
async function changedPaths(directory: string): Promise<Set<string> | null> {
	const git = findBinaryInPath('git');
	if (!git) return null;
	const res = await runArgv([git, 'status', '--porcelain', '-z'], directory);
	if (res.timedOut || res.exitCode !== 0) return null;
	const out = new Set<string>();
	// -z output: each record is `XY<space><path>` with NO trailing newline,
	// records separated by NUL. XY is exactly 2 status chars; the path begins at
	// offset 3. Do NOT trim leading chars — ` M path` (unstaged modify) has a
	// leading space that is part of the fixed-width status field.
	for (const entry of res.stdout.split('\0')) {
		if (entry.length <= 3) continue;
		const p = entry.slice(3);
		if (p) out.add(path.normalize(p));
	}
	return out;
}

async function runFileModifiedPredicate(
	rest: string,
	directory: string,
	expectModified: boolean,
): Promise<PredicateOutcome> {
	const label = expectModified ? 'file_modified' : 'file_not_modified';
	const safe = validateRepoRelativeGlob(directory, rest);
	if (safe === null) {
		return {
			result: 'error',
			detail: `${label}: unsafe or empty path "${rest}"`,
		};
	}
	const changed = await changedPaths(directory);
	if (changed === null) {
		return { result: 'error', detail: `${label}: git unavailable or failed` };
	}
	const target = path.normalize(safe);
	const isChanged = changed.has(target);
	const pass = expectModified ? isChanged : !isChanged;
	return {
		result: pass ? 'pass' : 'fail',
		detail: `${label}: ${target} ${isChanged ? 'changed' : 'unchanged'}`,
	};
}

// ============================================================================
// Public entry
// ============================================================================

/**
 * Run a single verification predicate. Fail-closed: any parse error, unknown
 * handler, or unexpected state returns `result:'error'`. Never throws.
 */
export async function runDirectivePredicate(
	predicate: string,
	directory: string,
): Promise<PredicateOutcome> {
	try {
		if (typeof predicate !== 'string' || !predicate.trim()) {
			return { result: 'error', detail: 'predicate: empty' };
		}
		const trimmed = predicate.trim();
		const firstColon = trimmed.indexOf(':');
		if (firstColon <= 0) {
			return {
				result: 'error',
				detail: 'predicate: missing handler prefix (expected <handler>:...)',
			};
		}
		const handler = trimmed.slice(0, firstColon);
		const rest = trimmed.slice(firstColon + 1);
		switch (handler) {
			case 'grep':
				return await runGrepPredicate(rest, directory);
			case 'tool':
				return await runToolPredicate(rest, directory);
			case 'file_not_modified':
				return await runFileModifiedPredicate(rest, directory, false);
			case 'file_modified':
				return await runFileModifiedPredicate(rest, directory, true);
			default:
				return {
					result: 'error',
					detail: `predicate: unknown handler "${handler}"`,
				};
		}
	} catch (err) {
		warn(
			`[directive-predicate-runner] unexpected error: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return {
			result: 'error',
			detail: 'predicate: unexpected error (fail-closed)',
		};
	}
}

export const _internals = {
	validateRepoRelativeGlob,
	runArgv,
	runDirectivePredicate,
	TOOL_BINARY_ALLOWLIST,
};
