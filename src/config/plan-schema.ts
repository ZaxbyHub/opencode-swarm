import { z } from 'zod';

// Execution profile schema — plan-scoped parallelization controls set by the architect.
// When locked, the profile is immutable; any attempt to modify it via save_plan is rejected.
export const ExecutionProfileSchema = z.object({
	parallelization_enabled: z.boolean().default(false),
	max_concurrent_tasks: z.number().int().min(1).max(64).default(10),
	council_parallel: z.boolean().default(true),
	locked: z.boolean().default(false),
	auto_proceed: z.boolean().default(false),
	commit_after_each_completed_task: z.boolean().default(false),
	// Optional for backward compatibility: legacy plans resolve missing strictness
	// through the planning-profile resolver instead of a schema default.
	planning_profile: z.enum(['balanced', 'strict']).optional(),
});
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

// Task status enum
export const TaskStatusSchema = z.enum([
	'pending',
	'in_progress',
	'completed',
	'blocked',
	'closed',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// Task size enum
export const TaskSizeSchema = z.enum(['small', 'medium', 'large']);
export type TaskSize = z.infer<typeof TaskSizeSchema>;

// Phase status enum
export const PhaseStatusSchema = z.enum([
	'pending',
	'in_progress',
	'complete',
	'completed', // Alias for 'complete' - both accepted
	'blocked',
	'closed',
]);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

/**
 * Normalize phase status - 'completed' maps to 'complete'.
 * @param status - The phase status to normalize
 * @returns Normalized status ('completed' becomes 'complete')
 */
export function normalizePhaseStatus(status: PhaseStatus): PhaseStatus {
	if (status === 'completed') {
		return 'complete';
	}
	return status;
}

/**
 * Check if a phase status represents completion.
 * @param status - The phase status to check
 * @returns true if status is 'complete' or 'completed'
 */
export function isPhaseComplete(status: PhaseStatus): boolean {
	return status === 'complete' || status === 'completed';
}

// Migration status enum (set when plan was converted from legacy plan.md)
export const MigrationStatusSchema = z.enum([
	'native',
	'migrated',
	'migration_failed',
]);
export type MigrationStatus = z.infer<typeof MigrationStatusSchema>;

/**
 * External-evidence anchor (issue #3422): a pinned read-only git assertion a
 * task declares so `/swarm attest` can verify a git-external deliverable
 * (commit/push, gh ops) without a coder settlement.
 *
 * `expect` matches the trimmed stdout exactly; `expect_prefix` requires a
 * NON-EMPTY prefix of it (an empty prefix would match everything and attest
 * nothing). At least one of the two must be present per anchor; both bounds
 * mirror the durable-evidence storage cap so an anchor is never accepted with
 * output that cannot be persisted verbatim.
 */
export const ExternalEvidenceAnchorSchema = z
	.object({
		command: z.string().min(1).max(400),
		expect: z.string().max(4096).optional(),
		expect_prefix: z.string().min(1).max(4096).optional(),
	})
	// Issue #3432 review PRR-008: the documented contract is "at least one
	// expectation per anchor" — enforce it at the persistence boundary so a
	// vacuous anchor (which would attest anything) never enters a persisted
	// plan, instead of being refused only at attest time.
	.superRefine((anchor, ctx) => {
		if (anchor.expect === undefined && anchor.expect_prefix === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					'evidence anchor must carry expect and/or a non-empty expect_prefix',
				path: ['expect'],
			});
		}
	});
export type ExternalEvidenceAnchor = z.infer<
	typeof ExternalEvidenceAnchorSchema
>;

// Task schema
export const TaskSchema = z
	.object({
		id: z.string(), // e.g. "1.1", "2.3"
		phase: z.number().int().min(1), // phase number this task belongs to
		status: TaskStatusSchema.default('pending'),
		size: TaskSizeSchema.default('small'),
		description: z.string().min(1),
		depends: z.array(z.string()).default([]), // task IDs, e.g. ["1.1", "1.2"]
		acceptance: z.string().optional(), // acceptance criteria
		files_touched: z.array(z.string()).default([]), // files modified by this task
		evidence_path: z.string().optional(), // path to evidence directory
		blocked_reason: z.string().optional(), // why task is blocked
		// Spec FR-###/SC-### IDs this task maps to (issue #1687, FR-000/SC-000).
		// Deliberately `.optional()` (NOT `.default([])`): must serialize to
		// `undefined` (omitted by JSON.stringify) for tasks that don't set it, so
		// computePlanLedgerHash/computePlanStructureHash/computePlanContentHash stay
		// byte-identical for every existing persisted plan predating this field.
		fr_refs: z.array(z.string()).optional(),
		// External-evidence completion class (issue #3422). Optional and
		// omitted-when-unset like fr_refs, so legacy plans hash byte-identically;
		// UNLIKE fr_refs these fields ARE included in the three hash normalizers
		// (they gate completion admission, so declaration edits must be
		// hash-visible — see docs/plan-durability.md). Omission on a save_plan
		// revision preserves the prior declaration; an explicit
		// 'coder_mutation' clears it.
		evidence_class: z.enum(['coder_mutation', 'external_git']).optional(),
		evidence_anchors: z.array(ExternalEvidenceAnchorSchema).max(16).optional(),
	})
	// Issue #3432 review PRR-008: an external_git declaration without at
	// least one pinned anchor can never be attested — reject the shape at
	// the persistence boundary instead of deferring to attest time.
	.superRefine((task, ctx) => {
		if (task.evidence_class === 'external_git') {
			const anchors = task.evidence_anchors;
			if (!anchors || anchors.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						'tasks declaring evidence_class external_git must pin 1..16 evidence_anchors',
					path: ['evidence_anchors'],
				});
			}
		}
	});
export type Task = z.infer<typeof TaskSchema>;

// Phase schema
export const PhaseSchema = z.object({
	id: z.number().int().min(1),
	name: z.string().min(1),
	status: PhaseStatusSchema.default('pending'),
	tasks: z.array(TaskSchema).default([]),
	type: z.enum(['code', 'non-code']).optional(),
	required_agents: z.array(z.string()).optional(),
});
export type Phase = z.infer<typeof PhaseSchema>;

// Plan schema (top-level)
export const PlanSchema = z.object({
	schema_version: z.literal('1.0.0'),
	title: z.string().min(1),
	swarm: z.string().min(1),
	current_phase: z.number().int().min(1).optional(),
	phases: z.array(PhaseSchema).min(1),
	migration_status: MigrationStatusSchema.optional(), // only set when migrated from legacy
	specMtime: z.string().optional(), // ISO 8601 timestamp of when .swarm/spec.md was last modified
	specHash: z.string().optional(), // SHA-256 hex of .swarm/spec.md content
	execution_profile: ExecutionProfileSchema.optional(), // architect-facing concurrency controls (PR3)
});
export type Plan = z.infer<typeof PlanSchema>;

/**
 * Runtime plan with spec staleness tracking.
 * Extends Plan with runtime-only fields that are not persisted.
 *
 * `_midLoadRemovals` is attached by loadPlan-recovery paths that auto-
 * acknowledged task removals (issue #853) so the system-enhancer Layer A
 * can disclose the count to the model without re-reading the ledger.
 *
 * `_ledgerReplayStale` / `_ledgerReplayStaleReason` are attached by loadPlan
 * when it returns a STALE plan.json: the plan.json hash mismatched the ledger,
 * ledger replay failed (threw), AND no critic-approved snapshot was available,
 * so the loader fell back to the (stale) plan.json (#1269 finding 2). Consumers
 * in phase-complete.ts and update-task-status.ts read these to surface a
 * structured staleness signal instead of silently trusting plan.json.
 *
 * RUNTIME-ONLY CONTRACT (mirrors `_specStale`): every field on RuntimePlan is a
 * TypeScript-only overlay on the persisted `Plan`. It is NOT part of the durable
 * `PlanSchema` (see this file ~line 95 — a plain `z.object`, no `.passthrough()`,
 * so Zod strips unknown keys), so `savePlan`'s `JSON.stringify(PlanSchema.parse(...))`
 * can never write these to .swarm/plan.json. It is also excluded from plan hashing:
 * both `computePlanLedgerHash` (src/plan/ledger.ts) and `computePlanContentHash`
 * (src/plan/manager.ts) hash an explicit allow-list of fields, never the whole
 * object. Because of this, AGENTS.md invariant-5's "six places" (ledger replay,
 * projection, checkpoint import/export, get_approved_plan, tests, docs) do NOT
 * all apply — these are not durable schema fields. Do NOT move these into
 * `PlanSchema`.
 */
export type RuntimePlan = Plan & {
	_specStale?: boolean;
	_specStaleReason?: string;
	_midLoadRemovals?: { count: number; source: string };
	_ledgerReplayStale?: boolean;
	_ledgerReplayStaleReason?: string;
};

/**
 * Find the first phase that is in progress.
 * @param phases - Array of phases
 * @returns Phase number of first in-progress phase, or first phase if none
 */
export function findFirstActivePhase(phases: Phase[]): number | undefined {
	const inProgressPhase = phases.find((p) => p.status === 'in_progress');
	if (inProgressPhase) {
		return inProgressPhase.id;
	}
	return phases[0]?.id;
}

/**
 * Whether a phase status is terminal for cursor purposes (issue #2532): the
 * active-phase cursor must never point at a phase whose work is finished.
 */
function isPhaseStatusTerminal(status: PhaseStatus): boolean {
	return status === 'complete' || status === 'completed' || status === 'closed';
}

/**
 * Whether a phase is effectively finished for cursor purposes (#2532).
 *
 * Terminal by STATUS, or terminal by TASKS: every task completed/closed.
 * The task-level check matters for REPLAYED plans — `applyEventToPlan`
 * applies `task_status_changed` to tasks but does not re-derive the phase
 * status, so a replayed projection can carry completed tasks inside a stale
 * `pending` phase; the cursor must still advance off such a phase.
 */
function isPhaseEffectivelyTerminal(phase: Phase): boolean {
	if (isPhaseStatusTerminal(phase.status)) return true;
	// `tasks` can be absent on in-memory plan shapes that never passed through
	// PlanSchema (schema defaults it to []); an unknown task list is honestly
	// "not finished" — and must not throw inside the shared phase resolver.
	const tasks = phase.tasks ?? [];
	return (
		tasks.length > 0 &&
		tasks.every(
			(task) => task.status === 'completed' || task.status === 'closed',
		)
	);
}

/**
 * Resolve the plan's active phase id (issue #2532 / PLAN-4).
 *
 * Contract: the stored `current_phase` is authoritative when it points at a
 * NON-terminal phase (this is what preserves the active phase across plan
 * revisions); otherwise the cursor derives from phase statuses — the first
 * non-terminal phase — so a completed (or removed) phase can never hold the
 * cursor. A fully-terminal plan keeps its last phase id.
 *
 * This is the single canonical derivation shared by the persist-side writer
 * (`normalizeCurrentPhaseInPlace`, applied in `savePlan` /
 * `closePlanTerminalState`), ledger replay (`reconstructPlanFromEvents`), and
 * every consumer that must agree on "the current phase" (plan.md header,
 * summary extractor, preflight, delegation-gate active-phase selection).
 */
export function resolveActivePhaseId(plan: Plan): number {
	const cursor = plan.current_phase;
	if (cursor !== undefined) {
		const cursorPhase = plan.phases.find((phase) => phase.id === cursor);
		if (cursorPhase && !isPhaseEffectivelyTerminal(cursorPhase)) {
			return cursorPhase.id;
		}
	}
	const firstNonTerminal = plan.phases.find(
		(phase) => !isPhaseEffectivelyTerminal(phase),
	);
	if (firstNonTerminal) return firstNonTerminal.id;
	return plan.phases[plan.phases.length - 1]?.id ?? 1;
}

/**
 * Normalize the stored phase cursor in place (issue #2532 / PLAN-4): the ONE
 * durable advancing writer applied at every plan-persist funnel. Must run
 * BEFORE any plan hash is computed so ledger/projection/snapshot surfaces
 * record the normalized state.
 */
export function normalizeCurrentPhaseInPlace(plan: Plan): void {
	plan.current_phase = resolveActivePhaseId(plan);
}

/**
 * Get the current phase from a plan, with fallback inference.
 * @param plan - The plan object
 * @returns The current phase number, or inferred value, or 1 as last resort
 */
export function getCurrentPhase(plan: Plan): number {
	return resolveActivePhaseId(plan);
}

/**
 * Whether `phaseId` is in its PHASE-WRAP window: the phase's work is done and
 * the cursor has already moved past it, but nothing after it has started.
 *
 * Completing a phase's last task advances the cursor (#2532) BEFORE the
 * phase-wrap steps run (docs dispatch, directive override, phase_complete),
 * so those steps act on phase N while the cursor names a later phase. This
 * is the window in which they still belong to N: N is effectively terminal,
 * the cursor is later in plan order (ids need not be contiguous), and every
 * phase between them was skipped: every task closed without work (a phase
 * with no tasks counts when its status is terminal). A phase between them
 * with completed work has a wrap of its own, so it ends N's window: one wrap
 * step never stands in for an older phase. Phase status alone cannot tell
 * the two apart, because savePlan derives `complete` from completed tasks.
 */
export function isPhaseInWrapWindow(plan: Plan, phaseId: number): boolean {
	const order = plan.phases.map((phase) => phase.id);
	const from = order.indexOf(phaseId);
	const to = order.indexOf(getCurrentPhase(plan));
	if (from < 0 || to <= from) return false;
	if (!isPhaseEffectivelyTerminal(plan.phases[from])) return false;
	return plan.phases.slice(from + 1, to).every(isPhaseSkipped);
}

/** Closed out without work of its own (see {@link isPhaseInWrapWindow}). */
function isPhaseSkipped(phase: Phase): boolean {
	const tasks = phase.tasks ?? [];
	if (tasks.length === 0) return isPhaseStatusTerminal(phase.status);
	return tasks.every((task) => task.status === 'closed');
}
