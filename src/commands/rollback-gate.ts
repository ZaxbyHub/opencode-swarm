/**
 * Issue #2946: shared destruction measurement + candidate derivation for the
 * /swarm rollback two-step gate. Used by BOTH the command layer
 * (src/commands/rollback.ts) and the checkpoint tool sink
 * (src/tools/checkpoint.ts) so a token minted by one surface is consumable at
 * the other: the scope digest is computed over the IDENTICAL candidate set
 * derived by the functions in this module.
 *
 * Measurement contract (mirrors the #2508 close gate,
 * src/commands/close/orchestrator.ts):
 *  - a bare `.git` marker directory (#2127 accepted project root, no
 *    repository behind it) tracks nothing — a failed status read there is a
 *    determined "no tracked work" answer, not an unreadable status;
 *  - a status read failure inside a REAL repository (spawn error, timeout,
 *    nonzero exit — e.g. index.lock contention) is NEVER a clean tree: the
 *    caller must refuse the destructive restore instead of proceeding.
 */
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { PurgeCandidate } from './destructive-purge';
import {
	type GitStatusReadResult,
	readGitStatusAsync,
} from './git-status-read';

/** Destructive-surface kind for the git checkpoint restore path. */
export const ROLLBACK_GIT_KIND = 'swarm-rollback-git';
/** Destructive-surface kind for the legacy phase-overwrite restore path. */
export const ROLLBACK_PHASE_KIND = 'swarm-rollback-phase';

// `git ls-tree -r` / `git ls-files` on large repositories can exceed the
// 1 MB reader default; the scan is still bounded by this explicit cap
// (#3317: the bound is per-call through the shared reader's maxBufferBytes).
const GIT_LIST_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Test seam for the rollback gate (simulate git-status read failures without
 * spawning real git). Mirrors `_closeGateInternals.runGit`.
 * #3317: the defaults are the async shared reader — bounded, killable, and
 * detail-carrying. Legacy sync stubs returning `string | null` keep their
 * original meaning (await-tolerant); the status argv leads with
 * `--no-optional-locks` and the listing reads keep the 32 MB bound.
 */
export const _rollbackGateInternals: {
	runGit: (
		args: string[],
		cwd: string,
	) =>
		| string
		| null
		| GitStatusReadResult
		| Promise<string | null | GitStatusReadResult>;
	runGitBuffered: (
		args: string[],
		cwd: string,
	) =>
		| string
		| null
		| GitStatusReadResult
		| Promise<string | null | GitStatusReadResult>;
} = {
	runGit: (args, cwd) => readGitStatusAsync(args, cwd),
	runGitBuffered: (args, cwd) =>
		readGitStatusAsync(args, cwd, {
			maxBufferBytes: GIT_LIST_MAX_BUFFER_BYTES,
		}),
};

/** Normalize a seam result to stdout-or-null; legacy `string | null` stubs
 * keep their meaning (#3317 await-tolerant contract). */
async function readToString(
	raw:
		| string
		| null
		| GitStatusReadResult
		| Promise<string | null | GitStatusReadResult>,
): Promise<string | null> {
	const value = await raw;
	if (typeof value === 'string') return value;
	if (value === null) return null;
	return value.ok ? value.stdout : null;
}

/** Extract the structured failure detail when a seam result failed; a legacy
 * sync `null` carries no detail, so it stays a plain unreadable. */
async function readFailureDetail(
	raw:
		| string
		| null
		| GitStatusReadResult
		| Promise<string | null | GitStatusReadResult>,
): Promise<{
	code: string | null;
	status: number | null;
	stderrTail: string;
} | null> {
	const value = await raw;
	if (value === null || typeof value === 'string') return null;
	if (value.ok) return null;
	return {
		code: value.code,
		status: value.status,
		stderrTail: value.stderrTail,
	};
}

/**
 * A real git repository root: `.git` is a linked-worktree/submodule pointer
 * file, or a directory carrying the HEAD ref every repository has. Bare
 * `.git` marker directories — accepted project roots per #2127 — are not
 * repositories; git tracks nothing there.
 */
export function isRealGitRepository(directory: string): boolean {
	try {
		if (fsSync.statSync(path.join(directory, '.git')).isFile()) return true;
	} catch {
		return false;
	}
	return fsSync.existsSync(path.join(directory, '.git', 'HEAD'));
}

/** #3434: a parsed porcelain record whose path normalizes outside the repo root. */
export function isOutOfRootRelativePath(rel: string): boolean {
	if (rel === '') return false;
	const normalized = path.posix.normalize(rel);
	return (
		normalized === '..' ||
		normalized.startsWith('../') ||
		normalized.startsWith('/')
	);
}

/**
 * The NUL-form parser's result contract (#3434): the in-root dirty paths that
 * feed the destroy scope, plus any records whose path normalized outside the
 * project root — excluded from the scope and surfaced for the diagnostic
 * instead of being joined into the confirm-token digest unvalidated.
 */
export interface TrackedDirtyParseResult {
	dirtyPaths: string[];
	excludedOutOfRoot: string[];
}

/**
 * Parse `git status --porcelain -z` output into repo-relative tracked-dirty
 * paths. The -z form is NUL-terminated and NEVER quotes paths (core.quotepath
 * quoting — which mangles non-ASCII names into C-escaped octal and would
 * silently break both the preview and the pre-restore backup — does not
 * apply). Untracked ('??') entries survive `git reset --hard`; every other
 * porcelain code is tracked work the reset would discard. Rename/copy
 * records carry the ORIG_PATH as the next NUL token (#2508: both sides at
 * risk), so each side is listed. R/C may sit in EITHER status column — the
 * second column for worktree-only renames created via `git add -N`
 * (intent-to-add) — so the test must not anchor to the first column, or the
 * ORIG_PATH token of an R/C-initial file (README.md, CHANGELOG.md, …) is
 * misread as the start of a new record and swallows the next real entry.
 *
 * #3434: `../`-bearing (or absolute) records are excluded from the dirty
 * set and recorded in `excludedOutOfRoot` — the legacy `string[]` export
 * below returns only the in-root paths.
 */
export function parseTrackedDirtyPathsWithExclusions(
	statusOutput: string,
): TrackedDirtyParseResult {
	const dirtyPaths: string[] = [];
	const excludedOutOfRoot: string[] = [];
	const push = (candidate: string): void => {
		if (isOutOfRootRelativePath(candidate)) {
			excludedOutOfRoot.push(candidate);
			return;
		}
		dirtyPaths.push(candidate);
	};
	const tokens = statusOutput.split('\0');
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === '' || token.length < 4) continue;
		const xy = token.slice(0, 2);
		if (xy === '??') continue;
		const filePath = token.slice(3);
		if (!filePath) continue;
		push(filePath);
		if (/[RC]/.test(xy) && i + 1 < tokens.length && tokens[i + 1] !== '') {
			push(tokens[i + 1]);
			i += 1;
		}
	}
	return { dirtyPaths, excludedOutOfRoot };
}

/**
 * Legacy `string[]` view of the NUL-form parser (in-root paths only) — the
 * export existing suites pin. New consumers that need the exclusion
 * diagnostic use `parseTrackedDirtyPathsWithExclusions`.
 */
export function parseTrackedDirtyPaths(statusOutput: string): string[] {
	return parseTrackedDirtyPathsWithExclusions(statusOutput).dirtyPaths;
}

/**
 * Paths that live in the restore TARGET tree but are NOT in the current
 * index while a file sits on disk at that path. `git reset --hard` silently
 * overwrites exactly these untracked (or since-ignored) files when it
 * materializes the target tree, so they belong in the destruction scope
 * alongside tracked-dirty paths (#2976 review F-1).
 *
 * #3434 fail-closed contract: `failure` is set when either listing cannot
 * be read, carrying the reader's structured cause when it could tell. The
 * caller must REFUSE on it — an unreadable enumeration may not read as a
 * measured "nothing in the way" (the same class #3317 closed for the status
 * reads). A non-git or bare-marker root returns empty paths with NO failure:
 * nothing tracked can be in the way there (#2127 convention).
 */
export async function untrackedPathsInTargetTree(
	directory: string,
	targetSha: string,
): Promise<{
	paths: string[];
	failure: {
		code: string | null;
		status: number | null;
		stderrTail: string;
	} | null;
}> {
	if (!isRealGitRepository(directory)) {
		return { paths: [], failure: null };
	}
	const targetTreeRaw = await _rollbackGateInternals.runGitBuffered(
		['ls-tree', '-r', '-z', '--name-only', targetSha],
		directory,
	);
	const targetTree = await readToString(targetTreeRaw);
	if (targetTree === null) {
		const detail = await readFailureDetail(targetTreeRaw);
		return {
			paths: [],
			failure: detail ?? { code: null, status: null, stderrTail: '' },
		};
	}
	const indexRaw = await _rollbackGateInternals.runGitBuffered(
		['ls-files', '-z'],
		directory,
	);
	const index = await readToString(indexRaw);
	if (index === null) {
		const detail = await readFailureDetail(indexRaw);
		return {
			paths: [],
			failure: detail ?? { code: null, status: null, stderrTail: '' },
		};
	}
	const indexed = new Set(index.split('\0').filter((p) => p !== ''));
	const inWay: string[] = [];
	for (const rel of targetTree.split('\0')) {
		if (rel === '' || indexed.has(rel)) continue;
		if (fsSync.existsSync(path.join(directory, rel))) inWay.push(rel);
	}
	return { paths: inWay, failure: null };
}

/**
 * The git-kind candidate set: the absolute paths of tracked-dirty files that
 * `git reset --hard` would destroy. This is the ONLY derivation for
 * ROLLBACK_GIT_KIND — the tool sink re-derives it from {label, directory}
 * alone, so the command layer must not add anything to the set.
 */
export function trackedDirtyCandidates(
	directory: string,
	dirtyRelPaths: string[],
): PurgeCandidate[] {
	return dirtyRelPaths.map((rel) => ({
		path: path.join(directory, rel),
		reason: 'uncommitted tracked change — destroyed by git reset --hard',
	}));
}

/**
 * The legacy-phase-kind candidate set: absolute paths of live `.swarm/`
 * entries the checkpoint copy loop would overwrite.
 */
export function swarmOverwriteCandidates(
	directory: string,
	overwriteRelPaths: string[],
): PurgeCandidate[] {
	return overwriteRelPaths.map((rel) => ({
		path: path.join(directory, '.swarm', rel),
		reason: 'live .swarm state replaced by the checkpoint copy',
	}));
}

/**
 * #3317: cause-matched wording for an unreadable destruction measurement —
 * single source shared by the /swarm rollback command and the checkpoint
 * tool sink so the two refusal texts cannot drift. `source` (#3434
 * feedback round) names WHICH read failed: the default 'status' keeps the
 * historical wording BYTE-IDENTICAL (pinned by the #3317 round-2 trace
 * suite checkpoint-restore-cause-3275); 'enumeration' rewords the arms to
 * name the ls-tree/ls-files listing so the operator is pointed at the read
 * that actually failed.
 */
export function describeUnreadableCause(
	measurement: {
		code?: string | null;
		status?: number | null;
		stderrTail?: string;
	},
	source: 'status' | 'enumeration' = 'status',
): string {
	if (source === 'status') {
		return describeUnreadableStatusCause(measurement);
	}
	if (measurement.code === 'ETIMEDOUT') {
		return 'the target-tree listing read timed out (ETIMEDOUT) — the host may be unable to complete child spawns while loaded; restart the host and retry';
	}
	if (measurement.code === 'EOUTPUT') {
		return `the listing output exceeded the read safety bound (${measurement.stderrTail ?? 'output too large'}) — reduce the change footprint (commit or stash some work, or remove untracked bulk) and retry`;
	}
	if (measurement.code === 'ESIGNAL') {
		return 'the target-tree listing process was terminated before it answered (signal) — something external stopped it; retry, and inspect what terminates child processes if it recurs';
	}
	if (measurement.code === 'ENOENT') {
		return 'the git executable was not found (ENOENT) — install git on PATH, or set git.binary in your USER-level config, and retry';
	}
	if (measurement.status !== null && measurement.status !== undefined) {
		return `the target-tree listing exited with status ${measurement.status}${measurement.stderrTail ? `: ${measurement.stderrTail}` : ''} — repair the repository state and retry`;
	}
	if (measurement.code) {
		return `the listing read failed with code ${measurement.code} — retry, or inspect the repository state manually`;
	}
	return 'retry, or inspect the repository state manually';
}

/** Historical status-worded arms — BYTE-IDENTICAL to the pre-#3434 text. */
function describeUnreadableStatusCause(measurement: {
	code?: string | null;
	status?: number | null;
	stderrTail?: string;
}): string {
	if (measurement.code === 'ETIMEDOUT') {
		return 'the read timed out (ETIMEDOUT) — the host may be unable to complete child spawns while loaded; restart the host and retry';
	}
	if (measurement.code === 'EOUTPUT') {
		return `the status output exceeded the read safety bound (${measurement.stderrTail ?? 'output too large'}) — reduce the change footprint (commit or stash some work, or remove untracked bulk) and retry`;
	}
	if (measurement.code === 'ESIGNAL') {
		return 'the git process was terminated before it answered (signal) — something external stopped it; retry, and inspect what terminates child processes if it recurs';
	}
	if (measurement.code === 'ENOENT') {
		// Matches the fragment's install-hint bullet for EVERY sink that
		// renders a cause (close, diagnose, rollback, checkpoint) — the
		// rollback/checkpoint sinks previously fell to the generic code arm
		// with no hint (review round 2 question).
		return 'the git executable was not found (ENOENT) — install git on PATH, or set git.binary in your USER-level config, and retry';
	}
	if (measurement.status !== null && measurement.status !== undefined) {
		return `git status exited with status ${measurement.status}${measurement.stderrTail ? `: ${measurement.stderrTail}` : ''} — repair the repository state and retry`;
	}
	if (measurement.code) {
		return `the read failed with code ${measurement.code} — retry, or inspect git status manually`;
	}
	return 'retry, or inspect git status manually';
}

/**
 * Sanitize a repo-controlled porcelain record for operator/agent-facing
 * diagnostic text (#3434 feedback round): collapse control characters
 * (ANSI/CR/LF/NUL cannot smuggle terminal escapes or forged lines) and
 * bound the excerpt — the same house discipline as the reader's
 * `stderrTail` and `excerptProbeOutput`. Excluded records never enter the
 * scope digest, so the digest's own NUL/newline rejection does not cover
 * the one place their bytes are rendered.
 */
export function formatExcludedRecord(rel: string): string {
	// Security sanitization — collapsing ANSI/CR/LF/NUL bytes out of
	// untrusted porcelain output before it reaches operator-visible text
	// (same exemption as checkpoint.ts's CONTROL_CHAR_PATTERN).
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization
	const sanitized = rel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
	return sanitized.length > 200 ? `${sanitized.slice(0, 200)}…` : sanitized;
}

/**
 * Measure the destruction scope for a git checkpoint restore. When
 * `targetSha` is provided, files that are untracked (or since-ignored) on
 * disk but tracked in the TARGET tree are included: `git reset --hard`
 * overwrites them silently, so they are part of the destruction set
 * (#2976 review F-1). `unreadable` means git status — or, #3434, the
 * ls-tree/ls-files enumeration of the target tree — could not be read
 * inside a real repository; callers must fail closed on it (never treat it
 * as a clean tree, and never let a failed enumeration shrink the measured
 * scope). A non-git or bare-marker root returns an empty dirty set: nothing
 * tracked to destroy. `excludedOutOfRoot` carries porcelain records whose
 * path normalized outside the project root (#3434) — excluded from the
 * scope and surfaced for the preview diagnostic.
 */
export async function measureGitDestruction(
	directory: string,
	targetSha?: string,
): Promise<
	| {
			kind: 'ok';
			dirtyRelPaths: string[];
			/** #3434: out-of-root porcelain records excluded from the scope. */
			excludedOutOfRoot: string[];
	  }
	| {
			kind: 'unreadable';
			/** #3317: why the read failed, when the async reader could tell. */
			code?: string | null;
			status?: number | null;
			stderrTail?: string;
			/**
			 * #3434 feedback: WHICH read failed — the status read or the
			 * ls-tree/ls-files enumeration. Consumers word the refusal
			 * accordingly instead of always blaming git status.
			 */
			source: 'status' | 'enumeration';
			/**
			 * Out-of-root records already parsed from a SUCCESSFUL status
			 * read before the enumeration failed — carried so the refusal
			 * can still disclose them instead of dropping them silently.
			 */
			excludedOutOfRoot?: string[];
	  }
> {
	if (!isRealGitRepository(directory)) {
		return { kind: 'ok', dirtyRelPaths: [], excludedOutOfRoot: [] };
	}
	const raw = _rollbackGateInternals.runGit(
		// #3317: read-only status must not contend on the index write lock.
		['--no-optional-locks', 'status', '--porcelain', '-z'],
		directory,
	);
	const status = await readToString(raw);
	if (status === null) {
		const failure = await readFailureDetail(raw);
		return failure
			? {
					kind: 'unreadable',
					code: failure.code,
					status: failure.status,
					stderrTail: failure.stderrTail,
					source: 'status',
				}
			: { kind: 'unreadable', source: 'status' };
	}
	const { dirtyPaths: dirtyRelPaths, excludedOutOfRoot } =
		parseTrackedDirtyPathsWithExclusions(status);
	if (targetSha) {
		const { paths, failure } = await untrackedPathsInTargetTree(
			directory,
			targetSha,
		);
		// #3434: an unreadable enumeration must refuse the measurement —
		// folding an empty set here would silently shrink the destruction
		// scope below what `git reset --hard` would actually overwrite.
		// The exclusions already parsed from the successful status read are
		// carried on the refusal (feedback round: never silently dropped).
		if (failure) {
			return {
				kind: 'unreadable',
				code: failure.code,
				status: failure.status,
				stderrTail: failure.stderrTail,
				source: 'enumeration',
				excludedOutOfRoot,
			};
		}
		for (const rel of paths) {
			if (!dirtyRelPaths.includes(rel)) dirtyRelPaths.push(rel);
		}
	}
	return { kind: 'ok', dirtyRelPaths, excludedOutOfRoot };
}
