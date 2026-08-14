/**
 * Handle /swarm abort-pr-workflow command.
 *
 * Human-only escape hatch for an unrecoverable PR_REVIEW / PR_FEEDBACK
 * mechanical gate. When the architect cannot reach `complete_pr_workflow`
 * (compound `git fetch && git checkout` rejected as read-only shell syntax,
 * missing PR ref, model confusion, suspended wake budget, …), the user runs
 * this to clear the durable gate and stop the auto-resume loop without
 * depending on the trapped model.
 *
 * The command is `toolPolicy: 'restricted'` — the agent cannot run it via
 * `swarm_command`; the agent must instead call the `abort_pr_workflow` tool
 * (or ask the user to run this command). Both paths funnel into
 * `abortPrWorkflow`, which is fail-closed on armed publication and on
 * in-flight lanes.
 */

import {
	abortPrWorkflow,
	type PrWorkflowMode,
} from '../hooks/pr-workflow-gate.js';

const USAGE = [
	'Usage: /swarm abort-pr-workflow [PR_REVIEW|PR_FEEDBACK] <reason...>',
	'',
	'Clear an active PR_REVIEW or PR_FEEDBACK mechanical gate for the current session',
	'and stop the auto-resume loop. This is the human-only FORCE escape hatch: it may',
	'clear a BOUND gate (one whose PR head was successfully checked out) without a',
	"recovery condition, which the agent's own recovery abort is refused for. Use when",
	'a PR review or feedback workflow is unrecoverably stuck (e.g. the working tree',
	'cannot reach the PR head, a compound shell command was rejected, or the wake',
	'budget is suspended).',
	'',
	'Arguments:',
	'  mode    Optional: PR_REVIEW or PR_FEEDBACK. If omitted, aborts whichever is active.',
	'  reason  Optional free-text reason recorded to the audit trail (.swarm/events.jsonl).',
	'          If omitted, a default ("user-initiated force abort ...") is recorded so the',
	'          gate always has a non-empty reason. The agent tool call must supply its own.',
	'',
	'Refuses while the workflow is armed for publication (call complete_pr_workflow',
	'instead) or while PR workflow lanes are still in flight (collect their results first).',
].join('\n');

const KNOWN_MODES = new Set<string>(['PR_REVIEW', 'PR_FEEDBACK']);

export async function handleAbortPrWorkflowCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	const tokens = (args ?? []).filter((token) => token.trim().length > 0);
	const modeToken = tokens[0]?.toUpperCase();
	const knownMode =
		modeToken && KNOWN_MODES.has(modeToken) ? modeToken : undefined;
	const reasonStartIndex = knownMode ? 1 : 0;
	const explicitReason = tokens
		.slice(reasonStartIndex)
		.join(' ')
		.trim()
		.slice(0, 500);

	if (modeToken && !knownMode) {
		return `Error: Unknown mode "${modeToken}". Expected PR_REVIEW or PR_FEEDBACK.\n\n${USAGE}`;
	}

	if (!sessionID?.trim()) {
		return `Error: abort-pr-workflow requires an active sessionID.\n\n${USAGE}`;
	}

	// The gate requires a non-empty reason for the audit trail (issue #2131
	// finding 1a). The human-only force command supplies a default when the user
	// runs it with no explicit reason so the escape hatch stays usable, while the
	// agent's tool call must supply its own (enforced by abortPrWorkflow).
	const reason =
		explicitReason ||
		'user-initiated force abort via /swarm abort-pr-workflow (no explicit reason provided)';

	try {
		const summary = await abortPrWorkflow(directory, sessionID, {
			kind: 'force',
			reason,
			...(knownMode ? { expectedMode: knownMode as PrWorkflowMode } : {}),
		});
		const headLine = summary.prHeadSha
			? ` (was bound to PR head ${summary.prHeadSha})`
			: ' (was not bound to a PR head)';
		return `Aborted active ${summary.mode} mechanical gate for session ${sessionID}${headLine} (force). The durable gate state has been cleared and the auto-resume loop will stop. An audit event was appended to .swarm/events.jsonl.`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Error: ${message}\n\n${USAGE}`;
	}
}
