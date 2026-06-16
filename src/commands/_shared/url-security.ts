import { spawnSync } from 'node:child_process';

export const MAX_URL_LEN = 2048;
const IPV4_PRIVATE = /^10\./;
const IPV4_LOOPBACK = /^127\./;
const IPV4_LINK_LOCAL = /^169\.254\./;
const IPV4_PRIVATE_172 = /^172\.(1[6-9]|2\d|3[0-1])\./;
const IPV4_PRIVATE_192 = /^192\.168\./;
const IPV4_ZERO_NETWORK = /^0\./;
const IPV6_LINK_LOCAL = /^fe80:/i;
const IPV6_UNIQUE_LOCAL = /^f[cd][0-9a-f]{2}:/i;

export type ValidationResult = { sanitized: string } | { error: string };

/**
 * File-scoped indirection seam for git remote lookups.
 */
export const _internals = { spawnSync };

/**
 * Strip query strings, fragments, injected MODE headers, and credentials from
 * a URL string.
 */
export function sanitizeUrl(raw: string): string {
	let urlStr = raw.trim();

	urlStr = urlStr.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');

	const fragmentIdx = urlStr.indexOf('#');
	if (fragmentIdx !== -1) {
		urlStr = urlStr.slice(0, fragmentIdx);
	}

	const queryIdx = urlStr.indexOf('?');
	if (queryIdx !== -1) {
		urlStr = urlStr.slice(0, queryIdx);
	}

	urlStr = urlStr.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^@/]+@/, 'https://');

	if (urlStr.length > MAX_URL_LEN) {
		urlStr = urlStr.slice(0, MAX_URL_LEN);
	}

	return urlStr.trim();
}

/**
 * Strip control characters from user-visible error echoes and bound the result.
 */
export function sanitizeErrorEcho(raw: string, maxLength: number = 80): string {
	let stripped = '';
	for (const ch of raw) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && (cp <= 0x1f || cp === 0x7f)) {
			stripped += ' ';
			continue;
		}
		stripped += ch;
	}
	const collapsed = stripped.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, maxLength)}…`;
}

export function containsControlCharacters(value: string): boolean {
	for (const ch of value) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && (cp <= 0x1f || cp === 0x7f)) {
			return true;
		}
	}
	return false;
}

/**
 * Returns true if the hostname contains any non-ASCII code point (IDN
 * homograph protection).
 */
function hasNonAsciiHostname(hostname: string): boolean {
	for (const ch of hostname) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined && cp > 0x7f) return true;
	}
	return false;
}

export function isIpv4MappedPrivateHost(inner: string): boolean {
	if (
		IPV4_PRIVATE.test(inner) ||
		IPV4_LOOPBACK.test(inner) ||
		IPV4_LINK_LOCAL.test(inner) ||
		IPV4_PRIVATE_172.test(inner) ||
		IPV4_PRIVATE_192.test(inner) ||
		IPV4_ZERO_NETWORK.test(inner)
	) {
		return true;
	}

	const firstSegment = inner.split(':', 1)[0];
	if (!firstSegment) return false;
	const firstWord = Number.parseInt(firstSegment, 16);
	if (!Number.isFinite(firstWord)) return false;

	return (
		(firstWord >= 0x0000 && firstWord <= 0x00ff) ||
		(firstWord >= 0x0a00 && firstWord <= 0x0aff) ||
		(firstWord >= 0x7f00 && firstWord <= 0x7fff) ||
		firstWord === 0xa9fe ||
		(firstWord >= 0xac10 && firstWord <= 0xac1f) ||
		firstWord === 0xc0a8
	);
}

/**
 * Blocklist of private/localhost hostnames and IP ranges.
 */
export function isPrivateHost(url: URL): boolean {
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

	if (
		host === 'localhost' ||
		host === '::1' ||
		host === '0.0.0.0' ||
		IPV4_LOOPBACK.test(host) ||
		IPV4_ZERO_NETWORK.test(host)
	) {
		return true;
	}

	if (host.startsWith('localhost') || host === 'localhost.com') {
		return true;
	}

	if (
		IPV4_PRIVATE.test(host) ||
		IPV4_LINK_LOCAL.test(host) ||
		IPV4_PRIVATE_172.test(host) ||
		IPV4_PRIVATE_192.test(host) ||
		IPV6_LINK_LOCAL.test(host) ||
		IPV6_UNIQUE_LOCAL.test(host)
	) {
		return true;
	}

	if (host.startsWith('::ffff:')) {
		const inner = host.slice(7);
		if (isIpv4MappedPrivateHost(inner)) {
			return true;
		}
	}

	return false;
}

/**
 * Validate and sanitize a GitHub URL for a specific resource kind.
 */
export function validateAndSanitizeGithubUrl(
	rawUrl: string,
	resource: 'issues' | 'pull',
): ValidationResult {
	const sanitized = sanitizeUrl(rawUrl);

	if (!sanitized) {
		return { error: 'Empty URL' };
	}

	if (!sanitized.startsWith('https://')) {
		return { error: 'URL must use HTTPS scheme' };
	}

	try {
		const url = new URL(sanitized);

		if (hasNonAsciiHostname(url.hostname)) {
			return { error: 'Non-ASCII hostnames are not allowed' };
		}

		if (isPrivateHost(url)) {
			return { error: 'Private or localhost URLs are not allowed' };
		}

		const githubPattern = new RegExp(
			`^https:\\/\\/github\\.com\\/([^/]+)\\/([^/]+)\\/${resource}\\/([0-9]+)\\/?$`,
		);
		if (!githubPattern.test(sanitized)) {
			return {
				error:
					resource === 'issues'
						? 'URL must be a GitHub issue URL (https://github.com/owner/repo/issues/N)'
						: 'URL must be a GitHub pull request URL (https://github.com/owner/repo/pull/N)',
			};
		}

		return { sanitized };
	} catch {
		return { error: 'Invalid URL format' };
	}
}

/**
 * Detect the `origin` remote URL from git config.
 */
export function detectGitRemote(cwd?: string): string | null {
	try {
		const result = _internals.spawnSync(
			'git',
			['remote', 'get-url', 'origin'],
			{
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 5000,
				...(cwd ? { cwd } : {}),
			},
		);

		if (result.status !== 0 || result.error) {
			return null;
		}

		const remoteUrl = (result.stdout ?? '').trim();

		return remoteUrl || null;
	} catch {
		return null;
	}
}

/**
 * Parse owner/repo from a git remote URL.
 */
export function parseGitRemoteUrl(
	remoteUrl: string,
): { owner: string; repo: string } | null {
	const httpsMatch = remoteUrl.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	if (httpsMatch) {
		const owner = httpsMatch[1];
		const repo = httpsMatch[2].replace(/\.git$/, '');
		if (containsControlCharacters(owner) || containsControlCharacters(repo)) {
			return null;
		}
		return { owner, repo };
	}

	const sshMatch = remoteUrl.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
	);
	if (sshMatch) {
		const owner = sshMatch[1];
		const repo = sshMatch[2].replace(/\.git$/, '');
		if (containsControlCharacters(owner) || containsControlCharacters(repo)) {
			return null;
		}
		return { owner, repo };
	}

	const pathMatch = remoteUrl.match(/\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
	if (pathMatch) {
		const owner = pathMatch[1];
		const repo = pathMatch[2].replace(/\.git$/, '');
		if (containsControlCharacters(owner) || containsControlCharacters(repo)) {
			return null;
		}
		return { owner, repo };
	}

	return null;
}

export function isIPv4ZeroNetwork(host: string): boolean {
	return IPV4_ZERO_NETWORK.test(host);
}
