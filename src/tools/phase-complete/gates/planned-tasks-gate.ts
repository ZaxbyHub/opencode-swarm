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
 * projection is the only state and is consulted read-only.
 *
 * Feedback-round contract (PR #3914 review F-1/R2-2 + R2-1): a ledger
 * authority that exists but cannot be trusted is INDETERMINATE, not a defer.
 * The completion flow's own recovery does NOT reliably fail on those states
 * (the ledger-aware `loadPlan` repair only runs on a hash mismatch), so
 * deferring here let completion succeed past unfinished tasks on a torn
 * ledger tail, a `plan-ledger.resetting` crash marker, a peek failure, or an
 * authority that yields no plan — and duplicate phase ids let the first-match
 * read hide a pending second phase. Every indeterminate shape now REFUSES
 * with `PLANNED_TASKS_UNKNOWN`; only a missing phase (in a readable
 * authority) still defers to the caller's own missing-phase machinery.
 */

import type { Plan } from '../../../config/plan-schema';
import { ledgerExists, peekPlanFromLedger } from '../../../plan/ledger';
import { loadPlanJsonOnly } from '../../../plan/manager';
import type { GateContext, GateResult } from './types';

export const PLANNED_TASKS_BLOCKED_REASON = 'PLANNED_TASKS_PENDING';
export const PLANNED_TASKS_UNKNOWN_REASON = 'PLANNED_TASKS_UNKNOWN';

/** Cap for the refusal message's task-ID list (machine recovery already
 * carries the first ID; the cap bounds oversized plan state). */
const MAX_LISTED_TASK_IDS = 20;

/**
 * Read outcome for the planned-tasks authority:
 * - `ok`: a healthy authority decided — finish iff `unfinishedIds` is empty.
 * - `indeterminate`: an existing authority could not be trusted (torn tail,
 *   resetting marker, unreadable, no plan, duplicate phase ids) — callers
 *   must refuse rather than complete.
 * - `defer`: nothing owned the phase (no ledger authority and no readable
 *   projection, or the phase is absent from a readable authority) — the
 *   caller's own missing-phase machinery owns that case.
 */
export type PlannedTasksReadResult =
	| { kind: 'ok'; unfinishedIds: string[] }
	| { kind: 'indeterminate'; detail: string }
	| { kind: 'defer' };

/**
 * Unfinished task IDs across EVERY phase with the given id under the
 * readiness predicate, or null when no phase carries the id. All matches are
 * collected so a duplicate-id plan cannot hide a pending second phase behind
 * a first-match read (review R2-1).
 */
export function unfinishedTaskIdsOf(
	plan: Plan,
	phase: number,
): string[] | null {
	const targets = plan.phases.filter((candidate) => candidate.id === phase);
	if (targets.length === 0) return null;
	return targets
		.flatMap((target) =>
			target.tasks.filter(
				(task) => task.status !== 'completed' && task.status !== 'closed',
			),
		)
		.map((task) => task.id)
		.sort();
}

function plannedTasksReadOfPlan(
	plan: Plan,
	phase: number,
): PlannedTasksReadResult {
	const matches = plan.phases.filter((candidate) => candidate.id === phase);
	if (matches.length > 1) {
		return {
			kind: 'indeterminate',
			detail: `the plan defines ${matches.length} phases with id ${phase}`,
		};
	}
	if (matches.length === 0) return { kind: 'defer' };
	return { kind: 'ok', unfinishedIds: unfinishedTaskIdsOf(plan, phase) ?? [] };
}

/**
 * Authoritative planned-task readiness for a phase, read-only.
 *
 * - Ledger authority present: the peeked (observational, authority-resolved)
 *   plan decides. A peek failure, a truncated/damaged ledger tail, a
 *   resetting crash marker, or an authority that yields no plan is
 *   INDETERMINATE — refuse, never fall back to the projection over a
 *   possibly-authoritative ledger.
 * - No ledger authority at all: the plan.json projection decides (read-only).
 * - Missing/unreadable plan, or phase not found: `defer`.
 */
export async function readUnfinishedPlannedTasks(
	directory: string,
	phase: number,
): Promise<PlannedTasksReadResult> {
	let authorityExists = false;
	try {
		authorityExists = await ledgerExists(directory);
	} catch {
		return {
			kind: 'indeterminate',
			detail: 'the plan-ledger authority presence could not be determined',
		};
	}
	if (authorityExists) {
		let peek: Awaited<ReturnType<typeof peekPlanFromLedger>>;
		try {
			peek = await peekPlanFromLedger(directory);
		} catch (error) {
			return {
				kind: 'indeterminate',
				detail: `the plan ledger could not be read (${
					error instanceof Error ? error.message : String(error)
				})`,
			};
		}
		if (peek.truncated || peek.badSuffix) {
			return {
				kind: 'indeterminate',
				detail: 'the plan ledger tail is truncated or damaged',
			};
		}
		if (!peek.plan) {
			return {
				kind: 'indeterminate',
				detail: 'the plan ledger authority produced no plan',
			};
		}
		return plannedTasksReadOfPlan(peek.plan, phase);
	}
	const projection = await loadPlanJsonOnly(directory);
	if (!projection) return { kind: 'defer' };
	return plannedTasksReadOfPlan(projection, phase);
}

export function plannedTasksBlockedMessage(
	phase: number,
	unfinishedIds: string[],
): string {
	const listed = unfinishedIds.slice(0, MAX_LISTED_TASK_IDS);
	const suffix =
		unfinishedIds.length > MAX_LISTED_TASK_IDS
			? ` … and ${unfinishedIds.length - MAX_LISTED_TASK_IDS} more`
			: '';
	return (
		`Phase ${phase} cannot be completed: planned task(s) not finished: ${listed.join(', ')}${suffix}. ` +
		'Complete each task with update_task_status (status "completed") before completing the phase — update_task_status does not accept a "closed" status; a blocked task needs its own repair path, or the documented phase_complete.enabled:false operator bypass.'
	);
}

export function plannedTasksUnknownMessage(
	phase: number,
	detail: string,
): string {
	return (
		`Phase ${phase} completion cannot be verified: ${detail}. ` +
		'Refusing rather than completing over an unreadable plan authority — no plan transition or completion event was written. Repair the plan-ledger state and retry (phase_complete.enabled:false remains the operator bypass).'
	);
}

/** Preflight/commit-boundary gate: refuse while planned tasks are unfinished,
 * and refuse (never complete) when the authority cannot be trusted. */
export async function runPlannedTasksGate(
	ctx: GateContext,
): Promise<GateResult> {
	const read = await readUnfinishedPlannedTasks(ctx.dir, ctx.phase);
	if (read.kind === 'indeterminate') {
		return {
			blocked: true,
			reason: PLANNED_TASKS_UNKNOWN_REASON,
			message: plannedTasksUnknownMessage(ctx.phase, read.detail),
			agentsDispatched: ctx.agentsDispatched,
			agentsMissing: [],
			warnings: [],
			recovery: { kind: 'retry', action: 'phase_complete' },
		};
	}
	const unfinishedIds = read.kind === 'ok' ? read.unfinishedIds : [];
	if (unfinishedIds.length === 0) {
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
