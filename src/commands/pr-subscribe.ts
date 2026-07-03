/**
 * Handle /swarm pr subscribe command.
 *
 * Subscribes the current session to PR state-change notifications. When
 * `pr_monitor.enabled` is true, the background polling worker will detect CI
 * failures, new comments, merge conflicts (and resolutions), review state
 * changes, and merge/close events — each gated by its `notify_*` config flag.
 * Events are delivered per `pr_monitor.event_delivery`: 'prompt' (default)
 * wakes the subscribed session with a structured <pr-activity> message;
 * 'advisory' queues session-scoped advisories with dedup tokens.
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
			'Subscribes the current session to PR state-change events',
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

	// PR monitoring is session-scoped: the subscription is keyed by the active
	// session id. Without a live session (e.g. the `bunx opencode-swarm run`
	// CLI, which has no session context) there is nothing to scope the
	// subscription to. Fail clearly here instead of letting the store-layer
	// `sessionID is required` throw surface as an opaque "Failed to subscribe"
	// error, and never imply success (issue #1484).
	if (!sessionID || sessionID.trim() === '') {
		return [
			'Error: Cannot subscribe — no active session.',
			'',
			'PR subscriptions are session-scoped and require a live OpenCode session.',
			'Subscribe from inside OpenCode; the bunx CLI has no session context.',
		].join('\n');
	}

	const repoFullName = `${prInfo.owner}/${prInfo.repo}`;
	const prUrl = `https://github.com/${prInfo.owner}/${prInfo.repo}/pull/${prInfo.number}`;

	try {
		const config = _internals.loadPluginConfig(directory);
		const prMonitorConfig = config.pr_monitor;

		if (!prMonitorConfig?.enabled) {
			return [
				'Error: PR Monitor is not enabled.',
				'',
				'Set `pr_monitor.enabled: true` in your opencode config to enable.',
			].join('\n');
		}

		await _internals.subscribe(directory, {
			sessionID,
			prNumber: prInfo.number,
			repoFullName,
			prUrl,
			maxSubscriptions: prMonitorConfig?.max_subscriptions,
		});

		const deliveryMode =
			prMonitorConfig?.event_delivery === 'advisory' ? 'advisory' : 'prompt';
		const deliveryLine =
			deliveryMode === 'prompt'
				? 'Delivery mode: prompt — events wake this session with a <pr-activity> message.'
				: 'Delivery mode: advisory — events queue as session advisories for the next turn.';

		return [
			`Subscribed to ${prUrl}`,
			`Session: ${sessionID}`,
			`PR: ${repoFullName}#${prInfo.number}`,
			'',
			'The background PR monitor will now watch this PR and deliver',
			'the events enabled by your pr_monitor config: CI failures, new',
			'comments, review activity (changes requested / approved), merge',
			'conflicts and resolutions, merge/close, and (off by default)',
			'CI success. Each event type is gated by its notify_* flag.',
			deliveryLine,
		].join('\n');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return [`Error: Failed to subscribe to ${prUrl}`, '', message].join('\n');
	}
}

// ── DI Seam for Testability ─────────────────────────────────────────

export const _internals = {
	loadPluginConfig,
	subscribe,
};
