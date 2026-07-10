/**
 * Handle /swarm pr status command.
 *
 * Displays all active PR monitoring subscriptions for the current session.
 * Shows PR URL, repo#number, last checked time (relative), watching status,
 * and error count per subscription. Also reports the total number of active
 * subscriptions across all sessions.
 *
 * Input contract (no args):
 *   /swarm pr status                              → show session subscriptions
 */

import { listActive } from '../background/pr-subscriptions.js';
import { runExternalTool } from '../utils/external-tool-runner.js';

const GH_RUN_LIST_TIMEOUT_MS = 10_000;
const GH_RUN_LIST_MAX_BYTES = 20_000;

type MergeGroupRun = {
	databaseId: number;
	headBranch: string;
	status: string;
	conclusion: string | null;
	url: string;
	displayTitle?: string;
	name?: string;
};

/**
 * Format an epoch-ms timestamp as a human-friendly relative time string.
 *
 * Returns "just now" for timestamps within the last 5 seconds, otherwise
 * uses the largest whole unit (seconds, minutes, hours, or days).
 */
function formatRelativeTime(epochMs: number): string {
	const diffMs = Date.now() - epochMs;
	if (diffMs < 0) return 'just now';
	if (diffMs < 5000) return 'just now';

	const diffSeconds = Math.floor(diffMs / 1000);
	if (diffSeconds < 60) return `${diffSeconds} seconds ago`;

	const diffMinutes = Math.floor(diffSeconds / 60);
	if (diffMinutes < 60)
		return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;

	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24)
		return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;

	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseMergeGroupRuns(raw: string, prNumber: number): MergeGroupRun[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const prToken = `pr-${prNumber}-`;
	const issueToken = `#${prNumber}`;
	const runs: MergeGroupRun[] = [];
	for (const item of parsed) {
		if (!isObject(item)) continue;
		const databaseId = Number(item.databaseId);
		const headBranch = String(item.headBranch ?? '');
		const displayTitle = String(item.displayTitle ?? '');
		const name = String(item.name ?? '');
		if (
			!headBranch.includes(prToken) &&
			!displayTitle.includes(issueToken) &&
			!name.includes(issueToken)
		) {
			continue;
		}
		if (!Number.isFinite(databaseId) || databaseId <= 0) continue;
		runs.push({
			databaseId,
			headBranch,
			status: String(item.status ?? ''),
			conclusion: typeof item.conclusion === 'string' ? item.conclusion : null,
			url: String(item.url ?? ''),
			displayTitle,
			name,
		});
	}
	return runs.slice(0, 3);
}

async function listMergeGroupRuns(
	directory: string,
	repoFullName: string,
	prNumber: number,
): Promise<{ runs: MergeGroupRun[]; error?: string }> {
	const result = await runExternalTool({
		executable: 'gh',
		args: [
			'run',
			'list',
			'--repo',
			repoFullName,
			'--event',
			'merge_group',
			'--limit',
			'20',
			'--json',
			'databaseId,headBranch,conclusion,status,url,displayTitle,name',
		],
		cwd: directory,
		timeoutMs: GH_RUN_LIST_TIMEOUT_MS,
		maxStdoutBytes: GH_RUN_LIST_MAX_BYTES,
		maxStderrBytes: GH_RUN_LIST_MAX_BYTES,
	});
	if (result.status !== 'completed' || result.exitCode !== 0) {
		return {
			runs: [],
			error: result.stderr.trim() || result.message || result.status,
		};
	}
	return { runs: parseMergeGroupRuns(result.stdout, prNumber) };
}

/**
 * Format merge-group run status for display.
 *
 * Shows the run status (queued/in_progress/completed), conclusion if available,
 * and a link reference.
 */
function formatMergeGroupStatus(
	status?: string,
	conclusion?: string,
	htmlUrl?: string,
): string {
	if (!status) return 'Merge group: unknown';
	const parts: string[] = [`Merge group: ${status}`];
	if (conclusion) {
		parts.push(conclusion);
	}
	if (htmlUrl) {
		parts.push(`(${htmlUrl})`);
	}
	return parts.join(' ');
}

/**
 * Exposed for unit testing via _internals.
 */
export const _internals = {
	formatRelativeTime,
	formatMergeGroupStatus,
	listActive,
	listMergeGroupRuns,
	parseMergeGroupRuns,
};

/**
 * Show PR monitor subscription status for the current session.
 *
 * Lists all active subscriptions filtered to the current sessionID,
 * formatted as a numbered table with PR URL, relative last-checked
 * time, watching status, and error count. Appends a cross-session
 * total at the end.
 */
export async function handlePrMonitorStatusCommand(
	directory: string,
	_args: string[],
	sessionID: string,
	source?: 'cli' | 'chat',
): Promise<string> {
	const allActive = await _internals.listActive(directory);

	// Subscriptions are session-scoped, but the `bunx opencode-swarm run pr
	// status` CLI path has no session context (it passes sessionID ''), so a
	// session-equality filter there always yields zero rows and falsely reports
	// "no subscriptions" even when subscriptions exist (issue #1484). For the
	// human CLI ONLY, list every active subscription across sessions so the CLI
	// is a usable verifier. Every other caller — TUI, chat, and the agent-facing
	// `swarm_command` tool (source 'chat') — stays session-scoped, so an agent
	// can never be handed a cross-session dump even if its sessionID is empty.
	const allSessions = source === 'cli';
	const subs = allSessions
		? allActive
		: allActive.filter((record) => record.sessionID === sessionID);

	if (subs.length === 0) {
		return allSessions
			? 'No active PR subscriptions.'
			: 'No active PR subscriptions for this session.';
	}

	const lines: string[] = [];
	lines.push(
		allSessions
			? 'PR Monitor Status — all sessions'
			: `PR Monitor Status — Session: ${sessionID}`,
	);
	lines.push('');

	const totalActive = allActive.length;
	lines.push(`Active subscriptions (${subs.length}):`);

	for (let i = 0; i < subs.length; i++) {
		const sub = subs[i];
		const index = i + 1;
		lines.push(`  ${index}. ${sub.repoFullName}#${sub.prNumber}`);
		lines.push(`     URL: ${sub.prUrl}`);
		const mergeGroupRuns = await _internals.listMergeGroupRuns(
			directory,
			sub.repoFullName,
			sub.prNumber,
		);
		if (mergeGroupRuns.runs.length > 0) {
			lines.push('     Merge-group runs:');
			for (const run of mergeGroupRuns.runs) {
				const conclusion = run.conclusion ?? run.status;
				lines.push(`       - ${run.databaseId}: ${conclusion} ${run.url}`);
				if (run.conclusion && run.conclusion !== 'success') {
					lines.push(
						`         Failed logs: gh run view ${run.databaseId} --repo ${sub.repoFullName} --log-failed`,
					);
				}
			}
		} else if (mergeGroupRuns.error) {
			lines.push(
				`     Merge-group runs: unavailable (${mergeGroupRuns.error})`,
			);
		} else {
			lines.push('     Merge-group runs: none found in recent runs');
		}
		lines.push(
			`     Merge-group checks: gh pr checks ${sub.prNumber} --repo ${sub.repoFullName}`,
		);
		lines.push(
			`     Failed logs: gh run view <run-id> --repo ${sub.repoFullName} --log-failed`,
		);
		// Disambiguate ownership only in the cross-session (CLI) listing.
		if (allSessions) {
			lines.push(`     Session: ${sub.sessionID}`);
		}
		lines.push(`     Last checked: ${formatRelativeTime(sub.lastCheckedAt)}`);
		lines.push(`     Watching: ${sub.isWatching ? 'yes' : 'no'}`);
		lines.push(
			`     ${formatMergeGroupStatus(
				sub.mergeGroupRunStatus,
				sub.mergeGroupRunConclusion,
				sub.mergeGroupRunHtmlUrl,
			)}`,
		);
		lines.push(`     Errors: ${sub.errorCount}`);
		if (i < subs.length - 1) {
			lines.push('');
		}
	}

	lines.push('');
	if (!allSessions && totalActive !== subs.length) {
		lines.push(`Total active across all sessions: ${totalActive}`);
	}

	return lines.join('\n');
}
