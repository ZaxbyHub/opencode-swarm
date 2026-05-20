/**
 * Handle /swarm pr-review command.
 *
 * Triggers the architect to enter MODE: PR_REVIEW — the swarm PR review workflow.
 * Accepts PR URL in multiple formats and sanitizes inputs against injection.
 *
 * Flag parsing:
 *   --council       → appends council=true to emitted signal
 *   no args         → returns usage string (no throw)
 */

import { execSync } from 'node:child_process';

const MAX_URL_LEN = 2048;

const USAGE = [
	'Usage: /swarm pr-review <url|owner/repo#N|N> [--council]',
	'',
	'Run a full swarm PR review on a GitHub pull request.',
	'  /swarm pr-review https://github.com/owner/repo/pull/42',
	'  /swarm pr-review owner/repo#42',
	'  /swarm pr-review 42 --council',
	'',
	'Flags:',
	'  --council     Run adversarial council variant (all lanes assume work is wrong)',
].join('\n');

/**
 * Strip query strings, fragments, and injected MODE headers from a URL string.
 */
function sanitizeUrl(raw: string): string {
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
 * Blocklist of private/localhost hostnames and IP ranges.
 */
function isPrivateHost(url: URL): boolean {
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
type ValidationResult = { sanitized: string } | { error: string };

function validateAndSanitizeUrl(rawUrl: string): ValidationResult {
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
		const hostname = url.hostname;

		// Check for non-ASCII characters
		if (/[\u0080-\u{10FFFF}]/u.test(hostname)) {
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

interface ParsedArgs {
	council: boolean;
	rest: string[];
}

function parseArgs(args: string[]): ParsedArgs {
	const out: ParsedArgs = { council: false, rest: [] };
	for (const token of args) {
		if (token === '--council') {
			out.council = true;
			continue;
		}
		out.rest.push(token);
	}
	return out;
}

interface ParsedPr {
	owner: string;
	repo: string;
	number: number;
}

/**
 * Parse PR reference from three formats:
 * 1. Full URL: https://github.com/owner/repo/pull/N
 * 2. Shorthand: owner/repo#N
 * 3. Bare number: N (requires git remote)
 */
function parsePrRef(input: string): ParsedPr | null {
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
		const remoteUrl = detectGitRemote();
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
 * Detect the remote URL from git config.
 */
function detectGitRemote(): string | null {
	try {
		const remoteUrl = execSync('git remote get-url origin', {
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 5000,
		}).trim();

		return remoteUrl || null;
	} catch {
		return null;
	}
}

/**
 * Parse owner/repo from a git remote URL.
 * Supports HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
 */
function parseGitRemoteUrl(
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

export function handlePrReviewCommand(
	_directory: string,
	args: string[],
): string {
	const parsed = parseArgs(args);
	const rawInput = parsed.rest.join(' ').trim();

	// No args → return usage
	if (!rawInput) {
		return USAGE;
	}

	// Parse PR reference from input (sanitize first to strip query/fragment from full URLs)
	const isFullUrl = /^https?:\/\//i.test(rawInput);
	const prInfo = parsePrRef(isFullUrl ? sanitizeUrl(rawInput) : rawInput);
	if (!prInfo) {
		return `Error: Could not parse PR reference from "${rawInput}"\n\n${USAGE}`;
	}

	// Build full GitHub URL
	const prUrl = `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`;

	// Validate and sanitize URL
	const result = validateAndSanitizeUrl(prUrl);
	if ('error' in result) {
		return `Error: ${result.error}\n\n${USAGE}`;
	}

	const councilFlag = parsed.council ? 'council=true' : 'council=false';
	return `[MODE: PR_REVIEW pr="${result.sanitized}" ${councilFlag}]`;
}
