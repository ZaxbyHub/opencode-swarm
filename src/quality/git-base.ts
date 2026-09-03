/**
 * Git base-version plumbing for quality-budget delta math (issue #2470 / #1655).
 *
 * The quality budget gates complexity/public-API *deltas*, so the metrics need
 * the merge-base version of each changed file, not just the working-tree head.
 * This module owns the bounded git queries; `src/quality/metrics.ts` owns the
 * arithmetic. It deliberately lives as a leaf under src/quality (not in
 * src/tools/pre-check-batch.ts, whose merge-base loop it mirrors) so that
 * metrics.ts can import it without a tools → quality → tools import cycle.
 *
 * Subprocess discipline (AGENTS.md invariant 3): array-form spawn via
 * runExternalTool, explicit absolute cwd, stdin ignored by the runner,
 * per-call timeout, bounded stdout/stderr.
 */

import * as path from 'node:path';
import { runExternalTool } from '../utils/external-tool-runner';
import { resolveGitExecutableAsync } from '../utils/git-executable.js';

/** Same candidate order as getChangedLineRanges (src/tools/pre-check-batch.ts). */
const BASE_BRANCH_CANDIDATES = [
	'zaxbyhub/main',
	'upstream/main',
	'origin/main',
	'main',
	'origin/master',
	'master',
] as const;

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 2_000_000;
const GIT_MAX_STDERR_BYTES = 64_000;

const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

async function runBaseQuery(
	args: string[],
	workingDir: string,
): Promise<string | null> {
	let gitExecutable: string;
	try {
		gitExecutable = await resolveGitExecutableAsync();
	} catch {
		return null;
	}
	const result = await _internals.runExternalTool({
		executable: gitExecutable,
		args,
		cwd: workingDir,
		timeoutMs: GIT_TIMEOUT_MS,
		maxStdoutBytes: GIT_MAX_OUTPUT_BYTES,
		maxStderrBytes: GIT_MAX_STDERR_BYTES,
	});
	if (
		result.status !== 'completed' ||
		result.exitCode !== 0 ||
		result.stdoutTruncated
	) {
		return null;
	}
	return result.stdout;
}

/**
 * Resolve the merge-base commit quality deltas are measured against.
 * Mirrors pre-check-batch's candidate loop: first candidate branch that
 * produces a valid sha wins. Returns null when git is unavailable, the
 * directory is not a repository, or no candidate branch exists (callers then
 * fall back to head-only absolute metrics).
 */
export async function resolveQualityMergeBase(
	workingDir: string,
): Promise<string | null> {
	for (const baseBranch of BASE_BRANCH_CANDIDATES) {
		const output = await _internals.runBaseQuery(
			['merge-base', baseBranch, 'HEAD'],
			workingDir,
		);
		const candidate = output?.trim();
		if (candidate && SHA_PATTERN.test(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * Read the base (merge-base) content of one file. The `./`-prefixed form is
 * interpreted by git relative to the spawn cwd, so a workingDir that is a
 * subdirectory of the repository still resolves correctly. Returns null on any
 * failure (new file, rename, missing at base, not a repo) — meaning "this file
 * contributes zero base complexity", i.e. its full head complexity counts as
 * added complexity.
 */
export async function readBaseFileContent(
	workingDir: string,
	baseRef: string,
	file: string,
): Promise<string | null> {
	const normalized = file.replace(/\\/g, '/');
	if (normalized.startsWith('../') || path.isAbsolute(normalized)) {
		// Absolute or escaping paths cannot be expressed portably against the
		// base ref; treat as "no base content" (conservative delta direction).
		return null;
	}
	const output = await _internals.runBaseQuery(
		['show', `${baseRef}:./${normalized}`],
		workingDir,
	);
	return output === null ? null : output;
}

/**
 * DI seam for testability (invariant 7: prefer `_internals` over mock.module).
 */
export const _internals: {
	runBaseQuery: typeof runBaseQuery;
	runExternalTool: typeof runExternalTool;
} = {
	runBaseQuery,
	runExternalTool,
};
