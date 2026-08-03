/**
 * Handle /swarm approve-plan-critic command.
 *
 * Human-only escape hatch for the ratchet-tighter `critic_pre_plan` execution
 * gate (issue #2012). When the critic returns APPROVED but the mechanical
 * snapshot recorder fails to persist it (verdict-format mismatch, dispatch-
 * signal miss, or a plan.json read race), the gate permanently blocks ALL
 * coder delegations because `critic_pre_plan` defaults to `true` and cannot be
 * disabled. This records a manual `plan_critic_gate` approval snapshot so the
 * gate unblocks, with a distinct `method: 'manual_override'` audit marker.
 *
 * The command is `toolPolicy: 'restricted'` — the agent cannot run it via
 * `swarm_command`; the agent must instead call the `approve_plan_critic` tool
 * (or ask the user to run this command). Both paths funnel into
 * `forceRecordPlanCriticApproval`. The command path sets `user_confirmed: true`
 * (human-initiated); the tool path sets `user_confirmed: false`
 * (agent-initiated) so a self-approve is visible in the audit trail.
 *
 * Mirrors the PR_REVIEW #1898 escape-hatch pattern (`/swarm abort-pr-workflow`).
 */

import { forceRecordPlanCriticApproval } from '../hooks/delegation-gate.js';

const USAGE = [
	'Usage: /swarm approve-plan-critic [reason...]',
	'',
	'Record a MANUAL plan-critic approval to unblock the critic_pre_plan execution gate.',
	'Use ONLY when the critic already returned APPROVED but the mechanical snapshot',
	'recorder failed to persist it (verdict-format mismatch, dispatch-signal miss, or',
	'a plan.json read race). The snapshot is tagged method: "manual_override" and an',
	'audit event is appended to .swarm/events.jsonl.',
	'',
	'Arguments:',
	'  reason  Required free-text reason (recorded to .swarm/events.jsonl).',
	'',
	'Requires an active architect session. Prefer re-running MODE: CRITIC-GATE first;',
	'use this only as an escape hatch when a legitimate APPROVED was lost.',
].join('\n');

export async function handleApprovePlanCriticCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	const reason = (args ?? []).join(' ').trim().slice(0, 500);

	if (!reason) {
		return `Error: a reason is required.\n\n${USAGE}`;
	}

	if (!sessionID?.trim()) {
		return `Error: approve-plan-critic requires an active sessionID.\n\n${USAGE}`;
	}

	try {
		// Human-initiated: user_confirmed: true distinguishes this from the
		// agent-initiated approve_plan_critic tool path (user_confirmed: false).
		const summary = await forceRecordPlanCriticApproval(directory, sessionID, {
			reason,
			userConfirmed: true,
		});
		return (
			`Recorded a manual plan_critic_gate approval for plan_id=${summary.planId} ` +
			`at ${summary.recordedAt}. The critic_pre_plan execution gate will now ` +
			`allow coder delegation. An audit event was appended to .swarm/events.jsonl ` +
			`(user_confirmed: true, reason: ${summary.reason ?? reason}).`
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Error: ${message}\n\n${USAGE}`;
	}
}
