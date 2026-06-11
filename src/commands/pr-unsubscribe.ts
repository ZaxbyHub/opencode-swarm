/**
 * Handle /swarm pr unsubscribe command.
 *
 * Unsubscribes the current session from PR state-change notifications.
 * Removes the active subscription record so the background polling
 * worker will no longer watch this PR for the current session.
 *
 * Input contract (PR reference is required):
 *   /swarm pr unsubscribe 155                       → unsubscribe via bare number
 *   /swarm pr unsubscribe owner/repo#155             → shorthand
 *   /swarm pr unsubscribe https://github.com/.../pull/155
 *   /swarm pr unsubscribe                            → usage (no bare invocation)
 *
 * PR-reference parsing is shared with /swarm pr-review, /swarm pr-feedback,
 * and /swarm pr subscribe via ./pr-ref.ts.
 */

import {
	buildCorrelationId,
	unsubscribe,
} from '../background/pr-subscriptions.js';
import { looksLikePrRef, parsePrRef } from './pr-ref.js';

/**
 * Unsubscribe the current session from PR monitoring notifications.
 *
 * Requires a PR reference argument (no bare invocation). Looks up the active
 * subscription for the current session and PR; if none is found, returns an
 * informational message. If found, marks the subscription as removed.
 */
export async function handlePrUnsubscribeCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	const rest = args.filter((t) => t.trim().length > 0);

	// PR reference is required — no bare invocation.
	if (rest.length === 0) {
		return [
			'Usage: /swarm pr unsubscribe <pr-url|owner/repo#N|N>',
			'',
			'Unsubscribes the current session from receiving advisory',
			'notifications for the specified PR. Removes the active',
			'subscription record.',
			'',
			'  /swarm pr unsubscribe https://github.com/owner/repo/pull/42',
			'  /swarm pr unsubscribe owner/repo#42',
			'  /swarm pr unsubscribe 42',
		].join('\n');
	}

	const refToken = rest[0];
	const prInfo = parsePrRef(refToken, directory);

	if (!prInfo) {
		if (looksLikePrRef(refToken)) {
			return [
				`Error: Could not resolve PR reference from "${refToken}".`,
				'',
				'That looked like a PR reference but could not be resolved.',
				'Pass a full URL or `owner/repo#N`, or verify your git',
				'`origin` remote points to a GitHub repository.',
			].join('\n');
		}

		return [
			`Error: "${refToken}" is not a valid PR reference.`,
			'',
			'Expected: full GitHub URL, owner/repo#N shorthand,',
			'or a bare PR number (resolved against origin).',
		].join('\n');
	}

	const repoFullName = `${prInfo.owner}/${prInfo.repo}`;
	const prUrl = `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`;

	try {
		const correlationId = buildCorrelationId(
			sessionID,
			repoFullName,
			prInfo.number,
		);
		const result = await unsubscribe(directory, correlationId);

		if (!result) {
			return [
				`Not subscribed to ${prUrl}`,
				`Session: ${sessionID}`,
				`PR: ${repoFullName}#${prInfo.number}`,
				'',
				'No active subscription found for this session and PR.',
				'Use /swarm pr subscribe to start monitoring.',
			].join('\n');
		}

		return [
			`Unsubscribed from ${prUrl}`,
			`Session: ${sessionID}`,
			`PR: ${repoFullName}#${prInfo.number}`,
			'',
			'The background PR monitor will no longer check this PR for',
			'the current session. Use /swarm pr subscribe to re-subscribe.',
		].join('\n');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [`Error: Failed to unsubscribe from ${prUrl}`, '', message].join(
			'\n',
		);
	}
}
