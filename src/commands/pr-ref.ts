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

import {
	_internals,
	containsControlCharacters,
	detectGitRemote,
	parseGitRemoteUrl,
	sanitizeErrorEcho,
	sanitizeUrl,
	type ValidationResult,
	validateAndSanitizeGithubUrl,
} from './_shared/url-security.js';

export { _internals, detectGitRemote, parseGitRemoteUrl, sanitizeUrl };

/** Upper bound on forwarded free-text instructions (post-sanitization). */
const MAX_INSTRUCTIONS_LEN = 1000;

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

export function validateAndSanitizeUrl(rawUrl: string): ValidationResult {
	return validateAndSanitizeGithubUrl(rawUrl, 'pull');
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
		if (
			containsControlCharacters(urlMatch[1]) ||
			containsControlCharacters(urlMatch[2])
		) {
			return null;
		}
		return {
			owner: urlMatch[1],
			repo: urlMatch[2],
			number: parseInt(urlMatch[3], 10),
		};
	}

	// Format 2: Shorthand owner/repo#N
	const shorthandMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (shorthandMatch) {
		if (
			containsControlCharacters(shorthandMatch[1]) ||
			containsControlCharacters(shorthandMatch[2])
		) {
			return null;
		}
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
		return {
			error: `Could not parse PR reference from "${sanitizeErrorEcho(refToken)}"`,
		};
	}

	const prUrl = `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`;
	const result = validateAndSanitizeUrl(prUrl);
	if ('error' in result) {
		return { error: result.error };
	}

	return { prUrl: result.sanitized, instructions };
}
