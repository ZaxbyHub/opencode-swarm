/**
 * Planned-tasks gate – refuses phase completion while planned tasks are
 * unfinished (issue #3770).
 *
 * A task is unfinished unless its status is `completed` or `closed` — the
 * readiness predicate shared by Epic phase-readiness
 * (src/epic/phase-readiness.ts) and the drift gate's incomplete-task count;
 * `blocked` refuses, matching Epic's refusal to close a wave over blocked
 * tasks (src/epic/next-wave.ts).
 *
 * Both consumers (the pre-`loadPlan` early refusal in phase_complete and this
 * preflight/commit-boundary gate) read the SAME authoritative view through
 * {@link readUnfinishedPlannedTasks}: `peekPlanFromLedger` is strictly
 * observational (never repairs, quarantines, or materializes state) and
 * resolves file/SQLite authority exactly like the repairing replay, so a
 * stale projection cannot mask ledger-ahead task statuses in either
 * direction. When no ledger authority exists at all, the plan.json
 * projection is the only state and is consulted read-only. A ledger that
 * exists but is corrupt/truncated/unreadable DEFERS (null) — the projection
 * is never consulted when the authority may hold the truth, and the
 * completion flow's own recovery owns that case.
 */

import { ledgerExists, peekPlanFromLedger } from '../../../plan/ledger';
import { loadPlanJsonOnly } from '../../../plan/manager';
import type { Plan } from '../../../config/plan-schema';
import type { GateContext, GateResult } from './types';

export const PLANNED_TASKS_BLOCKED_REASON = 'PLANNED_TASKS_PENDING';

/**
 * Unfinished task IDs of one phase under the readiness predicate, or null
 * when the phase is not in the plan (defer; other machinery owns that).
 */
export function unfinishedTaskIdsOf(plan: Plan, phase: number): string[] | null {
	const target = plan.phases.find((candidate) => candidate.id === phase);
	if (!target) return null;
	return target.tasks
		.filter(
			(task) => task.status !== 'completed' && task.status !== 'closed',
		)
		.map((task) => task.id)
		.sort();
}

/**
 * Authoritative unfinished planned-task IDs for a phase, read-only.
 *
 * - Ledger authority present: the peeked (observational, authority-resolved)
 *   plan decides; corrupt/truncated/unreadable/replay-failure defers (null).
 * - No ledger authority at all: the plan.json projection decides (read-only).
 * - Missing/unreadable plan, or phase not found: null (defer).
 */
export async function readUnfinishedPlannedTasks(
	directory: string,
	phase: number,
): Promise<string[] | null> {
	let authorityExists = false;
	try {
		authorityExists = await ledgerExists(directory);
	} catch {
		return null;
	}
	if (authorityExists) {
		let peek: Awaited<ReturnType<typeof peekPlanFromLedger>>;
		try {
			peek = await peekPlanFromLedger(directory);
		} catch {
			// Replay failure (e.g. an unhandled event type propagates from
			// applyEventToPlan) — defer; never fall back to the projection over
			// a possibly-authoritative ledger.
			return null;
		}
		if (peek.truncated || peek.badSuffix) return null;
		if (!peek.plan) return null;
		return unfinishedTaskIdsOf(peek.plan, phase);
	}
	const projection = await loadPlanJsonOnly(directory);
	if (!projection) return null;
	return unfinishedTaskIdsOf(projection, phase);
}

export function plannedTasksBlockedMessage(
	phase: number,
	unfinishedIds: string[],
): string {
	return (
		`Phase ${phase} cannot be completed: planned task(s) not finished: ${unfinishedIds.join(', ')}. ` +
		'Finish each task (update_task_status to completed) or close it (update_task_status to closed) before completing the phase.'
	);
}

/** Preflight/commit-boundary gate: refuse while planned tasks are unfinished. */
export async function runPlannedTasksGate(
	ctx: GateContext,
): Promise<GateResult> {
	const unfinishedIds = await readUnfinishedPlannedTasks(ctx.dir, ctx.phase);
	if (unfinishedIds === null || unfinishedIds.length === 0) {
		return {
			blocked: false,
			agentsDispatched: ctx.agentsDispatched,
			agentsMissing: [],
			warnings: [],
		};
	}
	return {
		blocked: true,
		reason: PLANNED_TASKS_BLOCKED_REASON,
		message: plannedTasksBlockedMessage(ctx.phase, unfinishedIds),
		agentsDispatched: ctx.agentsDispatched,
		agentsMissing: [],
		warnings: [],
		recovery: {
			kind: 'tool',
			action: 'update_task_status',
			args: { task_id: unfinishedIds[0], status: 'completed' },
		},
	};
}
