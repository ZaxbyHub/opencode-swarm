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

import {
	containsControlCharacters,
	detectGitRemote,
	parseGitRemoteUrl,
	sanitizeErrorEcho,
	sanitizeUrl,
	validateAndSanitizeGithubUrl,
} from './_shared/url-security.js';

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

function validateAndSanitizeUrl(rawUrl: string) {
	return validateAndSanitizeGithubUrl(rawUrl, 'issues');
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
function parseIssueRef(input: string, directory: string): ParsedIssue | null {
	// Format 1: Full URL
	const urlMatch = input.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i,
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
		const issueNumber = parseInt(bareMatch[1], 10);
		const remoteUrl = detectGitRemote(directory);
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

export function handleIssueCommand(directory: string, args: string[]): string {
	const parsed = parseArgs(args);
	const rawInput = parsed.rest.join(' ').trim();

	// No args → return usage
	if (!rawInput) {
		return USAGE;
	}

	// Parse issue reference from input (sanitize first to strip query/fragment from full URLs)
	const isFullUrl = /^https?:\/\//i.test(rawInput);
	const issueInfo = parseIssueRef(
		isFullUrl ? sanitizeUrl(rawInput) : rawInput,
		directory,
	);
	if (!issueInfo) {
		return `Error: Could not parse issue reference from "${sanitizeErrorEcho(rawInput)}"\n\n${USAGE}`;
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
