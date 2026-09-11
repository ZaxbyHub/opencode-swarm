import { z } from 'zod';
import { forceRecordRetrySoundingBoardApproval } from '../hooks/delegation-gate.js';
import { createSwarmTool } from './create-tool.js';

const ApproveRetrySoundingBoardArgsSchema = z
	.object({
		task_id: z
			.string()
			.trim()
			.min(1)
			.describe(
				'Exact plan task id of the wedged task (e.g. "2.1"). Must exist in the current plan and already have a durable sounding_board_consultation escalation.',
			),
		reason: z
			.string()
			.trim()
			.min(1)
			.max(500)
			.describe(
				'Why a manual approval is being recorded (e.g. "sounding board returned APPROVED but the verdict format did not match the mechanical recorder"). Audited to .swarm/events.jsonl.',
			),
	})
	.strict();

export async function executeApproveRetrySoundingBoard(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = ApproveRetrySoundingBoardArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid approve_retry_sounding_board call: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'approve_retry_sounding_board requires an active sessionID',
		});
	}
	try {
		// Agent-initiated path: the audit event's action value
		// (sounding_board_manual_approval) is the trail that distinguishes this
		// from a mechanical recording. The evidence write itself is the same
		// gate_recorded transition the toolAfter recorder performs.
		const summary = await forceRecordRetrySoundingBoardApproval(
			directory,
			context.sessionID,
			{
				taskId: parsed.data.task_id,
				reason: parsed.data.reason,
			},
		);
		return JSON.stringify({
			success: true,
			task_id: summary.taskId,
			generation: summary.generation,
			retry_epoch: summary.retryEpoch,
			recorded_at: summary.recordedAt,
			method: 'manual_override',
			user_confirmed: false,
			message:
				'Recorded a manual critic_sounding_board gate entry for the coder retry ' +
				'circuit breaker. The next coder dispatch for this task passes the ' +
				'TASK_RETRY_CRITIC_REQUIRED critic check (one bounded simplified retry). ' +
				'An audit event (action sounding_board_manual_approval) was appended to ' +
				'.swarm/events.jsonl.',
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const approve_retry_sounding_board: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record a MANUAL critic_sounding_board gate entry to unblock the coder retry circuit-breaker gate (TASK_RETRY_CRITIC_REQUIRED) when the sounding board already returned APPROVED but the mechanical recorder failed to persist it — verdict-format miss (the sounding board echoed its enumerated RESPONSE FORMAT line), dispatch-task attribution miss, launch-generation binding miss, or a failed/error output state (issue #2703). Scoped to the exact plan task id, which must already carry a durable sounding_board_consultation escalation for the current retry epoch; the audit event (action sounding_board_manual_approval) distinguishes the override from a mechanical recording. Architect-only: the active session must be the architect. Prefer re-dispatching the sounding board first; use this only as an escape hatch when a legitimate APPROVED verdict was lost. A reason is required and audited to .swarm/events.jsonl.',
		args: {
			task_id: ApproveRetrySoundingBoardArgsSchema.shape.task_id,
			reason: ApproveRetrySoundingBoardArgsSchema.shape.reason,
		},
		execute: executeApproveRetrySoundingBoard,
	});
