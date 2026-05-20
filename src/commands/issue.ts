/**
 * Handle /swarm issue command.
 *
 * Triggers the architect to enter MODE: ISSUE_INGEST — the swarm issue ingest workflow.
 * Accepts issue URL in multiple formats and sanitizes inputs against injection.
 *
 * Flag parsing:
 *   --plan        → appends plan=true to emitted signal
 *   --trace       → appends trace=true to emitted signal (implies --plan)
 *   --no-repro    → appends noRepro=true to emitted signal
 *   no args       → returns usage string (no throw)
 */

import { execSync } from 'node:child_process';

const MAX_URL_LEN = 2048;

const USAGE = [
	'Usage: /swarm issue <url|owner/repo#N|N> [--plan] [--trace] [--no-repro]',
	'',
	'Ingest a GitHub issue into the swarm workflow.',
	'  /swarm issue https://github.com/owner/repo/issues/42',
	'  /swarm issue owner/repo#42',
	'  /swarm issue 42 --plan',
	'  /swarm issue 42 --trace --no-repro',
	'',
	'Flags:',
	'  --plan        Transition to plan creation after spec generation',
	'  --trace       Run full fix-and-PR workflow (implies --plan)',
	'  --no-repro    Skip reproduction step',
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
 * Validate and sanitize a GitHub issue URL.
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

		// Validate GitHub issue URL format
		const githubIssuePattern =
			/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([0-9]+)\/?$/;
		if (!githubIssuePattern.test(sanitized)) {
			return {
				error:
					'URL must be a GitHub issue URL (https://github.com/owner/repo/issues/N)',
			};
		}

		return { sanitized };
	} catch {
		return { error: 'Invalid URL format' };
	}
}

interface ParsedArgs {
	plan: boolean;
	trace: boolean;
	noRepro: boolean;
	rest: string[];
}

function parseArgs(args: string[]): ParsedArgs {
	const out: ParsedArgs = {
		plan: false,
		trace: false,
		noRepro: false,
		rest: [],
	};
	for (const token of args) {
		if (token === '--plan') {
			out.plan = true;
			continue;
		}
		if (token === '--trace') {
			out.trace = true;
			out.plan = true; // --trace implies --plan
			continue;
		}
		if (token === '--no-repro') {
			out.noRepro = true;
			continue;
		}
		out.rest.push(token);
	}
	return out;
}

interface ParsedIssue {
	owner: string;
	repo: string;
	number: number;
}

/**
 * Parse issue reference from three formats:
 * 1. Full URL: https://github.com/owner/repo/issues/N
 * 2. Shorthand: owner/repo#N
 * 3. Bare number: N (requires git remote)
 */
function parseIssueRef(input: string): ParsedIssue | null {
	// Format 1: Full URL
	const urlMatch = input.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i,
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
		const issueNumber = parseInt(bareMatch[1], 10);
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
			number: issueNumber,
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

	return null;
}

export function handleIssueCommand(_directory: string, args: string[]): string {
	const parsed = parseArgs(args);
	const rawInput = parsed.rest.join(' ').trim();

	// No args → return usage
	if (!rawInput) {
		return USAGE;
	}

	// Parse issue reference from input (sanitize first to strip query/fragment from full URLs)
	const isFullUrl = /^https?:\/\//i.test(rawInput);
	const issueInfo = parseIssueRef(isFullUrl ? sanitizeUrl(rawInput) : rawInput);
	if (!issueInfo) {
		return `Error: Could not parse issue reference from "${rawInput}"\n\n${USAGE}`;
	}

	// Build full GitHub URL
	const issueUrl = `https://github.com/${issueInfo.owner}/${issueInfo.repo}/issues/${issueInfo.number}`;

	// Validate and sanitize URL
	const result = validateAndSanitizeUrl(issueUrl);
	if ('error' in result) {
		return `Error: ${result.error}\n\n${USAGE}`;
	}

	// Build flags string
	const flags: string[] = [];
	if (parsed.plan) flags.push('plan=true');
	if (parsed.trace) flags.push('trace=true');
	if (parsed.noRepro) flags.push('noRepro=true');
	const flagsStr = flags.length > 0 ? ` ${flags.join(' ')}` : '';

	return `[MODE: ISSUE_INGEST issue="${result.sanitized}"${flagsStr}]`;
}
