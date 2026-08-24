/**
 * Gate 1 – Completion Verify (deterministic, in-process).
 * Blocks when executeCompletionVerify returns status === 'blocked'.
 */

import { executeCompletionVerify } from '../../completion-verify';
import type { GateContext, GateResult } from './types';

export async function runCompletionVerifyGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, agentsDispatched } = ctx;

	try {
		const completionResultRaw = await executeCompletionVerify(
			{ phase, writeEvidence: false },
			dir,
		);
		const completionResult = JSON.parse(completionResultRaw);

		if (completionResult.status === 'blocked') {
			return {
				blocked: true,
				reason: 'COMPLETION_INCOMPLETE',
				message: `Phase ${phase} cannot be completed: ${completionResult.reason}`,
				agentsDispatched,
				agentsMissing: [],
				warnings: completionResult.blockedTasks
					? [
							`Blocked tasks: ${completionResult.blockedTasks.map((t: { task_id: string }) => t.task_id).join(', ')}`,
						]
					: [],
			};
		}

		return {
			blocked: false,
			agentsDispatched,
			agentsMissing: [],
			warnings: [],
		};
	} catch (completionError) {
		// Fail-closed: completion verify errors block phase completion (issue #2099 recurrence)
		return {
			blocked: true,
			reason: 'COMPLETION_VERIFY_ERROR',
			message: `Phase ${phase} cannot be completed: completion verify gate encountered an error. Error: ${String(completionError)}`,
			agentsDispatched,
			agentsMissing: [],
			warnings: [`COMPLETION_VERIFY_ERROR: ${String(completionError)}`],
		};
	}
}
