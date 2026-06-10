/**
 * Shared GitHub PR-reference parsing and sanitization for the
 * `/swarm pr-review` and `/swarm pr-feedback` commands.
 *
 * Both commands accept a PR reference in three formats (full URL,
 * `owner/repo#N`, or a bare PR number resolved against the `origin` remote)
 * and may be followed by free-text instructions that are forwarded to the
 * architect in the emitted `[MODE: ...]` signal. All parsing here is hardened
 * against prompt injection: rival `[MODE: ...]` headers, query strings,
 * fragments, and embedded credentials are stripped before the value is ever
 * placed back into a signal string.
 */

import { execSync } from 'node:child_process';

/**
 * File-scoped indirection seam for the subprocess call. Tests override
 * `_internals.execSync` (no `mock.module`) to assert the working directory is
 * threaded through and to simulate a missing `origin` remote.
 */
export const _internals = { execSync };

const MAX_URL_LEN = 2048;
/** Upper bound on forwarded free-text instructions (post-sanitization). */
const MAX_INSTRUCTIONS_LEN = 1000;

/**
 * Strip query strings, fragments, injected MODE headers, and credentials from
 * a URL string.
 */
export function sanitizeUrl(raw: string): string {
	let urlStr = raw.trim();

	// Strip [MODE: ...] sequences (case-insensitive)
	urlStr = urlStr.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');

	// Strip fragment identifiers
	const fragmentIdx = urlStr.indexOf('#');
	if (fragmentIdx !== -1) {
		urlStr = urlStr.slice(0, fragmentIdx);
	}

	// Strip query strings
	const queryIdx = urlStr.indexOf('?');
	if (queryIdx !== -1) {
		urlStr = urlStr.slice(0, queryIdx);
	}

	// Strip credentials (user:pass@)
	urlStr = urlStr.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^@/]+@/, 'https://');

	// Enforce max length
	if (urlStr.length > MAX_URL_LEN) {
		urlStr = urlStr.slice(0, MAX_URL_LEN);
	}

	return urlStr.trim();
}

/**
 * Sanitize free-text instructions so they cannot forge a competing MODE
 * header, inject control sequences, or break out of the signal line.
 * Collapses whitespace (including newlines), strips bracketed `[MODE: ...]`
 * headers, and truncates to a bounded length.
 */
export function sanitizeInstructions(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	const stripped = collapsed.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');
	const normalized = stripped.replace(/\s+/g, ' ').trim();
	if (normalized.length <= MAX_INSTRUCTIONS_LEN) return normalized;
	return `${normalized.slice(0, MAX_INSTRUCTIONS_LEN)}…`;
}

/**
 * Returns true if the hostname contains any non-ASCII code point (IDN
 * homograph protection). Implemented as an explicit code-point scan to avoid
 * embedding control characters or fragile escape ranges in source.
 */
function hasNonAsciiHostname(hostname: string): boolean {
	for (const ch of hostname) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && cp > 0x7f) return true;
	}
	return false;
}

/**
 * Blocklist of private/localhost hostnames and IP ranges.
 */
export function isPrivateHost(url: URL): boolean {
	const host = url.hostname.toLowerCase();

	// Block localhost variants
	if (
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host === '0.0.0.0'
	) {
		return true;
	}

	// Block local hosts
	if (host.startsWith('localhost') || host === 'localhost.com') {
		return true;
	}

	// Block private IP ranges
	// IPv4 private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
	// IPv6 private: fc00::/7, fe80::/10
	const ipv4Private = /^10\./;
	const ipv4172 = /^172\.(1[6-9]|2\d|3[0-1])\./;
	const ipv4192 = /^192\.168\./;
	const ipv6Private = /^fe80:/i;
	const ipv6Unique = /^f[cd][0-9a-f]{2}:/i;

	if (
		ipv4Private.test(host) ||
		ipv4172.test(host) ||
		ipv4192.test(host) ||
		ipv6Private.test(host) ||
		ipv6Unique.test(host)
	) {
		return true;
	}

	// Block IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
	if (host.startsWith('::ffff:')) {
		const inner = host.slice(7);
		if (ipv4Private.test(inner) || ipv4172.test(inner) || ipv4192.test(inner)) {
			return true;
		}
	}

	return false;
}

/**
 * Validate and sanitize a GitHub PR URL.
 * Returns the sanitized URL on success, or an error message on failure.
 */
export type ValidationResult = { sanitized: string } | { error: string };

export function validateAndSanitizeUrl(rawUrl: string): ValidationResult {
	const sanitized = sanitizeUrl(rawUrl);

	if (!sanitized) {
		return { error: 'Empty URL' };
	}

	if (!sanitized.startsWith('https://')) {
		return { error: 'URL must use HTTPS scheme' };
	}

	// Reject non-ASCII hostnames (IDN homograph protection)
	try {
		const url = new URL(sanitized);

		if (hasNonAsciiHostname(url.hostname)) {
			return { error: 'Non-ASCII hostnames are not allowed' };
		}

		// Block private/localhost
		if (isPrivateHost(url)) {
			return { error: 'Private or localhost URLs are not allowed' };
		}

		// Validate GitHub PR URL format
		const githubPrPattern =
			/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([0-9]+)\/?$/;
		if (!githubPrPattern.test(sanitized)) {
			return {
				error:
					'URL must be a GitHub pull request URL (https://github.com/owner/repo/pull/N)',
			};
		}

		return { sanitized };
	} catch {
		return { error: 'Invalid URL format' };
	}
}

export interface ParsedPr {
	owner: string;
	repo: string;
	number: number;
}

/**
 * Parse a PR reference from three formats:
 * 1. Full URL: https://github.com/owner/repo/pull/N
 * 2. Shorthand: owner/repo#N
 * 3. Bare number: N (resolved against the `origin` git remote in `cwd`)
 */
export function parsePrRef(input: string, cwd?: string): ParsedPr | null {
	// Format 1: Full URL
	const urlMatch = input.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i,
	);
	if (urlMatch) {
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			number: parseInt(urlMatch[3], 10),
		};
	}

	// Format 2: Shorthand owner/repo#N
	const shorthandMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (shorthandMatch) {
		return {
			owner: shorthandMatch[1],
			repo: shorthandMatch[2],
			number: parseInt(shorthandMatch[3], 10),
		};
	}

	// Format 3: Bare number - needs git remote detection
	const bareMatch = input.match(/^(\d+)$/);
	if (bareMatch) {
		const prNumber = parseInt(bareMatch[1], 10);
		const remoteUrl = detectGitRemote(cwd);
		if (!remoteUrl) {
			return null;
		}

		const parsed = parseGitRemoteUrl(remoteUrl);
		if (!parsed) {
			return null;
		}

		return {
			owner: parsed.owner,
			repo: parsed.repo,
			number: prNumber,
		};
	}

	return null;
}

/**
 * Detect the `origin` remote URL from git config.
 *
 * `cwd` should be the project directory the command was invoked for. Without it
 * the lookup runs in `process.cwd()`, which in a plugin host is frequently not
 * the repository root — so bare-number PR resolution would silently fail or
 * resolve against the wrong repo (invariant #3: subprocesses run in an explicit
 * working directory).
 */
export function detectGitRemote(cwd?: string): string | null {
	try {
		const remoteUrl = _internals
			.execSync('git remote get-url origin', {
				encoding: 'utf-8',
				stdio: ['pipe', 'pipe', 'pipe'],
				timeout: 5000,
				...(cwd ? { cwd } : {}),
			})
			.trim();

		return remoteUrl || null;
	} catch {
		return null;
	}
}

/**
 * Parse owner/repo from a git remote URL.
 * Supports HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
 */
export function parseGitRemoteUrl(
	remoteUrl: string,
): { owner: string; repo: string } | null {
	// HTTPS format: https://github.com/owner/repo.git
	const httpsMatch = remoteUrl.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	if (httpsMatch) {
		return {
			owner: httpsMatch[1],
			repo: httpsMatch[2].replace(/\.git$/, ''),
		};
	}

	// SSH format: git@github.com:owner/repo.git
	const sshMatch = remoteUrl.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
	);
	if (sshMatch) {
		return {
			owner: sshMatch[1],
			repo: sshMatch[2].replace(/\.git$/, ''),
		};
	}

	// Generic fallback: extract the last two path segments as owner/repo.
	// Handles proxy remotes (http://proxy/git/owner/repo) and GitHub Enterprise
	// instances whose host doesn't match github.com.
	const pathMatch = remoteUrl.match(/\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
	if (pathMatch) {
		return {
			owner: pathMatch[1],
			repo: pathMatch[2].replace(/\.git$/, ''),
		};
	}

	return null;
}

/**
 * Whether a token is *shaped* like a PR reference — a full `http(s)` URL, an
 * `owner/repo#N` shorthand, or a bare number. This is intent detection, not
 * validation: a token can look like a PR ref yet still fail to resolve (e.g. a
 * bare number when no `origin` remote exists, or a non-GitHub URL). Callers that
 * accept free-text fallbacks (pr-feedback) use this to tell "the user meant a PR
 * reference but it didn't resolve" (surface an error) from "the user typed
 * instructions" (forward them).
 */
export function looksLikePrRef(token: string): boolean {
	return (
		/^https?:\/\//i.test(token) ||
		/^[^/]+\/[^#]+#\d+$/.test(token) ||
		/^\d+$/.test(token)
	);
}

/**
 * Resolve the leading token of a PR command's positional args into a validated
 * GitHub PR URL, and collect any trailing tokens as free-text instructions.
 *
 * `rest` is the positional token list AFTER flag parsing (e.g. `--council`
 * already removed). The first token is the PR reference; everything after it
 * is sanitized and returned as `instructions` for forwarding in the MODE
 * signal. `cwd` is the project directory used to resolve a bare PR number
 * against the `origin` remote.
 *
 * Returns `null` when there are no positional tokens (caller shows usage).
 */
export type PrCommandInput =
	| { prUrl: string; instructions: string }
	| { error: string };

export function resolvePrCommandInput(
	rest: string[],
	cwd?: string,
): PrCommandInput | null {
	if (rest.length === 0) {
		// No args at all — caller should show usage.
		return null;
	}

	const refToken = rest[0];
	const instructions = sanitizeInstructions(rest.slice(1).join(' '));

	// Parse PR reference (sanitize full URLs first to strip query/fragment).
	const isFullUrl = /^https?:\/\//i.test(refToken);
	const prInfo = parsePrRef(isFullUrl ? sanitizeUrl(refToken) : refToken, cwd);
	if (!prInfo) {
		return { error: `Could not parse PR reference from "${refToken}"` };
	}

	const prUrl = `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`;
	const result = validateAndSanitizeUrl(prUrl);
	if ('error' in result) {
		return { error: result.error };
	}

	return { prUrl: result.sanitized, instructions };
}
