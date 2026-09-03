import { loadPlanJsonOnly } from '../plan/manager.js';
import {
	TASK_ID_RESOLUTION_LIMITS,
	type TaskIdPlanContextOptions,
} from './task-id-resolver.js';

export type PlanTaskIdContext =
	| { status: 'available'; taskIds: ReadonlySet<string> }
	| { status: 'unavailable' }
	| { status: 'over_limit' };

/** Traverse plan phases without first materializing an unbounded flat task list. */
export function collectPlanTaskIdContextFromPhases(
	phases: ReadonlyArray<
		| {
				tasks?: ReadonlyArray<{ id?: string } | null> | null;
		  }
		| null
		| undefined
	>,
): PlanTaskIdContext {
	const collected = new Set<string>();
	for (const phase of phases) {
		for (const task of phase?.tasks ?? []) {
			if (!task || typeof task.id !== 'string') continue;
			collected.add(task.id);
			if (collected.size > TASK_ID_RESOLUTION_LIMITS.maxKnownIds) {
				return { status: 'over_limit' };
			}
		}
	}
	return { status: 'available', taskIds: collected };
}

/**
 * Best-effort caller-side plan context for the pure task-ID resolver.
 * Missing/corrupt plans remain distinguishable from valid plans whose task-ID
 * cardinality exceeds the resolver bound. Callers must preserve that distinction
 * so numeric IDs never become unfiltered when a plan is merely too large.
 */
export async function loadPlanTaskIdContext(
	directory: string,
): Promise<PlanTaskIdContext> {
	try {
		const plan = await loadPlanJsonOnly(directory);
		if (!plan) return { status: 'unavailable' };
		return collectPlanTaskIdContextFromPhases(plan.phases);
	} catch {
		return { status: 'unavailable' };
	}
}

/** Convert a typed loader result into the resolver's bounded plan context. */
export function toTaskIdPlanContextOptions(
	context: PlanTaskIdContext,
): TaskIdPlanContextOptions {
	if (context.status === 'available') {
		return { knownPlanTaskIds: context.taskIds };
	}
	if (context.status === 'over_limit') {
		return { planContextOverLimit: true };
	}
	return {};
}
