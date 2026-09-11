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
	'Usage: /swarm abort-pr-workflow [PR_REVIEW|PR_FEEDBACK] [reason...]',
	'       /swarm abort-pr-workflow PR_FEEDBACK --cancel-publication <reason...>',
	'',
	'Clear an active PR_REVIEW or PR_FEEDBACK mechanical gate for the current session',
	'and stop the auto-resume loop. The first form is the human-only FORCE escape hatch, usable',
	'even when the architect cannot call its audited recovery abort. Both paths may clear',
	'a BOUND gate after lanes settle; the force path does not require agent cooperation. Use when',
	'a PR review or feedback workflow is unrecoverably stuck (e.g. the working tree',
	'cannot reach the PR head, a compound shell command was rejected, or the wake',
	'budget is suspended).',
	'',
	'Arguments:',
	'  mode    Optional: PR_REVIEW or PR_FEEDBACK. If omitted, aborts whichever is active.',
	'  reason  Optional free-text reason recorded to the audit trail (.swarm/events.jsonl).',
	'          If omitted, a default ("user-initiated force abort ...") is recorded so the',
	'          gate always has a non-empty reason. The agent tool call must supply its own.',
	'  --cancel-publication  Explicitly cancel an armed PR_FEEDBACK publication without',
	'          publishing. It is valid only after PR_FEEDBACK and requires a non-empty reason.',
	'',
	'Refuses while the workflow is armed for publication (call complete_pr_workflow',
	'instead) or while PR workflow lanes are still in flight (collect their results first).',
	'',
	'Armed publication (issue #2108): to CHANGE approved content after arming, the agent',
	'should use the invalidate_pr_feedback_publication tool (audited invalidation; the',
	'full Stage A + independent-gate ladder re-runs). To CANCEL an armed PR_FEEDBACK',
	'workflow without publication, use the exact human form shown above. It records',
	'cancelled_without_publication (terminal; never grants push authority), reports the',
	'observed remote head, and then clears the gate. A plain (recovery or force) abort',
	'never clears an armed window.',
	'',
	'Lane liveness (issue #2251): a lane past the 30-minute staleness horizon whose',
	'session the host still reports as busy or retrying is RETAINED rather than settled,',
	'and keeps blocking every exit. Because nothing ever makes such a lane go idle on a',
	'schedule, this human-only force path is the override: when probe-retained lanes are',
	'the ONLY thing left blocking, it clears the gate anyway and discloses exactly which',
	'lanes it overrode. Those sessions are NOT stopped and their output is NOT collected.',
	'Their delegation records ARE finalized once the gate has actually cleared, so a new',
	'PR workflow can be started for the session — without that, checkout preparation would',
	'refuse forever. The warning names only the records it OBSERVED go terminal; a lane that',
	'had already moved on is named with its actual status and left intact, so check',
	'collect_lane_results before assuming that work is gone. If any delegation record for this',
	'session is still open afterwards, the warning names it too, instead of claiming the',
	'session is restartable.',
	'A lane with a fresh updatedAt is never overridden — force does not weaken that.',
].join('\n');

const KNOWN_MODES = new Set<string>(['PR_REVIEW', 'PR_FEEDBACK']);
const CANCEL_PUBLICATION_FLAG = '--cancel-publication';

export async function handleAbortPrWorkflowCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	const tokens = (args ?? []).filter((token) => token.trim().length > 0);
	const modeToken = tokens[0]?.toUpperCase();
	const knownMode =
		modeToken && KNOWN_MODES.has(modeToken) ? modeToken : undefined;
	const cancellationRequested = tokens.includes(CANCEL_PUBLICATION_FLAG);
	const reasonStartIndex = knownMode ? 1 : 0;

	if (modeToken && !knownMode) {
		return `Error: Unknown mode "${modeToken}". Expected PR_REVIEW or PR_FEEDBACK.\n\n${USAGE}`;
	}

	// Keep the human syntax deliberately explicit. A cancellation is a
	// publication-specific escape hatch, never an alternate spelling for the
	// ordinary force abort, and the reason must remain a separate argument.
	if (
		cancellationRequested &&
		(knownMode !== 'PR_FEEDBACK' || tokens[1] !== CANCEL_PUBLICATION_FLAG)
	) {
		return `Error: ${CANCEL_PUBLICATION_FLAG} requires the exact form PR_FEEDBACK ${CANCEL_PUBLICATION_FLAG} <reason...>. It is not valid for PR_REVIEW or an unqualified force abort.\n\n${USAGE}`;
	}

	const explicitReason = tokens
		.slice(cancellationRequested ? 2 : reasonStartIndex)
		.join(' ')
		.trim()
		.slice(0, 500);

	if (cancellationRequested && !explicitReason) {
		return `Error: cancel_publication requires a non-empty reason; use PR_FEEDBACK ${CANCEL_PUBLICATION_FLAG} <reason...>.\n\n${USAGE}`;
	}

	if (!sessionID?.trim()) {
		return `Error: abort-pr-workflow requires an active sessionID.\n\n${USAGE}`;
	}

	// The gate requires a non-empty reason for the audit trail (issue #2131
	// finding 1a). The human-only force command supplies a default when the user
	// runs it with no explicit reason so the escape hatch stays usable, while the
	// agent's tool call must supply its own (enforced by abortPrWorkflow).
	const reason = cancellationRequested
		? explicitReason
		: explicitReason ||
			'user-initiated force abort via /swarm abort-pr-workflow (no explicit reason provided)';

	try {
		const summary = await abortPrWorkflow(directory, sessionID, {
			kind: cancellationRequested ? 'cancel-publication' : 'force',
			reason,
			...(cancellationRequested
				? { cancelPublication: true, expectedMode: 'PR_FEEDBACK' as const }
				: knownMode
					? { expectedMode: knownMode as PrWorkflowMode }
					: {}),
		});
		if (cancellationRequested) {
			const observedRemoteHead = summary.observedRemoteHead ?? '(unavailable)';
			return `Cancelled active ${summary.mode} publication without publication (cancelled_without_publication) for session ${sessionID}. Observed remote head: ${observedRemoteHead}. The durable gate state has been cleared and the auto-resume loop will stop. An audit event was appended to .swarm/events.jsonl.`;
		}
		const headLine = summary.prHeadSha
			? ` (was bound to PR head ${summary.prHeadSha})`
			: ' (was not bound to a PR head)';
		// The override disclosure is the whole point of the S3 escape hatch: the
		// human is being told that live lanes were abandoned, not settled.
		const overrideLine = summary.probeRetentionOverrideDisclosure
			? ` WARNING: ${summary.probeRetentionOverrideDisclosure}`
			: '';
		return `Aborted active ${summary.mode} mechanical gate for session ${sessionID}${headLine} (force). The durable gate state has been cleared and the auto-resume loop will stop. An audit event was appended to .swarm/events.jsonl. If checkout preparation preserved changes, continue with prepare_pr_workflow_checkout operation=restore (or follow the preserved receipt manually).${overrideLine}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Error: ${message}\n\n${USAGE}`;
	}
}
