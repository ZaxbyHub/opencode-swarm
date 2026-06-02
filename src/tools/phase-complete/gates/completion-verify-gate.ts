/**
 * Gate 1 – Completion Verify (deterministic, in-process).
 * Blocks when executeCompletionVerify returns status === 'blocked'.
 */

import { executeCompletionVerify } from '../../completion-verify';
import type { GateContext, GateResult } from './types';

export async function runCompletionVerifyGate(
	ctx: GateContext,
): Promise<GateResult> {
	const { phase, dir, agentsDispatched, safeWarn } = ctx;

	try {
		const completionResultRaw = await executeCompletionVerify({ phase }, dir);
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
		// Non-blocking — treat as warning and continue
		safeWarn(
			`[phase_complete] Completion verify error (non-blocking):`,
			completionError,
		);
		return {
			blocked: false,
			agentsDispatched,
			agentsMissing: [],
			warnings: [],
		};
	}
}
