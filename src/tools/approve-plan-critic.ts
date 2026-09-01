import { z } from 'zod';
import { forceRecordPlanCriticApproval } from '../hooks/delegation-gate.js';
import { createSwarmTool } from './create-tool.js';

const ApprovePlanCriticArgsSchema = z
	.object({
		reason: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.describe(
				'Why a manual approval is being recorded (e.g. "critic returned APPROVED but the verdict format did not match the mechanical recorder"). Audited to .swarm/events.jsonl.',
			),
	})
	.strict();

export async function executeApprovePlanCritic(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = ApprovePlanCriticArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid approve_plan_critic call: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'approve_plan_critic requires an active sessionID',
		});
	}
	try {
		// user_confirmed is deliberately `false` on the tool path (agent-initiated).
		// The human-confirmed path is `/swarm approve-plan-critic`, which sets it
		// to `true`. Both record the same snapshot; the flag is the audit trail
		// that distinguishes a user-driven override from an agent self-approve.
		const summary = await forceRecordPlanCriticApproval(
			directory,
			context.sessionID,
			{
				reason: parsed.data.reason,
				userConfirmed: false,
			},
		);
		return JSON.stringify({
			success: true,
			plan_id: summary.planId,
			recorded_at: summary.recordedAt,
			method: 'manual_override',
			user_confirmed: false,
			message:
				'Recorded a manual plan_critic_gate approval snapshot. The critic_pre_plan ' +
				'execution gate will now allow coder delegation. An audit event was appended ' +
				'to .swarm/events.jsonl.',
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const approve_plan_critic: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record a MANUAL plan_critic_gate approval snapshot to unblock the ratchet-tighter critic_pre_plan execution gate when the critic already returned APPROVED but the mechanical snapshot recorder failed to persist it (verdict-format mismatch, dispatch-signal miss, or a plan.json read race — issue #2012). The snapshot carries a distinct method: "manual_override" audit marker. Architect-only: the active session must be the architect. Prefer re-running MODE: CRITIC-GATE first; use this only as an escape hatch when a legitimate APPROVED was lost, or as the sanctioned recovery for a bookkeeping-grade hashed-field repair under the critic-gate PLAN FREEZE rule (e.g. a files_touched-only scope reconciliation) — the reason must state which case applies. A reason is required and audited to .swarm/events.jsonl. The human-confirmed variant is /swarm approve-plan-critic.',
		args: {
			reason: ApprovePlanCriticArgsSchema.shape.reason,
		},
		execute: executeApprovePlanCritic,
	});
