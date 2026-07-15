/**
 * Canonical cohort-identity resolver for the linked-swarm knowledge system.
 *
 * Problem (issue #1846): the legacy `deriveProjectHash` (in `./identity.ts`)
 * fed the *raw* `git remote get-url origin` string into SHA-256 with only a
 * `.trim()`. Equivalent remote spellings (SSH vs scp vs HTTPS, optional `.git`,
 * slash direction, host/path case, percent-encoding, NFC/NFD) therefore hashed
 * to *different* cohort ids, fragmenting the linked store. When no origin was
 * present it hashed the absolute worktree path, so sibling worktrees of the
 * same repository became unrelated cohorts.
 *
 * This module is the single canonical identity resolver used by linking (and,
 * going forward, status, diagnostics, cache keys, hive provenance, and worktree
 * suggestions). Resolution order (issue #1846 §1):
 *
 *   1. Normalize a configured Git remote into a provider-neutral host/path
 *      identity so equivalent spellings converge.
 *   2. If no usable remote exists, derive identity from a repository-stable Git
 *      identity shared by sibling worktrees (`git rev-parse --git-common-dir`).
 *      This fallback is machine-local (not portable across machines), so it is
 *      flagged `degraded: true` with a visible warning.
 *   3. Only then fall back to a normalized absolute path (also `degraded`).
 *
 * Subprocess contract (AGENTS.md invariant 3): array-form `execFile('git', …)`,
 * explicit `git -C <dir>`, `stdin` closed immediately, bounded `maxBuffer`, and
 * a `timeout` — Node's `execFile` sends SIGTERM (then SIGKILL) on timeout, so
 * the child is terminated without a manual `kill()`. A defensive `child.on('error')`
 * guard resolves the promise rather than hanging on a spawn failure. This
 * mirrors the compliant precedent in `src/session/worktree-link-suggestion.ts`.
 *
 * This module performs NO writes and holds NO module-level state (invariant 8).
 * It is NOT imported on the plugin-init path (invariant 1); the only caller is
 * `/swarm link` and, lazily, diagnostics — never `server()` resolution.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';

/** Bounded git subprocess timeout (ms). */
const GIT_TIMEOUT_MS = 1_500;

/**
 * Hosts whose owner/repo paths are treated case-insensitively for identity.
 * Most hosted Git providers resolve owner/repo case-insensitively; we encode
 * the common providers and fail safe (preserve path case) for unknown hosts.
 */
const CASE_INSENSITIVE_HOSTS = new Set([
	'github.com',
	'gitlab.com',
	'bitbucket.org',
	'azure.com',
	'visualstudio.com',
]);

export type CohortIdentitySource = 'remote' | 'git-common-dir' | 'path';

export interface CohortIdentity {
	/** 12-hex cohort id (SHA-256 prefix). */
	cohortId: string;
	/** How the id was derived. */
	source: CohortIdentitySource;
	/** Normalized remote (host/owner/repo) when source === 'remote'. */
	normalizedRemote?: string;
	/**
	 * True when the id is machine-local rather than portable across machines
	 * (git-common-dir or path fallback). A degraded cohort is still a strict
	 * improvement over per-worktree isolation, but it is NOT a portable cohort
	 * identity and must be surfaced as a visible warning (issue #1846 §1.3).
	 */
	degraded: boolean;
}

/**
 * Normalize an arbitrary Git remote URL into a canonical `host/owner/repo`
 * string. Equivalent SSH/scp/HTTPS spellings, optional `.git`, slash
 * direction, host/scheme case, path case (for known case-insensitive hosts),
 * percent-encoding, default ports, userinfo, and NFC/NFD all converge.
 *
 * Returns `null` when the input cannot be parsed into a host/owner/repo triple.
 */
export function normalizeGitRemote(rawUrl: string): string | null {
	if (typeof rawUrl !== 'string') return null;
	let url = rawUrl.trim();
	if (url.length === 0) return null;

	// Unicode normalization first so all downstream comparisons share a form.
	url = url.normalize('NFC');

	// Normalize backslashes (Windows copy-paste) to forward slashes BEFORE host
	// splitting so `https://github.com\owner\repo` parses like the slash form.
	url = url.replace(/\\/g, '/');

	let host = '';
	let pathPart = '';

	// Detect scheme case-insensitively (HTTPS://, SSH://, Git:// all valid).
	const lowerForScheme = url.toLowerCase();
	if (lowerForScheme.startsWith('ssh://')) {
		const rest = url.slice('ssh://'.length);
		// Drop userinfo.
		const atIdx = rest.indexOf('@');
		const hostStart = atIdx === -1 ? 0 : atIdx + 1;
		const slashIdx = rest.indexOf('/', hostStart);
		if (slashIdx === -1) return null;
		host = rest.slice(hostStart, slashIdx);
		pathPart = rest.slice(slashIdx + 1);
	} else if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:/.test(url)) {
		// git@host:owner/repo
		const atIdx = url.indexOf('@');
		const colonIdx = url.indexOf(':', atIdx);
		host = url.slice(atIdx + 1, colonIdx);
		pathPart = url.slice(colonIdx + 1);
		// Reject scp-shorthand ambiguity: if pathPart contains a leading slash
		// it was an absolute path, not an scp ref. Keep it; normalization below
		// handles it.
	} else if (
		lowerForScheme.startsWith('https://') ||
		lowerForScheme.startsWith('http://')
	) {
		const schemeEnd = url.indexOf('://');
		const rest = url.slice(schemeEnd + 3);
		// Drop userinfo.
		const atIdx = rest.indexOf('@');
		const hostStart = atIdx === -1 ? 0 : atIdx + 1;
		const slashIdx = rest.indexOf('/', hostStart);
		if (slashIdx === -1) return null;
		host = rest.slice(hostStart, slashIdx);
		pathPart = rest.slice(slashIdx + 1);
	} else if (/^[a-zA-Z0-9_.-]+:[^/]/.test(url) && !url.includes('://')) {
		// scp shorthand without user: host:owner/repo
		const colonIdx = url.indexOf(':');
		host = url.slice(0, colonIdx);
		pathPart = url.slice(colonIdx + 1);
	} else if (lowerForScheme.startsWith('git://')) {
		const rest = url.slice('git://'.length);
		const slashIdx = rest.indexOf('/');
		if (slashIdx === -1) return null;
		host = rest.slice(0, slashIdx);
		pathPart = rest.slice(slashIdx + 1);
	} else {
		// Unrecognized form — cannot canonicalize.
		return null;
	}

	// Backslashes already normalized to slashes above (before host split).

	// Strip default ports. Host may carry :port.
	host = host.toLowerCase();
	host = host.replace(/:443$/, '').replace(/:22$/, '').replace(/:80$/, '');

	// Strip trailing .git and trailing slash on the path.
	pathPart = pathPart.replace(/\.git$/, '').replace(/\/+$/, '');

	// Percent-decode each segment (idempotent guard against double-decoding
	// already-decoded segments that would then contain a stray %).
	try {
		pathPart = pathPart
			.split('/')
			.map((seg) => {
				try {
					return decodeURIComponent(seg);
				} catch {
					return seg;
				}
			})
			.join('/');
	} catch {
		/* keep raw on failure */
	}

	// Collapse empty segments from doubled slashes / leading slash.
	pathPart = pathPart
		.split('/')
		.filter((seg, idx) => !(seg === '' && idx !== 0))
		.join('/');
	pathPart = pathPart.replace(/^\/+/, '');

	// Path case: lowercase for known case-insensitive hosts; preserve otherwise.
	if (CASE_INSENSITIVE_HOSTS.has(host)) {
		pathPart = pathPart.toLowerCase();
	}

	if (host.length === 0 || pathPart.length === 0) return null;
	// Require at least owner/repo (one slash) to be a usable identity.
	if (!pathPart.includes('/')) return null;

	return `${host}/${pathPart}`;
}

/**
 * Run `git -C <dir> <args...>` and return stdout (trimmed) or null on any
 * failure/timeout. Compliant subprocess contract (invariant 3): array form,
 * explicit cwd via `-C`, stdin closed immediately, bounded `maxBuffer`, and a
 * bounded `timeout` — Node's `execFile` sends SIGTERM (then SIGKILL) on
 * timeout, so the child is terminated without a manual `kill()`. A defensive
 * `child.on('error')` guard resolves the promise rather than hanging on a
 * spawn failure.
 */
function runGit(directory: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		try {
			const child = execFile(
				'git',
				['-C', directory, ...args],
				{
					timeout: GIT_TIMEOUT_MS,
					windowsHide: true,
					encoding: 'utf-8',
					maxBuffer: 1024 * 64, // bounded output — a remote url / common-dir is tiny
				},
				(err, stdout) => {
					if (err || typeof stdout !== 'string') {
						resolve(null);
						return;
					}
					resolve(stdout.trim());
				},
			);
			// Close stdin immediately: git reads nothing here, and a never-closed
			// stdin pipe under Bun on Windows can block child exit (invariant 3).
			try {
				child.stdin?.end();
			} catch {
				/* stdin already closed */
			}
			child.on('error', () => resolve(null));
		} catch {
			resolve(null);
		}
	});
}

/** SHA-256 prefix (12 hex) — matches the legacy `deriveProjectHash` width. */
function cohortHash(input: string): string {
	return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Fold a realpath'd absolute path into a stable cohort-id input. On Windows,
 * path separators and drive-letter case are insignificant, and `realpathSync`
 * can emit an extended-length `\\?\` prefix for one spelling of a path but not
 * another; none of these differences should split a cohort, so we fold them
 * all. A trailing separator is likewise insignificant. This is defence in
 * depth: the primary convergence guarantee comes from asking git for the
 * ABSOLUTE common dir (see `resolveCohortId`), which hands every worktree of a
 * repo one identical string; this folding only removes any residual spelling
 * difference that survives realpath.
 */
function stabilizePath(input: string): string {
	return input
		.replace(/\\/g, '/') // OS-native separators → forward slashes
		.replace(/^\/\/\?\//, '') // strip Windows \\?\ extended-length prefix
		.replace(/\/+$/, '') // strip trailing slash(es)
		.toLowerCase();
}

/**
 * Resolve the canonical cohort identity for a worktree directory.
 *
 * Resolution order:
 *   1. Normalized origin remote (portable cohort identity; not degraded).
 *   2. `git rev-parse --path-format=absolute --git-common-dir` — shared by
 *      sibling worktrees of the same repo, but machine-local → degraded.
 *   3. Realpath of the directory — last resort, machine-local → degraded.
 *
 * Never throws. The path fallback always succeeds.
 */
export async function resolveCohortId(
	directory: string,
): Promise<CohortIdentity> {
	// 1. Remote.
	const remoteUrl = await _internals.runGit(directory, [
		'remote',
		'get-url',
		'origin',
	]);
	if (remoteUrl && remoteUrl.length > 0) {
		const normalized = normalizeGitRemote(remoteUrl);
		if (normalized) {
			return {
				cohortId: cohortHash(normalized),
				source: 'remote',
				normalizedRemote: normalized,
				degraded: false,
			};
		}
		// Remote present but unparseable → fall through to git-common-dir so
		// sibling worktrees still converge on this machine.
	}

	// 2. git rev-parse --git-common-dir (repository-stable, worktree-shared).
	//
	// Ask git for the ABSOLUTE common dir (`--path-format=absolute`) so the main
	// worktree and every linked worktree receive the *identical* string from the
	// same git binary. Plain `--git-common-dir` returns a relative `.git` from
	// the main worktree but an absolute path from a linked worktree; those two
	// spellings were then canonicalized down two different code paths and, on
	// Windows (under Bun), did NOT converge even after separator/case folding —
	// splitting sibling worktrees into different cohorts in the merge-queue CI
	// (issue #1846 Windows regression, PR #1851). Forcing absolute output makes
	// git compute one canonical path for both, so realpath receives one input
	// and returns one hash regardless of platform-specific realpath quirks
	// (`\\?\` prefixes, short-name expansion, etc.) — same input, same output.
	//
	// `--path-format` requires git >= 2.31; on older git the option errors and
	// runGit resolves null, so we fall back to the plain (pre-fix) form, which
	// still converges on case-sensitive POSIX filesystems.
	let commonDirRaw = await _internals.runGit(directory, [
		'rev-parse',
		'--path-format=absolute',
		'--git-common-dir',
	]);
	if (!commonDirRaw || commonDirRaw.length === 0) {
		commonDirRaw = await _internals.runGit(directory, [
			'rev-parse',
			'--git-common-dir',
		]);
	}
	if (commonDirRaw && commonDirRaw.length > 0) {
		try {
			// Resolve against `directory` (a no-op when git already returned an
			// absolute path) then realpath, so any residual symlink/short-name
			// form is canonicalized identically for every worktree of the repo.
			const resolved = path.resolve(directory, commonDirRaw);
			const canonical = realpathSync(resolved);
			return {
				cohortId: cohortHash(stabilizePath(canonical)),
				source: 'git-common-dir',
				degraded: true,
			};
		} catch {
			/* fall through to path */
		}
	}

	// 3. Absolute path fallback (last resort).
	let canonicalPath: string;
	try {
		canonicalPath = realpathSync(path.resolve(directory));
	} catch {
		canonicalPath = path.resolve(directory);
	}
	// Same separator/case/prefix folding as the git-common-dir branch: two
	// paths that differ only by OS-native separator, drive-letter case, a
	// Windows `\\?\` prefix, or a trailing slash must not produce different
	// cohort ids (issue #1846 Windows CI fix).
	return {
		cohortId: cohortHash(stabilizePath(canonicalPath)),
		source: 'path',
		degraded: true,
	};
}

export const _internals = {
	normalizeGitRemote,
	runGit,
	cohortHash,
	stabilizePath,
	GIT_TIMEOUT_MS,
};
