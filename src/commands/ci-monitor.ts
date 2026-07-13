/**
 * Handle /swarm ci-monitor command.
 *
 * Triggers the architect to enter MODE: CI_MONITOR — drives an already
 * human-reviewed, approved PR to green and merged. Accepts a PR reference in
 * the same three formats as /swarm pr-review and /swarm pr-feedback (full
 * URL, owner/repo#N, or a bare PR number resolved against the origin
 * remote). No free-text instructions are forwarded: this is a mechanical,
 * deliberately-invoked closeout flow, not a review or feedback session.
 *
 * PR-reference parsing and sanitization are shared with /swarm pr-review and
 * /swarm pr-feedback via ./pr-ref.ts.
 */

import { resolvePrCommandInput } from './pr-ref.js';

const USAGE = [
	'Usage: /swarm ci-monitor <pr-url|owner/repo#N|N>',
	'',
	'Drive an already human-reviewed, approved pull request to green and',
	'merged: monitors CI, exhaustively researches and fixes each failure,',
	'iterates until all required checks are green (max 5 fix cycles), then',
	'merges. Only invoke after human review is complete.',
	'',
	'  /swarm ci-monitor https://github.com/owner/repo/pull/42',
	'  /swarm ci-monitor owner/repo#42',
	'  /swarm ci-monitor 42',
].join('\n');

export function handleCiMonitorCommand(
	directory: string,
	args: string[],
): string {
	const rest = args.filter((token) => token.trim().length > 0);
	const resolved = resolvePrCommandInput(rest, directory);

	if (resolved === null) {
		return USAGE;
	}

	if ('error' in resolved) {
		return `Error: ${resolved.error}\n\n${USAGE}`;
	}

	const signal = `[MODE: CI_MONITOR pr="${resolved.prUrl}"]`;
	return resolved.instructions ? `${signal} ${resolved.instructions}` : signal;
}
