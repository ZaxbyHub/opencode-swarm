/**
 * Handle /swarm pr subscribe command.
 *
 * Subscribes the current session to PR state-change notifications. When
 * `pr_monitor.enabled` is true, the background polling worker will detect CI
 * failures, new comments, merge conflicts, review state changes, and
 * merge/close events. Notifications are delivered as session-scoped advisories
 * with dedup tokens.
 *
 * Input contract (PR reference is required):
 *   /swarm pr subscribe 155                         → subscribe via bare number
 *   /swarm pr subscribe owner/repo#155               → shorthand
 *   /swarm pr subscribe https://github.com/.../pull/155
 *   /swarm pr subscribe                              → usage (no bare invocation)
 *
 * PR-reference parsing is shared with /swarm pr-review and /swarm pr-feedback
 * via ./pr-ref.ts.
 */

import { subscribe } from '../background/pr-subscriptions.js';
import { loadPluginConfig } from '../config/loader.js';
import { looksLikePrRef, parsePrRef } from './pr-ref.js';

/**
 * Subscribe the current session to PR monitoring notifications.
 *
 * Requires a PR reference argument (no bare invocation). The subscription is
 * idempotent — if an active subscription with the same composite key
 * (`sessionID::repoFullName::prNumber`) already exists, the existing record
 * is returned without duplication.
 */
export async function handlePrSubscribeCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	const rest = args.filter((t) => t.trim().length > 0);

	// PR reference is required — no bare invocation.
	if (rest.length === 0) {
		return [
			'Usage: /swarm pr subscribe <pr-url|owner/repo#N|N>',
			'',
			'Subscribes the current session to receive advisory notifications',
			'for the specified PR. Requires pr_monitor.enabled: true in config.',
			'',
			'  /swarm pr subscribe https://github.com/owner/repo/pull/42',
			'  /swarm pr subscribe owner/repo#42',
			'  /swarm pr subscribe 42',
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
		const config = _internals.loadPluginConfig(directory);
		const prMonitorConfig = config.pr_monitor;

		await subscribe(directory, {
			sessionID,
			prNumber: prInfo.number,
			repoFullName,
			prUrl,
			maxSubscriptions: prMonitorConfig?.max_subscriptions,
		});

		return [
			`Subscribed to ${prUrl}`,
			`Session: ${sessionID}`,
			`PR: ${repoFullName}#${prInfo.number}`,
			'',
			'The background PR monitor will now check this PR for',
			'CI failures, new comments, review state changes, and',
			'merge/close events. Notifications appear as session-scoped',
			'advisories with dedup tokens.',
		].join('\n');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [`Error: Failed to subscribe to ${prUrl}`, '', message].join('\n');
	}
}

// ── DI Seam for Testability ─────────────────────────────────────────

export const _internals = {
	loadPluginConfig,
};
