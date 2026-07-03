/**
 * PR auto-subscribe hook (tool.execute.after).
 *
 * When `pr_monitor.enabled` and `pr_monitor.auto_subscribe_on_pr_create`
 * are set, a successful `gh pr create` run through the bash tool
 * automatically subscribes the current session to the created PR — closing
 * the commit-pr → swarm-pr-review → swarm-pr-feedback → swarm-pr-subscribe
 * lifecycle without a manual `/swarm pr subscribe` step.
 *
 * Detection: the bash command must contain `gh pr create` and the tool
 * output must contain a GitHub PR URL. Only the first URL in a bounded
 * slice of the output is used. The subscribe call is idempotent (keyed by
 * session::repo::number) and lazy-starts the PR monitor worker via the
 * store's onSubscriptionCreated callback.
 *
 * Fail-open: never throws, never blocks the hook chain, no subprocesses.
 */

import { subscribe } from '../background/pr-subscriptions.js';
import type { PrMonitorConfig } from '../config/schema.js';
import { log } from '../utils';
import { normalizeToolNameLowerCase } from './normalize-tool-name';

/** Only scan a bounded slice of tool output (defense against huge outputs). */
const MAX_OUTPUT_SCAN_BYTES = 64 * 1024;

/** First GitHub PR URL in the output. */
const PR_URL_PATTERN =
	/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/;

export interface PrAutoSubscribeHook {
	toolAfter: (
		input: { tool: string; sessionID?: string; args?: unknown },
		output: { output?: unknown; args?: unknown },
	) => Promise<void>;
}

/** DI seam for testability. */
export const _internals: {
	subscribe: typeof subscribe;
	log: typeof log;
} = {
	subscribe,
	log,
};

/**
 * Extract `{ repoFullName, prNumber, prUrl }` from the first GitHub PR URL
 * in the given text, or null when none is present. The returned prUrl is
 * re-canonicalized from the captures so it always satisfies the
 * subscription store's strict URL schema.
 */
export function extractPrUrl(
	text: string,
): { repoFullName: string; prNumber: number; prUrl: string } | null {
	const match = PR_URL_PATTERN.exec(text.slice(0, MAX_OUTPUT_SCAN_BYTES));
	if (!match) return null;
	const owner = match[1];
	const repo = match[2];
	const prNumber = Number.parseInt(match[3], 10);
	if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
	return {
		repoFullName: `${owner}/${repo}`,
		prNumber,
		prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
	};
}

/**
 * Create the auto-subscribe hook. Cheap to construct (no I/O); all gating
 * happens inside toolAfter.
 */
export function createPrAutoSubscribeHook(
	directory: string,
	config: PrMonitorConfig,
): PrAutoSubscribeHook {
	return {
		toolAfter: async (input, output): Promise<void> => {
			try {
				if (!config.enabled || !config.auto_subscribe_on_pr_create) return;

				const sessionID =
					typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
				if (!sessionID) return;

				const tool = normalizeToolNameLowerCase(input.tool ?? '');
				if (tool !== 'bash' && tool !== 'shell') return;

				const args = (input.args ?? output.args) as
					| Record<string, unknown>
					| undefined;
				const command = typeof args?.command === 'string' ? args.command : '';
				if (!command.includes('gh pr create')) return;

				const outputText =
					typeof output.output === 'string' ? output.output : '';
				if (!outputText) return;

				const prInfo = extractPrUrl(outputText);
				if (!prInfo) return;

				await _internals.subscribe(directory, {
					sessionID,
					prNumber: prInfo.prNumber,
					repoFullName: prInfo.repoFullName,
					prUrl: prInfo.prUrl,
					maxSubscriptions: config.max_subscriptions,
				});
				_internals.log('[pr-monitor] Auto-subscribed session to created PR', {
					sessionID,
					pr: `${prInfo.repoFullName}#${prInfo.prNumber}`,
				});
			} catch (err) {
				// Fail-open — auto-subscribe must never block the hook chain.
				_internals.log('[pr-monitor] Auto-subscribe failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}
