/**
 * `plan_conflict_check` tool (#1656 — v8 parallel-first execution prerequisite).
 *
 * Read-only advisory: compute a pairwise file-conflict matrix for N proposed
 * parallel task groups using declared scopes (and optional git co-change),
 * returning a verdict and suggested serialization order.
 *
 * READ-ONLY CONTRACT (issue #1656 acceptance): this tool writes NOTHING — not
 * to `.swarm/`, not to the source tree. It calls no other tools. The only I/O
 * is reading `.swarm/plan.json` (via `loadPlanJsonOnly`) and
 * `.swarm/scopes/scope-<taskId>.json` (via `readTaskScopes` inside
 * `computeParallelVerdict`), plus an optional `git log` (only when the caller
 * opts in via `use_cochange: true`).
 *
 * Why this tool exists alongside the gate: the gate (`delegation-gate.ts`)
 * independently recomputes the verdict INLINE at coder-dispatch time via the
 * same shared `computeParallelVerdict` helper. The tool gives the architect a
 * way to inspect the conflict matrix BEFORE attempting parallel dispatch, so it
 * can choose disjoint task groups and understand why the gate will (or won't)
 * permit parallelism. Single source of truth (the helper), two call sites.
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPlanJsonOnly } from '../plan/manager.js';
import {
	computeParallelVerdict,
	MAX_PARALLEL_VERDICT_TASKS,
} from '../plan/parallel-verdict.js';
import { getCoChangePairs } from '../turbo/epic/cochange-source.js';
import type { CoChangeEntry } from './co-change-analyzer.js';
import { createSwarmTool } from './create-tool.js';

export const plan_conflict_check_args = {
	task_ids: z
		.array(z.string().min(1))
		.min(2, 'plan_conflict_check requires at least 2 task ids to compare')
		.max(
			MAX_PARALLEL_VERDICT_TASKS,
			`plan_conflict_check accepts at most ${MAX_PARALLEL_VERDICT_TASKS} task ids`,
		)
		.describe(
			'The N proposed parallel task group ids (e.g. ["4.1","4.2","4.3"]). ' +
				'Minimum 2 — fewer than 2 tasks cannot conflict.',
		),
	use_cochange: z
		.boolean()
		.optional()
		.describe(
			'When true, fold git co-change signal (from `git log`) into the verdict. ' +
				'Off by default — the path-only verdict is sufficient for the v8 "provably ' +
				'disjoint" gate. Opt in for richer signal on tightly-coupled codebases.',
		),
	phase_id: z
		.string()
		.optional()
		.describe(
			'Optional: scope the check to a phase. Currently informational — task_ids ' +
				'are checked as-is regardless of phase. Reserved for future validation.',
		),
};

export interface PlanConflictCheckResult {
	/** Summary verdict. `all_disjoint` ⇒ safe to parallelize. */
	verdict: 'all_disjoint' | 'conflicts_present' | 'unknown_scopes';
	/** Pairwise results. */
	pairs: Array<{
		a: string;
		b: string;
		verdict: 'conflict' | 'disjoint' | 'unknown';
		evidence: string[];
	}>;
	/** Suggested serialization order (topological sort over the conflict graph). */
	suggested_serial_order: string[];
	/** Tasks whose declared scope could not be resolved. */
	unknown_scope_tasks: string[];
	/** Whether co-change signal was used. */
	used_cochange: boolean;
	/** Diagnostic: did plan.json load successfully? */
	plan_loaded: boolean;
	/** Task ids requested by the caller but absent from the loaded plan. */
	unknown_to_plan?: string[];
}

/**
 * Pure executor (no createSwarmTool wrapper) so it is directly unit-testable.
 *
 * Reads `.swarm/plan.json` (to confirm the task ids exist) and
 * `.swarm/scopes/scope-*.json` (via `computeParallelVerdict`). Writes nothing.
 */
export async function executePlanConflictCheck(
	args: {
		task_ids: string[];
		use_cochange?: boolean;
		phase_id?: string;
	},
	directory: string,
): Promise<PlanConflictCheckResult> {
	const useCochange = args.use_cochange === true;

	// Load plan to validate task ids exist (advisory — the helper works on
	// scope files regardless, but surfacing unknown task ids is useful).
	let planLoaded = false;
	const knownTaskIds = new Set<string>();
	try {
		const plan = await loadPlanJsonOnly(directory);
		if (plan) {
			planLoaded = true;
			for (const phase of plan.phases) {
				for (const task of phase.tasks) knownTaskIds.add(task.id);
			}
		}
	} catch {
		// Fail-open on plan read: the helper only needs scope files. Mark plan
		// as not loaded so the caller knows task-id validation was skipped.
		planLoaded = false;
	}

	// Filter out task ids that don't exist in the plan (only when we loaded it).
	// We still run the verdict on whatever task_ids were requested; unknown task
	// ids simply won't have scope files and will be classified `unknown_scope`.
	const requestedIds = args.task_ids;
	const unknownToPlan = planLoaded
		? requestedIds.filter((id) => !knownTaskIds.has(id))
		: [];

	// Optional co-change fetch (only when opted in). Bounded by the existing
	// `getCoChangePairs` git-timeout wrapper.
	let cochangePairs: CoChangeEntry[] | undefined;
	if (useCochange) {
		try {
			cochangePairs = await getCoChangePairs(directory);
		} catch {
			// Signal-absent: fall back to path-only verdict.
			cochangePairs = undefined;
		}
	}

	const verdict = computeParallelVerdict(directory, requestedIds, {
		useCochange,
		cochangePairs,
	});

	return {
		verdict: verdict.verdict,
		pairs: verdict.pairs,
		suggested_serial_order: verdict.suggestedSerialOrder,
		unknown_scope_tasks: verdict.unknownScopeTasks,
		// F-010: the source defines [] as signal-absent, so requesting
		// co-change is not enough to claim that the signal was used.
		used_cochange:
			useCochange && cochangePairs !== undefined && cochangePairs.length > 0,
		plan_loaded: planLoaded,
		// Surface task ids not found in the plan as evidence lines on the
		// affected pairs (helps the architect spot a typo). We append to
		// existing evidence rather than mutating the helper's output.
		...(unknownToPlan.length > 0
			? {
					unknown_to_plan: unknownToPlan,
				}
			: {}),
	};
}

export const plan_conflict_check: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Read-only advisory check (#1656): compute a pairwise file-conflict matrix for N proposed parallel task groups ' +
		'using declared scopes (`.swarm/scopes/scope-<taskId>.json`) and optional git co-change signal. Returns a ' +
		'verdict (all_disjoint / conflicts_present / unknown_scopes), per-pair evidence, and a suggested serialization ' +
		'order. Writes nothing — the execution gate independently recomputes the verdict inline at dispatch time via ' +
		'the same helper. Use this BEFORE attempting parallel dispatch to confirm disjointness.',
	args: plan_conflict_check_args,
	execute: async (args: unknown, directory: string) => {
		const typedArgs = args as {
			task_ids: string[];
			use_cochange?: boolean;
			phase_id?: string;
		};
		const result = await executePlanConflictCheck(typedArgs, directory);
		return JSON.stringify(result, null, 2);
	},
});
