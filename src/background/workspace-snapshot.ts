import * as child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundWorkspaceSnapshot } from './pending-delegations.js';

const GIT_SNAPSHOT_TIMEOUT_MS = 3_000;
const GIT_SNAPSHOT_MAX_BUFFER = 512 * 1024;
const REVISION_MAX_FILES = 5_000;
const REVISION_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const REVISION_READ_CHUNK_BYTES = 64 * 1024;
const REVISION_YIELD_EVERY_CHUNKS = 16;

type SpawnSync = typeof child_process.spawnSync;

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
	const result = _internals.spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		encoding: 'utf-8',
		timeout: timeoutMs,
		maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.error || result.status !== 0) return null;
	return typeof result.stdout === 'string' ? result.stdout.trimEnd() : null;
}

/**
 * Async equivalent of the bounded snapshot helper. Revision binding runs on
 * tool/hook gates, so it must never monopolize the host event loop while Git
 * is resolving the checked-out state.
 */
async function runGitAsync(
	directory: string,
	args: string[],
	timeoutMs = GIT_SNAPSHOT_TIMEOUT_MS,
): Promise<string | null> {
	return await new Promise((resolve) => {
		let settled = false;
		let stdout = '';
		let stderrBytes = 0;
		let timeout: NodeJS.Timeout | undefined;
		let child: child_process.ChildProcess | undefined;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			// A timeout, buffer failure, or host-side stream error must not leave
			// a Git child behind. Killing an already-closed child is best-effort.
			try {
				child?.kill();
			} catch {
				// The child has already exited or cannot be signalled.
			}
			resolve(value);
		};
		try {
			child = child_process.spawn('git', ['-C', directory, ...args], {
				cwd: directory,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch {
			finish(null);
			return;
		}
		timeout = setTimeout(() => finish(null), timeoutMs);
		child.stdout?.setEncoding('utf-8');
		child.stdout?.on('data', (chunk: string) => {
			stdout += chunk;
			if (Buffer.byteLength(stdout, 'utf-8') > GIT_SNAPSHOT_MAX_BUFFER) {
				finish(null);
			}
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > GIT_SNAPSHOT_MAX_BUFFER) {
				finish(null);
			}
		});
		child.once('error', () => finish(null));
		child.once('close', (code) => finish(code === 0 ? stdout.trimEnd() : null));
	});
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
		'git',
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
	const output = runGit(directory, [
		'rev-list',
		'--count',
		'--ancestry-path',
		`${baseHeadSha}..${currentHeadSha}`,
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
	const output = await runGitAsync(directory, [
		'rev-list',
		'--count',
		'--ancestry-path',
		`${baseHeadSha}..${currentHeadSha}`,
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
	const base = runGit(directory, [
		'rev-parse',
		'--verify',
		`${baseHeadSha}^{commit}`,
	]);
	const current = runGit(directory, [
		'rev-parse',
		'--verify',
		`${currentHeadSha}^{commit}`,
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
	const base = await runGitAsync(directory, [
		'rev-parse',
		'--verify',
		`${baseHeadSha}^{commit}`,
	]);
	const current = await runGitAsync(directory, [
		'rev-parse',
		'--verify',
		`${currentHeadSha}^{commit}`,
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

/**
 * Bind a mutable working tree to its actual content, not merely porcelain status.
 * This lets PR-feedback approvals fail closed when a same-path edit occurs after a
 * gate. Paths come from Git, are containment-checked, and are hashed without
 * following symlinks outside the project.
 */
export function resolvePrWorkflowRevisionDigest(
	directory: string,
	baseHeadSha: string,
): string | null {
	const projectRoot = path.resolve(directory);
	const baseHead = runGit(projectRoot, [
		'rev-parse',
		'--verify',
		`${baseHeadSha}^{commit}`,
	]);
	const diffNames = runGit(projectRoot, [
		'diff',
		'--no-ext-diff',
		'--name-only',
		'-z',
		baseHeadSha,
	]);
	const porcelain = runGit(projectRoot, [
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=all',
	]);
	if (!baseHead || diffNames === null || porcelain === null) return null;
	const porcelainPaths = parsePorcelainPaths(porcelain);
	if (!porcelainPaths) return null;
	const changedPaths = [
		...new Set([...parseNulPaths(diffNames), ...porcelainPaths]),
	].sort((left, right) => left.localeCompare(right));
	if (changedPaths.length > REVISION_MAX_FILES) return null;

	const hash = createHash('sha256');
	hash.update(`base\0${baseHead}\0`);
	let totalBytes = 0;
	for (const relativePath of changedPaths) {
		const resolvedPath = path.resolve(projectRoot, relativePath);
		const relativeToRoot = path.relative(projectRoot, resolvedPath);
		if (
			!relativeToRoot ||
			relativeToRoot.startsWith('..') ||
			path.isAbsolute(relativeToRoot)
		)
			return null;
		hash.update(`path\0${relativePath}\0`);
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(resolvedPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				hash.update('deleted\0');
				continue;
			}
			return null;
		}
		if (stats.isSymbolicLink()) {
			try {
				hash.update(`symlink\0${fs.readlinkSync(resolvedPath)}\0`);
				continue;
			} catch {
				return null;
			}
		}
		if (!stats.isFile()) {
			hash.update(`node\0${stats.mode}\0`);
			continue;
		}
		totalBytes += stats.size;
		if (totalBytes > REVISION_MAX_TOTAL_BYTES) return null;
		try {
			hash.update(`file\0${stats.mode}\0`);
			hash.update(fs.readFileSync(resolvedPath));
			hash.update('\0');
		} catch {
			return null;
		}
	}
	return hash.digest('hex');
}

/**
 * Asynchronously bind a mutable working tree to its actual content. File
 * reads are chunked with bounded cooperative yields so a large, permitted
 * revision cannot stall the synchronous plugin gate path.
 */
export async function resolvePrWorkflowRevisionDigestAsync(
	directory: string,
	baseHeadSha: string,
): Promise<string | null> {
	const projectRoot = path.resolve(directory);
	const [baseHead, diffNames, porcelain] = await Promise.all([
		runGitAsync(projectRoot, [
			'rev-parse',
			'--verify',
			`${baseHeadSha}^{commit}`,
		]),
		runGitAsync(projectRoot, [
			'diff',
			'--no-ext-diff',
			'--name-only',
			'-z',
			baseHeadSha,
		]),
		runGitAsync(projectRoot, [
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
		]),
	]);
	if (!baseHead || diffNames === null || porcelain === null) return null;
	const porcelainPaths = parsePorcelainPaths(porcelain);
	if (!porcelainPaths) return null;
	const changedPaths = [
		...new Set([...parseNulPaths(diffNames), ...porcelainPaths]),
	].sort((left, right) => left.localeCompare(right));
	if (changedPaths.length > REVISION_MAX_FILES) return null;

	const hash = createHash('sha256');
	hash.update(`base\0${baseHead}\0`);
	let totalBytes = 0;
	let chunksSinceYield = 0;
	for (const relativePath of changedPaths) {
		const resolvedPath = path.resolve(projectRoot, relativePath);
		const relativeToRoot = path.relative(projectRoot, resolvedPath);
		if (
			!relativeToRoot ||
			relativeToRoot.startsWith('..') ||
			path.isAbsolute(relativeToRoot)
		)
			return null;
		hash.update(`path\0${relativePath}\0`);
		let stats: fs.Stats;
		try {
			stats = await fs.promises.lstat(resolvedPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				hash.update('deleted\0');
				continue;
			}
			return null;
		}
		if (stats.isSymbolicLink()) {
			try {
				hash.update(`symlink\0${await fs.promises.readlink(resolvedPath)}\0`);
				continue;
			} catch {
				return null;
			}
		}
		if (!stats.isFile()) {
			hash.update(`node\0${stats.mode}\0`);
			continue;
		}
		totalBytes += stats.size;
		if (totalBytes > REVISION_MAX_TOTAL_BYTES) return null;
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
				if (bytesRead <= 0) return null;
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
			return null;
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
	return hash.digest('hex');
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

interface PorcelainV2Snapshot {
	gitHead: string | null;
	changedFiles: string[];
}

/**
 * Parse the one-command `git status --porcelain=v2 --branch -z` snapshot used
 * by background evidence capture. A malformed or unknown record fails closed.
 */
function parsePorcelainV2Snapshot(output: string): PorcelainV2Snapshot | null {
	const records = output.split('\0');
	const headers: string[] = [];
	while (records[0]?.startsWith('# ')) {
		headers.push(records.shift()!);
	}
	const oidMatch = headers.join('\n').match(/^# branch\.oid (.+)$/m);
	if (!oidMatch) return null;
	const gitHead = /^[0-9a-f]{6,64}$/i.test(oidMatch[1])
		? oidMatch[1]
		: oidMatch[1] === '(initial)'
			? null
			: null;
	const paths: string[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith('? ')) {
			paths.push(record.slice(2));
			continue;
		}
		if (record.startsWith('1 ')) {
			const changedPath = porcelainV2PathAfterFields(record, 8);
			if (!changedPath) return null;
			paths.push(changedPath);
			continue;
		}
		if (record.startsWith('2 ')) {
			const changedPath = porcelainV2PathAfterFields(record, 9);
			const originalPath = records[++index];
			if (!changedPath || !originalPath) return null;
			paths.push(changedPath, originalPath);
			continue;
		}
		if (record.startsWith('u ')) {
			const changedPath = porcelainV2PathAfterFields(record, 10);
			if (!changedPath) return null;
			paths.push(changedPath);
			continue;
		}
		return null;
	}
	return { gitHead, changedFiles: [...new Set(paths)] };
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
	const porcelain = runGit(directory, [
		'status',
		'--porcelain=v2',
		'--branch',
		'-z',
		'--untracked-files=all',
	]);
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
		changedFiles: snapshot?.changedFiles ?? null,
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
	// A dirty baseline cannot prove which same-path edits belong to this task.
	// Fail closed instead of treating unchanged pre-existing dirt as task output.
	if (baseline.changedFiles.length > 0) return null;
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
		for (const changedPath of parseNulPaths(committed))
			changed.add(changedPath);
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
	yieldControl: () => Promise<void>;
	parsePorcelainV2Snapshot: typeof parsePorcelainV2Snapshot;
} = {
	spawnSync: child_process.spawnSync,
	yieldControl: () => new Promise<void>((resolve) => setImmediate(resolve)),
	parsePorcelainV2Snapshot,
};
