import * as child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type BunCompatSpawnOptions,
	type BunCompatSubprocess,
	bunSpawn,
} from '../utils/bun-compat.js';
import { resolveGitExecutable } from '../utils/git-executable.js';
import type { BackgroundWorkspaceSnapshot } from './pending-delegations.js';

const GIT_SNAPSHOT_TIMEOUT_MS = 3_000;
/**
 * Bounds stdout/stderr for every Git call in this module (issue #1968 P6).
 * Raised 64x (512 KB -> 32 MB) in lockstep with `REVISION_MAX_FILES`: at an
 * assumed worst-case average of ~600 bytes/path (NUL-delimited path plus a
 * generous allowance for deep monorepo directory nesting and the 2-3 byte
 * porcelain status prefix, doubled again for rename records which emit two
 * paths per entry), 32 MB covers `REVISION_MAX_FILES` (50,000) paths with
 * headroom (50,000 * 600 = ~28.6 MB < 32 MB). Raising the file cap alone is
 * inert without this: `readBoundedGitOutput` (below) truncates the
 * `git diff --name-only -z` / `git status --porcelain -z` output the digest
 * enumerates *before* `REVISION_MAX_FILES` is ever consulted.
 */
const GIT_SNAPSHOT_MAX_BUFFER = 32 * 1024 * 1024;
/**
 * Raised 10x (5,000 -> 50,000). "Cost is time, not correctness": a real bound
 * remains (unbounded enumeration is forbidden by AGENTS.md invariant 3), but
 * 50,000 changed paths accommodates large-scale mechanical changes
 * (repo-wide codemods, vendored dependency bumps) that legitimately touch far
 * more than 5,000 files without forcing every such revision through the
 * dead-end `null` this issue exists to fix.
 */
const REVISION_MAX_FILES = 50_000;
/**
 * Raised 8x (64 MB -> 512 MB). Chunked, cooperatively-yielded reads (see
 * `REVISION_READ_CHUNK_BYTES`/`REVISION_YIELD_EVERY_CHUNKS` below) make this
 * a cost-in-time bound, not a correctness bound, so it can move well past
 * "one big generated asset" without materializing more than one chunk at a
 * time in memory.
 */
const REVISION_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const REVISION_READ_CHUNK_BYTES = 64 * 1024;
const REVISION_YIELD_EVERY_CHUNKS = 16;
/**
 * Timeout used only for the two path-ENUMERATION Git calls inside the
 * revision-digest twins (`git diff --name-only` / `git status --porcelain`),
 * not for `GIT_SNAPSHOT_TIMEOUT_MS`'s default (still 3s) used by every other
 * Git call in this module. `git status --untracked-files=all` on a huge tree
 * walks the full working directory and can independently exceed 3s well
 * before any byte cap is reached; 15s (5x) gives that walk real headroom
 * while remaining a bounded subprocess call per AGENTS.md invariant 3.
 */
const REVISION_ENUMERATION_TIMEOUT_MS = 15_000;

type SpawnSync = typeof child_process.spawnSync;

interface BoundedGitOutput {
	text: string;
	truncated: boolean;
}

async function readBoundedGitOutput(
	stream: BunCompatSubprocess['stdout'],
	maxBytes: number,
	onOverflow: () => void,
): Promise<BoundedGitOutput> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const remaining = maxBytes - totalBytes;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.slice(0, remaining));
				onOverflow();
				return { text: '', truncated: true };
			}
			chunks.push(value);
			totalBytes += value.byteLength;
		}
		const joined = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of chunks) {
			joined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { text: new TextDecoder().decode(joined), truncated: false };
	} finally {
		try {
			await reader.cancel();
		} catch {
			// The process may already have closed the stream.
		}
		try {
			reader.releaseLock();
		} catch {
			// Best-effort stream cleanup.
		}
	}
}

interface CaptureWorkspaceSnapshotOptions {
	scope?: string | null;
	prHeadSha?: string | null;
	/**
	 * Re-resolve the current upstream ref for freshness validation. When the
	 * dispatch captured an explicit PR head SHA, ingestion must compare against a
	 * live local ref, not replay the stored metadata back into the snapshot.
	 */
	resolveCurrentPrHeadSha?: boolean;
}

function runGit(
	directory: string,
	args: string[],
	timeoutMs = GIT_SNAPSHOT_TIMEOUT_MS,
): string | null {
	const result = _internals.spawnSync(
		_internals.resolveGitExecutable(),
		['-C', directory, ...args],
		{
			cwd: directory,
			encoding: 'utf-8',
			timeout: timeoutMs,
			maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	if (result.error || result.status !== 0) return null;
	return typeof result.stdout === 'string' ? result.stdout.trimEnd() : null;
}

/**
 * Async equivalent of the bounded snapshot helper. Revision binding runs on
 * tool/hook gates, so it must never monopolize the host event loop while Git
 * is resolving the checked-out state.
 *
 * This one deliberately keeps the `timeout` spawn option alongside the
 * `Promise.race` deadline, unlike `runGitAsyncDetailed`, which had to drop it.
 * The two-timer arrangement is only a defect when the *reason* for failing is
 * observable: there, whichever timer won decided whether a timeout was reported
 * as `timeout` or as a generic `git-failed`. This function returns
 * `string | null` and has no discriminated reason, so both timers collapse to
 * the same `null` and there is nothing to misreport.
 *
 * If a discriminated failure reason is ever added here, that stops being true —
 * give the deadline a single owner first (see `runGitAsyncDetailed`).
 */
async function runGitAsync(
	directory: string,
	args: string[],
	timeoutMs = _internals.gitTimeoutMs,
): Promise<string | null> {
	let proc: BunCompatSubprocess | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const options: BunCompatSpawnOptions = {
			cwd: directory,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: timeoutMs,
			killProcessTree: true,
		};
		proc = _internals.bunSpawn(
			[_internals.resolveGitExecutable(), '-C', directory, ...args],
			options,
		);
		let overflowed = false;
		const stopOverflow = () => {
			overflowed = true;
			try {
				proc?.kill('SIGKILL');
			} catch {
				// Process already exited or cannot be signalled.
			}
		};
		const completed = Promise.all([
			proc.exited,
			readBoundedGitOutput(proc.stdout, GIT_SNAPSHOT_MAX_BUFFER, stopOverflow),
			readBoundedGitOutput(proc.stderr, GIT_SNAPSHOT_MAX_BUFFER, stopOverflow),
		]);
		const result = await Promise.race([
			completed.then(([exitCode, stdout, stderr]) => ({
				kind: 'completed' as const,
				exitCode,
				stdout,
				stderr,
			})),
			new Promise<{ kind: 'timeout' }>((resolve) => {
				timeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
			}),
		]);
		if (
			result.kind === 'timeout' ||
			overflowed ||
			result.exitCode !== 0 ||
			result.stdout.truncated ||
			result.stderr.truncated
		) {
			return null;
		}
		return result.stdout.text.trimEnd();
	} catch {
		return null;
	} finally {
		if (timeout) clearTimeout(timeout);
		try {
			proc?.kill('SIGKILL');
		} catch {
			// Best-effort tree cleanup for an already-closed process.
		}
	}
}

/**
 * Discriminated Git call result used only by the revision-digest twins below
 * (issue #1968 P6). `resolvePrWorkflowRevisionDigest[Async]` need to know
 * *why* a Git call failed — timeout, output-buffer overflow, or a genuine
 * Git failure — to report a diagnosable `RevisionDigestFailureReason`
 * instead of the bare `null` that made the digest cap a dead end. Unrelated
 * callers in this module keep using {@link runGit} / {@link runGitAsync},
 * which stay plain null-on-any-failure helpers; this type and the two
 * functions below are intentionally scoped to the digest path so no other
 * call site's behavior changes.
 */
type GitCallResult =
	| { ok: true; text: string }
	| { ok: false; reason: 'timeout' | 'buffer-truncated' | 'git-failed' };

/**
 * Sync Git invocation for the revision-digest path. Node's `spawnSync` sets
 * `error.code` to `'ETIMEDOUT'` when the `timeout` option is exceeded and to
 * `'ENOBUFS'` when stdout/stderr exceeds `maxBuffer` — both verified against
 * real `spawnSync` behavior, not assumed — so this distinguishes both from a
 * generic non-zero-exit Git failure.
 */
function runGitDetailed(
	directory: string,
	args: string[],
	timeoutMs: number,
): GitCallResult {
	const result = _internals.spawnSync(
		_internals.resolveGitExecutable(),
		['-C', directory, ...args],
		{
			cwd: directory,
			encoding: 'utf-8',
			timeout: timeoutMs,
			maxBuffer: _internals.gitSnapshotMaxBuffer,
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
	if (errorCode === 'ENOBUFS') return { ok: false, reason: 'buffer-truncated' };
	if (errorCode === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
	if (
		result.error ||
		result.status !== 0 ||
		typeof result.stdout !== 'string'
	) {
		return { ok: false, reason: 'git-failed' };
	}
	return { ok: true, text: result.stdout.trimEnd() };
}

/**
 * Async twin of {@link runGitDetailed}, reusing the bounded chunked-read
 * stream helper so a large permitted revision cannot stall the host event
 * loop while still surfacing which bound (timeout vs buffer) was hit.
 *
 * The deadline has exactly ONE owner: the `Promise.race` below. Passing
 * `timeout` to `bunSpawn` as well would arm a second timer on the *same*
 * deadline — `bunSpawn` installs its own `setTimeout` whenever
 * `killProcessTree` is set, and Bun/Node arm theirs natively otherwise — and
 * whichever of the two fired first decided the reported reason: the spawn-side
 * timer SIGKILLs the child, `proc.exited` then resolves non-zero, and the
 * completion branch below reports `git-failed` ("Verify the checkout is a
 * healthy Git worktree") for what was in fact a timeout. Relative firing order
 * of two timers on one deadline is an implementation detail, not a contract, so
 * this reason must not be decided by it. The `finally` clause performs exactly
 * the tree-kill the spawn-side timer would have, so dropping it costs no
 * cleanup.
 */
async function runGitAsyncDetailed(
	directory: string,
	args: string[],
	timeoutMs: number,
): Promise<GitCallResult> {
	let proc: BunCompatSubprocess | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const options: BunCompatSpawnOptions = {
			cwd: directory,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			killProcessTree: true,
		};
		proc = _internals.bunSpawn(
			[_internals.resolveGitExecutable(), '-C', directory, ...args],
			options,
		);
		let overflowed = false;
		const stopOverflow = () => {
			overflowed = true;
			try {
				proc?.kill('SIGKILL');
			} catch {
				// Process already exited or cannot be signalled.
			}
		};
		const maxBuffer = _internals.gitSnapshotMaxBuffer;
		const completed = Promise.all([
			proc.exited,
			readBoundedGitOutput(proc.stdout, maxBuffer, stopOverflow),
			readBoundedGitOutput(proc.stderr, maxBuffer, stopOverflow),
		]);
		const result = await Promise.race([
			completed.then(([exitCode, stdout, stderr]) => ({
				kind: 'completed' as const,
				exitCode,
				stdout,
				stderr,
			})),
			new Promise<{ kind: 'timeout' }>((resolve) => {
				timeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
			}),
		]);
		if (result.kind === 'timeout') return { ok: false, reason: 'timeout' };
		if (overflowed || result.stdout.truncated || result.stderr.truncated) {
			return { ok: false, reason: 'buffer-truncated' };
		}
		if (result.exitCode !== 0) return { ok: false, reason: 'git-failed' };
		return { ok: true, text: result.stdout.text.trimEnd() };
	} catch {
		return { ok: false, reason: 'git-failed' };
	} finally {
		if (timeout) clearTimeout(timeout);
		try {
			proc?.kill('SIGKILL');
		} catch {
			// Best-effort tree cleanup for an already-closed process.
		}
	}
}

/**
 * Read one bounded repository file from an immutable commit without consulting
 * the mutable checkout. Callers compare this text with the checkout copy before
 * treating a PR-provided contract as authority.
 */
export function readGitTextAtRevision(
	directory: string,
	revision: string,
	relativePath: string,
): string | null {
	if (
		!isSafeGitRevisionToken(revision) ||
		!/^\.?(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
			relativePath,
		) ||
		relativePath.split('/').includes('..')
	) {
		return null;
	}
	const result = _internals.spawnSync(
		_internals.resolveGitExecutable(),
		['-C', directory, 'show', `${revision}:${relativePath}`],
		{
			cwd: directory,
			encoding: 'utf-8',
			timeout: GIT_SNAPSHOT_TIMEOUT_MS,
			maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	if (result.error || result.status !== 0 || typeof result.stdout !== 'string')
		return null;
	return result.stdout;
}

/** Resolve the exact checked-out commit through the bounded Git snapshot path. */
export function resolveCurrentGitHead(directory: string): string | null {
	return runGit(directory, ['rev-parse', '--verify', 'HEAD^{commit}']);
}

/**
 * Async twin of {@link resolveCurrentGitHead}. PR-workflow gate/dispatch binding
 * runs on the host tool/hook path, so HEAD verification must resolve Git off the
 * blocking `spawnSync` path — a synchronous spawn on the long-running host (most
 * acutely under Bun on Windows) can hang to its bound instead of returning, which
 * a fail-closed gate would surface as a spurious "cannot resolve HEAD" block.
 */
export async function resolveCurrentGitHeadAsync(
	directory: string,
): Promise<string | null> {
	return await runGitAsync(directory, [
		'rev-parse',
		'--verify',
		'HEAD^{commit}',
	]);
}

/** Resolve one exact PR merge base without shell interpolation or unbounded I/O. */
export function resolveExactMergeBase(
	directory: string,
	baseRef: string,
	prHeadSha: string,
): string | null {
	if (!isSafeGitRevisionToken(baseRef) || !isSafeGitRevisionToken(prHeadSha))
		return null;
	const mergeBase = runGit(directory, ['merge-base', '--', baseRef, prHeadSha]);
	return mergeBase && /^[0-9a-f]{6,64}$/i.test(mergeBase) ? mergeBase : null;
}

/** Async twin of {@link resolveExactMergeBase} for the gate/dispatch bind path. */
export async function resolveExactMergeBaseAsync(
	directory: string,
	baseRef: string,
	prHeadSha: string,
): Promise<string | null> {
	if (!isSafeGitRevisionToken(baseRef) || !isSafeGitRevisionToken(prHeadSha))
		return null;
	const mergeBase = await runGitAsync(directory, [
		'merge-base',
		'--',
		baseRef,
		prHeadSha,
	]);
	return mergeBase && /^[0-9a-f]{6,64}$/i.test(mergeBase) ? mergeBase : null;
}

export interface PrReviewDiffStats {
	changedLines: number;
	changedFiles: number;
	/**
	 * True when the range contains any gitlink (submodule) pointer change.
	 * Git's numstat reports a submodule bump as a fixed 1-added/1-deleted row
	 * regardless of the referenced repository's actual diff size, so size
	 * thresholds cannot bound this case; callers must escalate unconditionally.
	 */
	hasSubmoduleChange: boolean;
}

const GITLINK_MODE_PATTERN = /^:\d{6} 160000 |^:160000 \d{6} /;

/**
 * Compute bounded changed-line/file totals for the exact reviewed PR range.
 * Returns null on any Git failure, malformed numstat row, or buffer overflow
 * so callers can fail strict (treat unknown size as the largest tier).
 * Rename detection is pinned off (`--no-renames`) so the same logical diff
 * produces the same totals regardless of the executing machine's ambient
 * git version/config.
 */
export function resolvePrReviewDiffStats(
	directory: string,
	baseSha: string,
	prHeadSha: string,
): PrReviewDiffStats | null {
	if (!isSafeGitRevisionToken(baseSha) || !isSafeGitRevisionToken(prHeadSha))
		return null;
	const range = `${baseSha}...${prHeadSha}`;
	const output = runGit(directory, [
		'diff',
		'--no-renames',
		'--numstat',
		range,
	]);
	if (output === null) return null;
	let changedLines = 0;
	let changedFiles = 0;
	for (const line of output.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const fields = trimmed.split('\t');
		if (fields.length < 3) return null;
		const added = fields[0] === '-' ? 0 : Number.parseInt(fields[0], 10);
		const deleted = fields[1] === '-' ? 0 : Number.parseInt(fields[1], 10);
		if (Number.isNaN(added) || Number.isNaN(deleted)) return null;
		changedFiles += 1;
		changedLines += added + deleted;
	}
	const rawOutput = runGit(directory, ['diff', '--raw', range]);
	if (rawOutput === null) return null;
	const hasSubmoduleChange = rawOutput
		.split('\n')
		.some((line) => GITLINK_MODE_PATTERN.test(line.trim()));
	return { changedLines, changedFiles, hasSubmoduleChange };
}

/** Async twin of {@link resolvePrReviewDiffStats} used off the blocking spawn on the gate/dispatch bind path. */
export async function resolvePrReviewDiffStatsAsync(
	directory: string,
	baseSha: string,
	prHeadSha: string,
): Promise<PrReviewDiffStats | null> {
	if (!isSafeGitRevisionToken(baseSha) || !isSafeGitRevisionToken(prHeadSha))
		return null;
	const range = `${baseSha}...${prHeadSha}`;
	const output = await runGitAsync(directory, [
		'diff',
		'--no-renames',
		'--numstat',
		range,
	]);
	if (output === null) return null;
	let changedLines = 0;
	let changedFiles = 0;
	for (const line of output.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const fields = trimmed.split('\t');
		if (fields.length < 3) return null;
		const added = fields[0] === '-' ? 0 : Number.parseInt(fields[0], 10);
		const deleted = fields[1] === '-' ? 0 : Number.parseInt(fields[1], 10);
		if (Number.isNaN(added) || Number.isNaN(deleted)) return null;
		changedFiles += 1;
		changedLines += added + deleted;
	}
	const rawOutput = await runGitAsync(directory, ['diff', '--raw', range]);
	if (rawOutput === null) return null;
	const hasSubmoduleChange = rawOutput
		.split('\n')
		.some((line) => GITLINK_MODE_PATTERN.test(line.trim()));
	return { changedLines, changedFiles, hasSubmoduleChange };
}

function isSafeGitRevisionToken(value: string): boolean {
	return (
		/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value) &&
		!value.includes('..') &&
		!value.includes('//') &&
		!value.includes('@{')
	);
}

/** Resolve the current branch's exact remote-tracking publication target. */
export function resolveCurrentUpstreamRemoteRef(
	directory: string,
): string | null {
	const upstream = runGit(directory, [
		'rev-parse',
		'--symbolic-full-name',
		'@{upstream}',
	]);
	if (!upstream?.startsWith('refs/remotes/') || upstream.endsWith('/HEAD')) {
		return null;
	}
	return upstream;
}

export interface PrUpstreamPushTarget {
	remoteName: string;
	remoteBranchRef: string;
	remoteTrackingRef: string;
}

/** Resolve a branch's upstream without guessing where a remote name ends. */
export function resolveCurrentUpstreamPushTarget(
	directory: string,
): PrUpstreamPushTarget | null {
	const localBranchRef = runGit(directory, ['symbolic-ref', '--quiet', 'HEAD']);
	if (!localBranchRef?.startsWith('refs/heads/')) return null;
	const encoded = runGit(directory, [
		'for-each-ref',
		'--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)',
		localBranchRef,
	]);
	if (!encoded) return null;
	const [remoteName, remoteBranchRef, remoteTrackingRef, ...extras] =
		encoded.split('\0');
	if (
		extras.length > 0 ||
		!remoteName ||
		remoteName.startsWith('-') ||
		/[\s;&|<>`]/.test(remoteName) ||
		!remoteBranchRef?.startsWith('refs/heads/') ||
		remoteBranchRef === 'refs/heads/' ||
		/[\s;&|<>`]/.test(remoteBranchRef) ||
		!remoteTrackingRef?.startsWith('refs/remotes/') ||
		remoteTrackingRef.endsWith('/HEAD')
	) {
		return null;
	}
	return { remoteName, remoteBranchRef, remoteTrackingRef };
}

/** Async twin of {@link resolveCurrentUpstreamPushTarget} used off the blocking spawn on the gate/dispatch bind path. */
export async function resolveCurrentUpstreamPushTargetAsync(
	directory: string,
): Promise<PrUpstreamPushTarget | null> {
	const localBranchRef = await runGitAsync(directory, [
		'symbolic-ref',
		'--quiet',
		'HEAD',
	]);
	if (!localBranchRef?.startsWith('refs/heads/')) return null;
	const encoded = await runGitAsync(directory, [
		'for-each-ref',
		'--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)',
		localBranchRef,
	]);
	if (!encoded) return null;
	const [remoteName, remoteBranchRef, remoteTrackingRef, ...extras] =
		encoded.split('\0');
	if (
		extras.length > 0 ||
		!remoteName ||
		remoteName.startsWith('-') ||
		/[\s;&|<>`]/.test(remoteName) ||
		!remoteBranchRef?.startsWith('refs/heads/') ||
		remoteBranchRef === 'refs/heads/' ||
		/[\s;&|<>`]/.test(remoteBranchRef) ||
		!remoteTrackingRef?.startsWith('refs/remotes/') ||
		remoteTrackingRef.endsWith('/HEAD')
	) {
		return null;
	}
	return { remoteName, remoteBranchRef, remoteTrackingRef };
}

/** Query the actual remote ref; local tracking refs are not publication proof. */
export function resolveExactRemoteBranchHead(
	directory: string,
	remoteName: string,
	remoteBranchRef: string,
): string | null {
	if (
		!remoteName ||
		remoteName.startsWith('-') ||
		/[\s;&|<>`]/.test(remoteName) ||
		!remoteBranchRef.startsWith('refs/heads/') ||
		remoteBranchRef === 'refs/heads/' ||
		/[\s;&|<>`]/.test(remoteBranchRef)
	) {
		return null;
	}
	const output = runGit(
		directory,
		['ls-remote', '--exit-code', '--heads', remoteName, remoteBranchRef],
		20_000,
	);
	if (!output) return null;
	const rows = output.split(/\r?\n/).filter(Boolean);
	if (rows.length !== 1) return null;
	const [objectName, refName, ...extras] = rows[0].split(/\s+/);
	if (
		extras.length > 0 ||
		refName !== remoteBranchRef ||
		!objectName ||
		!(/^[0-9a-f]{40}$/i.test(objectName) || /^[0-9a-f]{64}$/i.test(objectName))
	) {
		return null;
	}
	return objectName;
}

/** Async twin of {@link resolveExactRemoteBranchHead} for the gate bind/publish path. */
export async function resolveExactRemoteBranchHeadAsync(
	directory: string,
	remoteName: string,
	remoteBranchRef: string,
): Promise<string | null> {
	if (
		!remoteName ||
		remoteName.startsWith('-') ||
		/[\s;&|<>`]/.test(remoteName) ||
		!remoteBranchRef.startsWith('refs/heads/') ||
		remoteBranchRef === 'refs/heads/' ||
		/[\s;&|<>`]/.test(remoteBranchRef)
	) {
		return null;
	}
	const output = await runGitAsync(
		directory,
		['ls-remote', '--exit-code', '--heads', remoteName, remoteBranchRef],
		20_000,
	);
	if (!output) return null;
	const rows = output.split(/\r?\n/).filter(Boolean);
	if (rows.length !== 1) return null;
	const [objectName, refName, ...extras] = rows[0].split(/\s+/);
	if (
		extras.length > 0 ||
		refName !== remoteBranchRef ||
		!objectName ||
		!(/^[0-9a-f]{40}$/i.test(objectName) || /^[0-9a-f]{64}$/i.test(objectName))
	) {
		return null;
	}
	return objectName;
}

/** Bind Stage-A execution to Git refs, config, HEAD, and index metadata. */
export function resolveGitControlStateDigest(directory: string): string | null {
	const head = runGit(directory, ['rev-parse', '--verify', 'HEAD^{commit}']);
	const symbolicHead = runGit(directory, ['symbolic-ref', '--quiet', 'HEAD']);
	const upstream = resolveCurrentUpstreamPushTarget(directory);
	const refs = runGit(directory, [
		'for-each-ref',
		'--format=%(refname)%00%(objectname)',
		'refs/heads',
		'refs/remotes',
		'refs/tags',
	]);
	const config = runGit(directory, [
		'config',
		'--null',
		'--show-origin',
		'--show-scope',
		'--list',
	]);
	const index = runGit(directory, ['ls-files', '--stage', '-z']);
	if (
		head === null ||
		symbolicHead === null ||
		!upstream ||
		refs === null ||
		config === null ||
		index === null
	) {
		return null;
	}
	return digest(
		`head\0${head}\0symbolic\0${symbolicHead}\0upstream\0${upstream.remoteName}\0${upstream.remoteBranchRef}\0${upstream.remoteTrackingRef}\0refs\0${refs}\0config\0${config}\0index\0${index}`,
	);
}

/** Async twin of {@link resolveGitControlStateDigest} used off the blocking spawn on the gate/dispatch bind path. */
export async function resolveGitControlStateDigestAsync(
	directory: string,
): Promise<string | null> {
	const head = await runGitAsync(directory, [
		'rev-parse',
		'--verify',
		'HEAD^{commit}',
	]);
	const symbolicHead = await runGitAsync(directory, [
		'symbolic-ref',
		'--quiet',
		'HEAD',
	]);
	const upstream = await resolveCurrentUpstreamPushTargetAsync(directory);
	const refs = await runGitAsync(directory, [
		'for-each-ref',
		'--format=%(refname)%00%(objectname)',
		'refs/heads',
		'refs/remotes',
		'refs/tags',
	]);
	const config = await runGitAsync(directory, [
		'config',
		'--null',
		'--show-origin',
		'--show-scope',
		'--list',
	]);
	const index = await runGitAsync(directory, ['ls-files', '--stage', '-z']);
	if (
		head === null ||
		symbolicHead === null ||
		!upstream ||
		refs === null ||
		config === null ||
		index === null
	) {
		return null;
	}
	return digest(
		`head\0${head}\0symbolic\0${symbolicHead}\0upstream\0${upstream.remoteName}\0${upstream.remoteBranchRef}\0${upstream.remoteTrackingRef}\0refs\0${refs}\0config\0${config}\0index\0${index}`,
	);
}

/** Require all independently reviewed content to be captured by the commit. */
export function resolveIsWorkingTreeClean(directory: string): boolean | null {
	const status = runGit(directory, [
		'status',
		'--porcelain=v1',
		'--untracked-files=all',
	]);
	return status === null ? null : status.length === 0;
}

/**
 * Async twin of {@link resolveIsWorkingTreeClean} for the gate/dispatch bind path.
 * `git status` emits far more output than `rev-parse`, so it is the most exposed
 * of the bind-path checks to a blocking synchronous spawn stalling the host.
 */
export async function resolveIsWorkingTreeCleanAsync(
	directory: string,
): Promise<boolean | null> {
	const status = await runGitAsync(directory, [
		'status',
		'--porcelain=v1',
		'--untracked-files=all',
	]);
	return status === null ? null : status.length === 0;
}

/** Count commits on the ancestry path from the immutable intake head to HEAD. */
export function resolveCommitCountSince(
	directory: string,
	baseHeadSha: string,
	currentHeadSha: string,
): number | null {
	if (
		!isSafeGitRevisionToken(baseHeadSha) ||
		!isSafeGitRevisionToken(currentHeadSha)
	)
		return null;
	const output = runGit(directory, [
		'rev-list',
		'--count',
		'--ancestry-path',
		`${baseHeadSha}..${currentHeadSha}`,
		'--',
	]);
	if (!output || !/^\d+$/.test(output)) return null;
	const count = Number(output);
	return Number.isSafeInteger(count) ? count : null;
}

/** Async twin of {@link resolveCommitCountSince} used off the blocking spawn on the gate/dispatch bind path. */
export async function resolveCommitCountSinceAsync(
	directory: string,
	baseHeadSha: string,
	currentHeadSha: string,
): Promise<number | null> {
	if (
		!isSafeGitRevisionToken(baseHeadSha) ||
		!isSafeGitRevisionToken(currentHeadSha)
	)
		return null;
	const output = await runGitAsync(directory, [
		'rev-list',
		'--count',
		'--ancestry-path',
		`${baseHeadSha}..${currentHeadSha}`,
		'--',
	]);
	if (!output || !/^\d+$/.test(output)) return null;
	const count = Number(output);
	return Number.isSafeInteger(count) ? count : null;
}

/** Prove the publication commit is a non-merge direct child of intake HEAD. */
export function resolveIsExactSingleChildCommit(
	directory: string,
	baseHeadSha: string,
	currentHeadSha: string,
): boolean | null {
	if (
		!isSafeGitRevisionToken(baseHeadSha) ||
		!isSafeGitRevisionToken(currentHeadSha)
	)
		return null;
	const base = runGit(directory, [
		'rev-parse',
		'--verify',
		`${baseHeadSha}^{commit}`,
		'--',
	]);
	const current = runGit(directory, [
		'rev-parse',
		'--verify',
		`${currentHeadSha}^{commit}`,
		'--',
	]);
	if (!base || !current) return null;
	const commitAndParents = runGit(directory, [
		'rev-list',
		'--parents',
		'-n',
		'1',
		current,
	]);
	if (commitAndParents === null) return null;
	const fields = commitAndParents.trim().split(/\s+/);
	return (
		fields.length === 2 &&
		fields[0]?.toLowerCase() === current.toLowerCase() &&
		fields[1]?.toLowerCase() === base.toLowerCase()
	);
}

/** Async twin of {@link resolveIsExactSingleChildCommit} used off the blocking spawn on the gate/dispatch bind path. */
export async function resolveIsExactSingleChildCommitAsync(
	directory: string,
	baseHeadSha: string,
	currentHeadSha: string,
): Promise<boolean | null> {
	if (
		!isSafeGitRevisionToken(baseHeadSha) ||
		!isSafeGitRevisionToken(currentHeadSha)
	)
		return null;
	const base = await runGitAsync(directory, [
		'rev-parse',
		'--verify',
		`${baseHeadSha}^{commit}`,
		'--',
	]);
	const current = await runGitAsync(directory, [
		'rev-parse',
		'--verify',
		`${currentHeadSha}^{commit}`,
		'--',
	]);
	if (!base || !current) return null;
	const commitAndParents = await runGitAsync(directory, [
		'rev-list',
		'--parents',
		'-n',
		'1',
		current,
	]);
	if (commitAndParents === null) return null;
	const fields = commitAndParents.trim().split(/\s+/);
	return (
		fields.length === 2 &&
		fields[0]?.toLowerCase() === current.toLowerCase() &&
		fields[1]?.toLowerCase() === base.toLowerCase()
	);
}

/**
 * Return remote-tracking refs whose tip equals the exact checked-out commit.
 * Publication closeout uses this bounded local observation after a successful
 * push; an empty list is not proof that the approved revision was published.
 */
export function resolveRemoteRefsContainingHead(
	directory: string,
	headSha: string,
): string[] | null {
	const output = runGit(directory, [
		'for-each-ref',
		'--format=%(refname)%09%(objectname)',
		'refs/remotes',
	]);
	if (output === null) return null;
	return output
		.split(/\r?\n/)
		.map((line) => line.trim().split('\t'))
		.filter(
			([ref, objectName]) =>
				ref?.startsWith('refs/remotes/') &&
				!ref.endsWith('/HEAD') &&
				objectName?.toLowerCase() === headSha.toLowerCase(),
		)
		.map(([ref]) => ref);
}

/** Async twin of {@link resolveRemoteRefsContainingHead} used off the blocking spawn on the gate/dispatch bind path. */
export async function resolveRemoteRefsContainingHeadAsync(
	directory: string,
	headSha: string,
): Promise<string[] | null> {
	const output = await runGitAsync(directory, [
		'for-each-ref',
		'--format=%(refname)%09%(objectname)',
		'refs/remotes',
	]);
	if (output === null) return null;
	return output
		.split(/\r?\n/)
		.map((line) => line.trim().split('\t'))
		.filter(
			([ref, objectName]) =>
				ref?.startsWith('refs/remotes/') &&
				!ref.endsWith('/HEAD') &&
				objectName?.toLowerCase() === headSha.toLowerCase(),
		)
		.map(([ref]) => ref);
}

export type PrFeedbackTrackingCandidate =
	| {
			kind: 'local';
			branchName: string;
			remoteTrackingRef: string;
	  }
	| {
			kind: 'remote';
			remoteTrackingRef: string;
	  };

/**
 * Discover the exact tracked branches that can safely attach a detached
 * PR_FEEDBACK checkout. Full ref names come from Git; no remote-name slash
 * boundary is guessed in application code.
 */
export async function resolvePrFeedbackTrackingCandidatesAsync(
	directory: string,
	headSha: string,
): Promise<{
	local: Extract<PrFeedbackTrackingCandidate, { kind: 'local' }>[];
	remote: Extract<PrFeedbackTrackingCandidate, { kind: 'remote' }>[];
} | null> {
	const [localOutput, remoteRefs] = await Promise.all([
		runGitAsync(directory, [
			'for-each-ref',
			'--format=%(refname)%09%(objectname)%09%(upstream)',
			'refs/heads',
		]),
		resolveRemoteRefsContainingHeadAsync(directory, headSha),
	]);
	if (localOutput === null || remoteRefs === null) return null;
	const exactRemoteRefs = new Set(remoteRefs);
	const local = localOutput
		.split(/\r?\n/)
		.map((line) => line.trim().split('\t'))
		.flatMap(([ref, objectName, upstream, ...extras]) => {
			if (
				extras.length > 0 ||
				!ref?.startsWith('refs/heads/') ||
				objectName?.toLowerCase() !== headSha.toLowerCase() ||
				!upstream?.startsWith('refs/remotes/') ||
				!exactRemoteRefs.has(upstream)
			) {
				return [];
			}
			return [
				{
					kind: 'local' as const,
					branchName: ref.slice('refs/heads/'.length),
					remoteTrackingRef: upstream,
				},
			];
		});
	return {
		local,
		remote: remoteRefs.map((remoteTrackingRef) => ({
			kind: 'remote' as const,
			remoteTrackingRef,
		})),
	};
}

/** Run the exact array-form switch selected by the controller. */
export async function switchPrFeedbackTrackingCandidateAsync(
	directory: string,
	candidate: PrFeedbackTrackingCandidate,
): Promise<boolean> {
	const args =
		candidate.kind === 'local'
			? ['switch', '--no-guess', '--', candidate.branchName]
			: ['switch', '--track', '--', candidate.remoteTrackingRef];
	const output = await runGitAsync(directory, args);
	return output !== null;
}

/**
 * Discriminated result for the revision-digest twins (issue #1968 P6). A
 * bare `null` on any failure made the digest cap a dead end: a gate consumer
 * could not tell "revision too large" (a bound the operator can act on) from
 * "Git failed" or "output truncated" (an environment problem). `detail` is a
 * best-effort human-readable diagnostic and is not part of the failure
 * contract; only `reason` is.
 */
export type RevisionDigestFailureReason =
	| 'file-cap'
	| 'byte-cap'
	| 'buffer-truncated'
	| 'timeout'
	| 'git-failed'
	| 'containment'
	| 'read-failed';

export type RevisionDigestResult =
	| { ok: true; digest: string }
	| { ok: false; reason: RevisionDigestFailureReason; detail?: string };

function revisionDigestGitCallFailure(
	call: string,
	result: Extract<GitCallResult, { ok: false }>,
): { ok: false; reason: RevisionDigestFailureReason; detail: string } {
	const description =
		result.reason === 'timeout'
			? 'timed out'
			: result.reason === 'buffer-truncated'
				? 'output exceeded the bounded buffer'
				: 'failed';
	return {
		ok: false,
		reason: result.reason,
		detail: `git ${call} ${description}`,
	};
}

/**
 * Bind a mutable working tree to its actual content, not merely porcelain status.
 * This lets PR-feedback approvals fail closed when a same-path edit occurs after a
 * gate. Paths come from Git, are containment-checked, and are hashed without
 * following symlinks outside the project.
 *
 * This is the one implementation of the sync digest; {@link
 * resolvePrWorkflowRevisionDigest} is a thin `.ok ? digest : null` delegate
 * that preserves the pre-existing signature/behavior for existing callers.
 */
export function resolvePrWorkflowRevisionDigestDetailed(
	directory: string,
	baseHeadSha: string,
): RevisionDigestResult {
	const projectRoot = path.resolve(directory);
	const baseHeadResult = runGitDetailed(
		projectRoot,
		['rev-parse', '--verify', `${baseHeadSha}^{commit}`],
		_internals.gitTimeoutMs,
	);
	if (!baseHeadResult.ok) {
		return revisionDigestGitCallFailure('rev-parse --verify', baseHeadResult);
	}
	const diffResult = runGitDetailed(
		projectRoot,
		['diff', '--no-ext-diff', '--name-only', '-z', baseHeadSha],
		_internals.revisionEnumerationTimeoutMs,
	);
	if (!diffResult.ok) {
		return revisionDigestGitCallFailure('diff --name-only', diffResult);
	}
	const porcelainResult = runGitDetailed(
		projectRoot,
		['status', '--porcelain=v1', '-z', '--untracked-files=all'],
		_internals.revisionEnumerationTimeoutMs,
	);
	if (!porcelainResult.ok) {
		return revisionDigestGitCallFailure('status --porcelain', porcelainResult);
	}
	const porcelainPaths = parsePorcelainPaths(porcelainResult.text);
	if (!porcelainPaths) {
		return {
			ok: false,
			reason: 'git-failed',
			detail: 'malformed git status --porcelain=v1 output',
		};
	}
	const changedPaths = [
		...new Set([...parseNulPaths(diffResult.text), ...porcelainPaths]),
	].sort((left, right) => left.localeCompare(right));
	if (changedPaths.length > _internals.revisionMaxFiles) {
		return {
			ok: false,
			reason: 'file-cap',
			detail: `${changedPaths.length} changed paths exceed the cap of ${_internals.revisionMaxFiles}`,
		};
	}

	const hash = createHash('sha256');
	hash.update(`base\0${baseHeadResult.text}\0`);
	let totalBytes = 0;
	for (const relativePath of changedPaths) {
		const resolvedPath = path.resolve(projectRoot, relativePath);
		const relativeToRoot = path.relative(projectRoot, resolvedPath);
		if (
			!relativeToRoot ||
			relativeToRoot.startsWith('..') ||
			path.isAbsolute(relativeToRoot)
		) {
			return {
				ok: false,
				reason: 'containment',
				detail: `path escapes the project root: ${relativePath}`,
			};
		}
		hash.update(`path\0${relativePath}\0`);
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(resolvedPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				hash.update('deleted\0');
				continue;
			}
			return {
				ok: false,
				reason: 'read-failed',
				detail: `lstat failed for ${relativePath}`,
			};
		}
		if (stats.isSymbolicLink()) {
			try {
				hash.update(`symlink\0${fs.readlinkSync(resolvedPath)}\0`);
				continue;
			} catch {
				return {
					ok: false,
					reason: 'read-failed',
					detail: `readlink failed for ${relativePath}`,
				};
			}
		}
		if (!stats.isFile()) {
			hash.update(`node\0${stats.mode}\0`);
			continue;
		}
		totalBytes += stats.size;
		if (totalBytes > _internals.revisionMaxTotalBytes) {
			return {
				ok: false,
				reason: 'byte-cap',
				detail: `accumulated content bytes ${totalBytes} exceed the cap of ${_internals.revisionMaxTotalBytes} at ${relativePath}`,
			};
		}
		try {
			hash.update(`file\0${stats.mode}\0`);
			hash.update(_internals.readChangedFileSync(resolvedPath));
			hash.update('\0');
		} catch {
			return {
				ok: false,
				reason: 'read-failed',
				detail: `read failed for ${relativePath}`,
			};
		}
	}
	return { ok: true, digest: hash.digest('hex') };
}

export function resolvePrWorkflowRevisionDigest(
	directory: string,
	baseHeadSha: string,
): string | null {
	const result = resolvePrWorkflowRevisionDigestDetailed(
		directory,
		baseHeadSha,
	);
	return result.ok ? result.digest : null;
}

/**
 * Asynchronously bind a mutable working tree to its actual content. File
 * reads are chunked with bounded cooperative yields so a large, permitted
 * revision cannot stall the synchronous plugin gate path.
 *
 * This is the one implementation of the async digest; {@link
 * resolvePrWorkflowRevisionDigestAsync} is a thin `.ok ? digest : null`
 * delegate that preserves the pre-existing signature/behavior for existing
 * callers. Sequenced after P2 (see issue #1968 05-fix-plan.md P6.4): the sync
 * twin above has no chunking/yield, so enlarging its `readFileSync` loop
 * before P2 threads the digest through a single gate-entry-point resolve
 * would have worsened blocking on the production path.
 */
export async function resolvePrWorkflowRevisionDigestDetailedAsync(
	directory: string,
	baseHeadSha: string,
): Promise<RevisionDigestResult> {
	const projectRoot = path.resolve(directory);
	const [baseHeadResult, diffResult, porcelainResult] = await Promise.all([
		runGitAsyncDetailed(
			projectRoot,
			['rev-parse', '--verify', `${baseHeadSha}^{commit}`],
			_internals.gitTimeoutMs,
		),
		runGitAsyncDetailed(
			projectRoot,
			['diff', '--no-ext-diff', '--name-only', '-z', baseHeadSha],
			_internals.revisionEnumerationTimeoutMs,
		),
		runGitAsyncDetailed(
			projectRoot,
			['status', '--porcelain=v1', '-z', '--untracked-files=all'],
			_internals.revisionEnumerationTimeoutMs,
		),
	]);
	if (!baseHeadResult.ok) {
		return revisionDigestGitCallFailure('rev-parse --verify', baseHeadResult);
	}
	if (!diffResult.ok) {
		return revisionDigestGitCallFailure('diff --name-only', diffResult);
	}
	if (!porcelainResult.ok) {
		return revisionDigestGitCallFailure('status --porcelain', porcelainResult);
	}
	const porcelainPaths = parsePorcelainPaths(porcelainResult.text);
	if (!porcelainPaths) {
		return {
			ok: false,
			reason: 'git-failed',
			detail: 'malformed git status --porcelain=v1 output',
		};
	}
	const changedPaths = [
		...new Set([...parseNulPaths(diffResult.text), ...porcelainPaths]),
	].sort((left, right) => left.localeCompare(right));
	if (changedPaths.length > _internals.revisionMaxFiles) {
		return {
			ok: false,
			reason: 'file-cap',
			detail: `${changedPaths.length} changed paths exceed the cap of ${_internals.revisionMaxFiles}`,
		};
	}

	const hash = createHash('sha256');
	hash.update(`base\0${baseHeadResult.text}\0`);
	let totalBytes = 0;
	let chunksSinceYield = 0;
	for (const relativePath of changedPaths) {
		const resolvedPath = path.resolve(projectRoot, relativePath);
		const relativeToRoot = path.relative(projectRoot, resolvedPath);
		if (
			!relativeToRoot ||
			relativeToRoot.startsWith('..') ||
			path.isAbsolute(relativeToRoot)
		) {
			return {
				ok: false,
				reason: 'containment',
				detail: `path escapes the project root: ${relativePath}`,
			};
		}
		hash.update(`path\0${relativePath}\0`);
		let stats: fs.Stats;
		try {
			stats = await fs.promises.lstat(resolvedPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				hash.update('deleted\0');
				continue;
			}
			return {
				ok: false,
				reason: 'read-failed',
				detail: `lstat failed for ${relativePath}`,
			};
		}
		if (stats.isSymbolicLink()) {
			try {
				hash.update(`symlink\0${await fs.promises.readlink(resolvedPath)}\0`);
				continue;
			} catch {
				return {
					ok: false,
					reason: 'read-failed',
					detail: `readlink failed for ${relativePath}`,
				};
			}
		}
		if (!stats.isFile()) {
			hash.update(`node\0${stats.mode}\0`);
			continue;
		}
		totalBytes += stats.size;
		if (totalBytes > _internals.revisionMaxTotalBytes) {
			return {
				ok: false,
				reason: 'byte-cap',
				detail: `accumulated content bytes ${totalBytes} exceed the cap of ${_internals.revisionMaxTotalBytes} at ${relativePath}`,
			};
		}
		hash.update(`file\0${stats.mode}\0`);
		let handle: fs.promises.FileHandle | undefined;
		try {
			handle = await fs.promises.open(resolvedPath, 'r');
			const buffer = Buffer.allocUnsafe(REVISION_READ_CHUNK_BYTES);
			for (let position = 0; position < stats.size; ) {
				const length = Math.min(
					REVISION_READ_CHUNK_BYTES,
					stats.size - position,
				);
				const { bytesRead } = await handle.read(buffer, 0, length, position);
				if (bytesRead <= 0) {
					return {
						ok: false,
						reason: 'read-failed',
						detail: `short read for ${relativePath}`,
					};
				}
				hash.update(buffer.subarray(0, bytesRead));
				position += bytesRead;
				chunksSinceYield++;
				if (chunksSinceYield >= REVISION_YIELD_EVERY_CHUNKS) {
					chunksSinceYield = 0;
					await _internals.yieldControl();
				}
			}
			hash.update('\0');
		} catch {
			return {
				ok: false,
				reason: 'read-failed',
				detail: `read failed for ${relativePath}`,
			};
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
	return { ok: true, digest: hash.digest('hex') };
}

export async function resolvePrWorkflowRevisionDigestAsync(
	directory: string,
	baseHeadSha: string,
): Promise<string | null> {
	const result = await resolvePrWorkflowRevisionDigestDetailedAsync(
		directory,
		baseHeadSha,
	);
	return result.ok ? result.digest : null;
}

function parseNulPaths(output: string): string[] {
	return output.split('\0').filter((entry) => entry.length > 0);
}

/** Parse `git status --porcelain=v1 -z`, including both sides of renames. */
export function parsePorcelainPaths(output: string): string[] | null {
	const entries = parseNulPaths(output);
	const paths: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4 || entry[2] !== ' ') return null;
		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (!changedPath) return null;
		paths.push(changedPath);
		if (status.includes('R') || status.includes('C')) {
			const originalPath = entries[++index];
			if (!originalPath) return null;
			paths.push(originalPath);
		}
	}
	return [...new Set(paths)];
}

export interface PorcelainV2Snapshot {
	gitHead: string | null;
	dirtyTrackedPaths: string[];
	untrackedPaths: string[];
	renameOrCopy: boolean;
	unmergedPaths: string[];
	unmergedCodes: string[];
	dirtySubmodulePaths: string[];
}

/**
 * Source-code extensions that must stay VISIBLE even under `.swarm/`.
 *
 * The plugin's runtime artifacts are data files (`.json`, `.jsonl`, `.md`,
 * `.env`, lock markers, extensionless blobs). A source-code file under
 * `.swarm/` is something the plugin would never write itself — the doc-only
 * attribution contract (workspace-snapshot-doc-only.test.ts) deliberately
 * keeps such files visible as an anti-evasion guard so a task cannot hide
 * code changes inside the runtime-state directory.
 */
const SWARM_VISIBLE_CODE_EXTENSIONS = new Set([
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.ts',
	'.tsx',
	'.py',
	'.pyw',
	'.go',
	'.rs',
	'.php',
	'.pl',
	'.java',
	'.kt',
	'.swift',
	'.scala',
	'.c',
	'.h',
	'.cpp',
	'.cs',
	'.rb',
	'.lua',
	'.r',
	'.sh',
	'.bash',
	'.zsh',
	'.ps1',
	'.psm1',
	'.bat',
	'.cmd',
	'.vb',
	'.fs',
]);

/**
 * True for plugin-owned runtime state paths (`.swarm` and the data files
 * under it). Source-code files under `.swarm/` are NOT runtime state (see
 * SWARM_VISIBLE_CODE_EXTENSIONS) and stay visible to attribution.
 *
 * Issue #2271 bug 2: the plugin continuously writes `.swarm/telemetry.jsonl`,
 * session state, knowledge events, and evidence while a swarm runs. Those
 * writes are runtime state (AGENTS.md invariant 4), never coder task output,
 * so every settlement-side snapshot consumer (baseline dirtiness, attribution,
 * Stage B workspace freshness) must treat them as invisible. Without this
 * filter, a repo with a tracked or un-excluded `.swarm/` can never present a
 * clean launch baseline and every coder dispatch dies with
 * CODER_SETTLEMENT_CLEAN_BASELINE_REQUIRED.
 *
 * Exact lowercase `.swarm` match only: the plugin only ever creates `.swarm`,
 * and on case-insensitive filesystems (macOS/Windows defaults) a
 * differently-cased directory cannot coexist with it, so broadened matching
 * would only risk false positives on case-SENSITIVE filesystems where
 * `.SWARM` is a distinct user directory.
 */
export function isSwarmRuntimePath(p: string): boolean {
	if (p === '.swarm') return true;
	if (!p.startsWith('.swarm/')) return false;
	const dot = p.lastIndexOf('.');
	const extension = dot === -1 ? '' : p.slice(dot).toLowerCase();
	return !SWARM_VISIBLE_CODE_EXTENSIONS.has(extension);
}

/**
 * Strip `.swarm`/`.swarm/**` records from a `git status --porcelain=v2 -z`
 * payload before it is hashed or parsed. Headers (`# ...`) always survive.
 * Rename (`2 `) records:
 * - primary path `.swarm` → the record AND its paired original-path record
 *   are dropped (pure runtime churn);
 * - primary path project source, original path `.swarm` (e.g. a runtime file
 *   renamed into source) → the record is kept and the paired original-path
 *   record is REPLACED with the primary path so the parser still sees a valid
 *   pair and no `.swarm` string survives into the digest or the path arrays.
 */
function filterSwarmRuntimePorcelain(output: string): string {
	const records = output.split('\0');
	const kept: string[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) {
			continue;
		}
		if (record.startsWith('# ')) {
			kept.push(record);
			continue;
		}
		let primaryPath: string | null = null;
		if (record.startsWith('? ')) {
			primaryPath = record.slice(2);
		} else if (record.startsWith('1 ')) {
			primaryPath = porcelainV2PathAfterFields(record, 8);
		} else if (record.startsWith('2 ')) {
			primaryPath = porcelainV2PathAfterFields(record, 9);
		} else if (record.startsWith('u ')) {
			primaryPath = porcelainV2PathAfterFields(record, 10);
		}
		if (primaryPath !== null && isSwarmRuntimePath(primaryPath)) {
			if (record.startsWith('2 ')) {
				// The original path follows as its own NUL-delimited record.
				index += 1;
			}
			continue;
		}
		if (record.startsWith('2 ') && primaryPath !== null) {
			const originalRecord = records[index + 1];
			kept.push(record);
			if (
				typeof originalRecord === 'string' &&
				originalRecord !== '' &&
				isSwarmRuntimePath(originalRecord)
			) {
				kept.push(primaryPath);
				index += 1;
			}
			continue;
		}
		kept.push(record);
	}
	return kept.join('\0');
}

/**
 * Parse the one-command `git status --porcelain=v2 --branch -z` snapshot used
 * by background evidence capture. A malformed or unknown record fails closed.
 *
 * This parser is SHARED: `classifyPrWorkflowGitState` feeds it raw porcelain
 * and relies on `.swarm` entries surviving in dirtyTrackedPaths/untrackedPaths
 * so a tracked `.swarm` dirt fails closed with SWARM_STATE_TRACKING_ERROR
 * (runtime state must never be treated as checkout dirt). It must therefore
 * stay unfiltered; settlement-side `.swarm` immunity is applied by
 * `filterSwarmRuntimePorcelain` before the payload reaches this parser
 * (issue #2271 bug 2).
 */
export function parsePorcelainV2Snapshot(
	output: string,
): PorcelainV2Snapshot | null {
	const records = output.split('\0');
	const headers: string[] = [];
	while (records[0]?.startsWith('# ')) {
		headers.push(records.shift()!);
	}
	const oidMatch = headers.join('\n').match(/^# branch\.oid (.+)$/m);
	if (!oidMatch) return null;
	if (
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oidMatch[1]) &&
		oidMatch[1] !== '(initial)'
	) {
		return null;
	}
	const gitHead = oidMatch[1] === '(initial)' ? null : oidMatch[1];
	const dirtyTrackedPaths: string[] = [];
	const untrackedPaths: string[] = [];
	const unmergedPaths: string[] = [];
	const unmergedCodes: string[] = [];
	const dirtySubmodulePaths: string[] = [];
	let renameOrCopy = false;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith('? ')) {
			untrackedPaths.push(record.slice(2));
			continue;
		}
		if (record.startsWith('1 ')) {
			const fields = record.split(' ');
			const changedPath = porcelainV2PathAfterFields(record, 8);
			if (!changedPath || !fields[2]) return null;
			dirtyTrackedPaths.push(changedPath);
			if (fields[2] !== 'N...') dirtySubmodulePaths.push(changedPath);
			continue;
		}
		if (record.startsWith('2 ')) {
			const fields = record.split(' ');
			const changedPath = porcelainV2PathAfterFields(record, 9);
			const originalPath = records[++index];
			if (!changedPath || !originalPath || !fields[2]) return null;
			renameOrCopy = true;
			dirtyTrackedPaths.push(changedPath, originalPath);
			if (fields[2] !== 'N...') dirtySubmodulePaths.push(changedPath);
			continue;
		}
		if (record.startsWith('u ')) {
			const fields = record.split(' ');
			const changedPath = porcelainV2PathAfterFields(record, 10);
			const unmergedCode = fields[1];
			if (
				!changedPath ||
				!fields[2] ||
				!unmergedCode ||
				!/^(?:DD|AU|UD|UA|DU|AA|UU)$/.test(unmergedCode)
			) {
				return null;
			}
			unmergedPaths.push(changedPath);
			unmergedCodes.push(unmergedCode);
			dirtyTrackedPaths.push(changedPath);
			if (fields[2] !== 'N...') dirtySubmodulePaths.push(changedPath);
			continue;
		}
		return null;
	}
	return {
		gitHead,
		dirtyTrackedPaths: [...new Set(dirtyTrackedPaths)],
		untrackedPaths: [...new Set(untrackedPaths)],
		renameOrCopy,
		unmergedPaths: [...new Set(unmergedPaths)],
		unmergedCodes: [...new Set(unmergedCodes)],
		dirtySubmodulePaths: [...new Set(dirtySubmodulePaths)],
	};
}

function porcelainV2PathAfterFields(
	record: string,
	fields: number,
): string | null {
	let offset = 0;
	for (let index = 0; index < fields; index++) {
		const delimiter = record.indexOf(' ', offset);
		if (delimiter < 0) return null;
		offset = delimiter + 1;
	}
	const pathValue = record.slice(offset);
	return pathValue || null;
}

export function captureWorkspaceSnapshot(
	directory: string,
	optionsOrScope: string | null | CaptureWorkspaceSnapshotOptions = null,
	prHeadShaArg: string | null = null,
): BackgroundWorkspaceSnapshot {
	const scope =
		typeof optionsOrScope === 'object' && optionsOrScope !== null
			? (optionsOrScope.scope ?? null)
			: optionsOrScope;
	const configuredPrHeadSha = (() => {
		if (typeof optionsOrScope !== 'object' || optionsOrScope === null) {
			return prHeadShaArg;
		}
		return optionsOrScope.prHeadSha ?? null;
	})();
	const resolveCurrentPrHeadSha =
		typeof optionsOrScope === 'object' &&
		optionsOrScope !== null &&
		optionsOrScope.resolveCurrentPrHeadSha === true;
	const upstreamBefore = resolveCurrentPrHeadSha
		? runGit(directory, ['rev-parse', '@{upstream}'])
		: null;
	const porcelainRaw = runGit(directory, [
		'status',
		'--porcelain=v2',
		'--branch',
		'-z',
		'--untracked-files=all',
	]);
	// Issue #2271 bug 2: hash and parse the same .swarm-filtered payload so
	// dirtyHash comparisons and changedFiles derivation stay consistent —
	// plugin runtime writes under .swarm/ are invisible to settlement.
	const porcelain =
		porcelainRaw === null ? null : filterSwarmRuntimePorcelain(porcelainRaw);
	const snapshot =
		porcelain === null ? null : parsePorcelainV2Snapshot(porcelain);
	const upstreamAfter = resolveCurrentPrHeadSha
		? runGit(directory, ['rev-parse', '@{upstream}'])
		: null;
	const prHeadSha = resolveCurrentPrHeadSha
		? upstreamBefore && upstreamBefore === upstreamAfter
			? upstreamBefore
			: null
		: configuredPrHeadSha;
	return {
		directory: path.resolve(directory),
		gitHead: snapshot?.gitHead ?? null,
		dirtyHash: porcelain === null ? null : digest(porcelain),
		changedFiles: snapshot
			? [
					...new Set([
						...snapshot.dirtyTrackedPaths,
						...snapshot.untrackedPaths,
					]),
				]
			: null,
		prHeadSha,
		scope,
	};
}

/**
 * Conservatively derive final paths changed since a pre-task snapshot.
 * Git or parsing failures return null so gate classification fails closed.
 */
export function changedFilesSinceSnapshot(
	directory: string,
	baseline: BackgroundWorkspaceSnapshot | undefined,
): string[] | null {
	if (!baseline?.gitHead || baseline.changedFiles == null) return null;
	// Issue #2271 bug 2: baselines persisted by older plugin versions (or
	// captured through paths without the porcelain filter) may still carry
	// .swarm runtime paths; strip them before the dirty check so plugin-owned
	// writes never make attribution fail closed.
	const baselineDirt = baseline.changedFiles.filter(
		(p) => !isSwarmRuntimePath(p),
	);
	// A dirty baseline cannot prove which same-path edits belong to this task.
	// Fail closed instead of treating unchanged pre-existing dirt as task output.
	if (baselineDirt.length > 0) return null;
	const current = captureWorkspaceSnapshot(directory);
	if (!current.gitHead || current.changedFiles == null) return null;

	const changed = new Set(current.changedFiles);
	if (baseline.gitHead !== current.gitHead) {
		const committed = runGit(directory, [
			'diff',
			'--name-only',
			'-z',
			baseline.gitHead,
			current.gitHead,
		]);
		if (committed === null) return null;
		for (const changedPath of parseNulPaths(committed)) {
			if (!isSwarmRuntimePath(changedPath)) changed.add(changedPath);
		}
	}

	return [...changed];
}

export function workspaceSnapshotMatches(
	expected: BackgroundWorkspaceSnapshot | undefined,
	current: BackgroundWorkspaceSnapshot,
): { ok: true } | { ok: false; reason: string } {
	if (!expected) return { ok: true };
	if (path.resolve(expected.directory) !== path.resolve(current.directory)) {
		return {
			ok: false,
			reason: `directory changed: expected ${expected.directory}, got ${current.directory}`,
		};
	}
	const checks: Array<
		keyof Pick<
			BackgroundWorkspaceSnapshot,
			'gitHead' | 'dirtyHash' | 'prHeadSha'
		>
	> = ['gitHead', 'dirtyHash', 'prHeadSha'];
	for (const key of checks) {
		const expectedValue = expected[key];
		if (expectedValue === null) continue;
		if (current[key] !== expectedValue) {
			return {
				ok: false,
				reason: `${key} changed: expected ${expectedValue}, got ${current[key] ?? 'unknown'}`,
			};
		}
	}
	return { ok: true };
}

export type WorkspaceFreshness = ReturnType<typeof workspaceSnapshotMatches>;

export const compareWorkspaceSnapshot = workspaceSnapshotMatches;

export function compareWorkspaceSnapshots(
	expected: BackgroundWorkspaceSnapshot | undefined,
	current: BackgroundWorkspaceSnapshot,
): { stale: boolean; reason?: string } {
	const result = workspaceSnapshotMatches(expected, current);
	if (result.ok) return { stale: false };
	return { stale: true, reason: result.reason };
}

export function digest(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export const _internals: {
	spawnSync: SpawnSync;
	bunSpawn: typeof bunSpawn;
	/**
	 * Test seam for git binary resolution (issue #2236 hardening, lane C1b) —
	 * see `src/utils/git-executable.ts`. Allows tests to stub a deterministic
	 * value instead of exercising the real filesystem-probing resolver.
	 */
	resolveGitExecutable: typeof resolveGitExecutable;
	gitTimeoutMs: number;
	yieldControl: () => Promise<void>;
	parsePorcelainV2Snapshot: typeof parsePorcelainV2Snapshot;
	/**
	 * Revision-digest bound seams (issue #1968 P6). Defaults mirror the
	 * top-level constants; tests lower these to deterministically produce
	 * `file-cap` / `byte-cap` / `buffer-truncated` against small real temp
	 * git repos instead of materializing tens of thousands of real files.
	 */
	revisionMaxFiles: number;
	revisionMaxTotalBytes: number;
	gitSnapshotMaxBuffer: number;
	revisionEnumerationTimeoutMs: number;
	/**
	 * The synchronous digest's changed-file content read, behind the same kind
	 * of seam as `spawnSync` above. The `read-failed` reason it guards has no
	 * portable filesystem trigger: Windows normalizes every crafted-path failure
	 * (nested-under-a-file, reserved characters, over-length) to `ENOENT`, which
	 * this code deliberately treats as "deleted, keep hashing", and `chmod` is a
	 * no-op there — so without this seam the sync twin's `read-failed` arm is
	 * unreachable from a test while remaining reachable in production (EACCES,
	 * EIO, a vanished mount). The async twin needs no equivalent: its chunked
	 * reader reaches `read-failed` through the short-read branch, which a test
	 * drives via the existing `yieldControl` seam.
	 */
	readChangedFileSync: (filePath: string) => Buffer;
} = {
	spawnSync: child_process.spawnSync,
	bunSpawn,
	resolveGitExecutable,
	gitTimeoutMs: GIT_SNAPSHOT_TIMEOUT_MS,
	yieldControl: () => new Promise<void>((resolve) => setImmediate(resolve)),
	parsePorcelainV2Snapshot,
	revisionMaxFiles: REVISION_MAX_FILES,
	revisionMaxTotalBytes: REVISION_MAX_TOTAL_BYTES,
	gitSnapshotMaxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
	revisionEnumerationTimeoutMs: REVISION_ENUMERATION_TIMEOUT_MS,
	readChangedFileSync: (filePath: string) => fs.readFileSync(filePath),
};
