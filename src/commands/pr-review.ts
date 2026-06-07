/**
 * Handle /swarm pr-review command.
 *
 * Triggers the architect to enter MODE: PR_REVIEW — the swarm PR review workflow.
 * Accepts a PR reference in multiple formats (full URL, owner/repo#N, or a bare
 * PR number resolved against the origin remote) optionally followed by
 * free-text instructions, and sanitizes all inputs against injection.
 *
 * Flag parsing:
 *   --council       → appends council=true to emitted signal
 *   <ref> <text...> → trailing text becomes forwarded instructions
 *   no args         → returns usage string (no throw)
 *
 * PR-reference parsing and sanitization are shared with /swarm pr-feedback via
 * ./pr-ref.ts.
 */

import { resolvePrCommandInput } from './pr-ref.js';

const USAGE = [
	'Usage: /swarm pr-review <url|owner/repo#N|N> [--council] [instructions...]',
	'',
	'Run a full swarm PR review on a GitHub pull request.',
	'  /swarm pr-review https://github.com/owner/repo/pull/42',
	'  /swarm pr-review owner/repo#42',
	'  /swarm pr-review 42 --council',
	'  /swarm pr-review 42 focus on the auth refactor and the new retry logic',
	'',
	'Flags:',
	'  --council     Run adversarial council variant (all lanes assume work is wrong)',
	'',
	'Any text after the PR reference is forwarded to the reviewer as extra instructions.',
].join('\n');

interface ParsedArgs {
	council: boolean;
	rest: string[];
	unknownFlag?: string;
}

function parseArgs(args: string[]): ParsedArgs {
	const out: ParsedArgs = { council: false, rest: [] };
	for (const token of args) {
		if (token === '--council') {
			out.council = true;
			continue;
		}
		// Reject unknown --flags rather than swallowing them into the trailing
		// instructions. Free-text instructions are non-flag words.
		if (token.startsWith('--')) {
			if (out.unknownFlag === undefined) out.unknownFlag = token;
			continue;
		}
		// Drop blank/whitespace-only tokens so `[' ', '']` is treated as no-args.
		if (token.trim().length === 0) continue;
		out.rest.push(token);
	}
	return out;
}

export function handlePrReviewCommand(
	directory: string,
	args: string[],
): string {
	const parsed = parseArgs(args);

	if (parsed.unknownFlag) {
		return `Error: Unknown flag "${parsed.unknownFlag}"\n\n${USAGE}`;
	}

	const resolved = resolvePrCommandInput(parsed.rest, directory);

	// No positional args → usage.
	if (resolved === null) {
		return USAGE;
	}

	if ('error' in resolved) {
		return `Error: ${resolved.error}\n\n${USAGE}`;
	}

	const councilFlag = parsed.council ? 'council=true' : 'council=false';
	const signal = `[MODE: PR_REVIEW pr="${resolved.prUrl}" ${councilFlag}]`;
	return resolved.instructions ? `${signal} ${resolved.instructions}` : signal;
}
