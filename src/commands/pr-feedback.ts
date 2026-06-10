/**
 * Handle /swarm pr-feedback command.
 *
 * Triggers the architect to enter MODE: PR_FEEDBACK — the swarm workflow for
 * ingesting and closing KNOWN pull-request feedback (review comments, requested
 * changes, CI failures, merge conflicts, stale branches, pasted notes). This is
 * distinct from /swarm pr-review, which discovers NEW findings.
 *
 * Input contract (PR reference is optional):
 *   /swarm pr-feedback 155                         → feedback pass on PR 155
 *   /swarm pr-feedback 155 also fix the lint errors → PR 155 + extra instructions
 *   /swarm pr-feedback owner/repo#155               → shorthand
 *   /swarm pr-feedback https://github.com/.../pull/155
 *   /swarm pr-feedback                              → bare signal; architect builds
 *                                                     the ledger from current PR/branch
 *   /swarm pr-feedback address the review notes about error handling
 *                                                   → no parseable PR ref ⇒ the whole
 *                                                     input is forwarded as instructions
 *
 * PR-reference parsing and injection-hardening are shared with /swarm pr-review
 * via ./pr-ref.ts.
 */

import {
	looksLikePrRef,
	resolvePrCommandInput,
	sanitizeInstructions,
} from './pr-ref.js';

export function handlePrFeedbackCommand(
	directory: string,
	args: string[],
): string {
	const rest = args.filter((t) => t.trim().length > 0);

	// No args → bare signal. The architect/skill assembles the feedback ledger
	// from the current PR, branch state, and any pasted context.
	if (rest.length === 0) {
		return '[MODE: PR_FEEDBACK]';
	}

	const resolved = resolvePrCommandInput(rest, directory);

	// resolved is non-null here (rest is non-empty). On a parseable PR ref we
	// attach it.
	if (resolved && 'prUrl' in resolved) {
		const signal = `[MODE: PR_FEEDBACK pr="${resolved.prUrl}"]`;
		return resolved.instructions
			? `${signal} ${resolved.instructions}`
			: signal;
	}

	// The leading token is shaped like a PR reference (bare number, shorthand, or
	// URL) but could not be resolved — e.g. a bare number with no reachable
	// `origin` remote, or a rejected URL. Surface the error instead of silently
	// demoting an intended PR reference to free-text feedback.
	if (resolved && 'error' in resolved && looksLikePrRef(rest[0])) {
		return [
			`Error: ${resolved.error}`,
			'',
			'That looked like a PR reference but could not be resolved. Pass a full',
			'URL or `owner/repo#N`, or omit the reference to start a no-PR feedback',
			'session (e.g. `/swarm pr-feedback address the review notes`).',
		].join('\n');
	}

	// Otherwise the input is free-text pasted feedback (pr-feedback explicitly
	// supports no-PR sessions).
	const instructions = sanitizeInstructions(rest.join(' '));
	return instructions
		? `[MODE: PR_FEEDBACK] ${instructions}`
		: '[MODE: PR_FEEDBACK]';
}
