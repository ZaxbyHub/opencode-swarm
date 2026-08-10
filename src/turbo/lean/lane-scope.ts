/**
 * Lean Turbo lane write authority (issue #2002 — Lean Turbo half).
 *
 * ## The defect this closes
 *
 * A Lean Turbo lane creates a coder session rooted at the lane worktree and
 * dispatches it with `tools: { write: true, edit: true, patch: true }`
 * (`src/turbo/lean/runner.ts`), but nothing ever published a v2 scope binding
 * for that session and nothing ever materialized the authoritative plan into
 * the lane. `resolveAuthorizedScopeBinding` starts from
 * `readCurrentPlan(directory)` (`src/scope/scope-persistence.ts`), so with no
 * `.swarm/plan.json` in the lane it returned null before it even looked at a
 * binding — and every lane coder write failed `SCOPE_NOT_DECLARED` regardless
 * of which directory the gate resolved.
 *
 * This module publishes that authority using the same primitives as the
 * standard worktree path (`src/hooks/delegation-gate.ts`, the
 * `savePlan` → `deriveChildScopeBinding` → `persistAndRegisterScopeBinding`
 * sequence), so every identity condition in
 * `getAuthorizedScopeBindingByPlanIdentity` is satisfied without weakening or
 * bypassing any of them.
 *
 * ## Authority boundary
 *
 * A lane binding authorizes exactly the intersection of
 *   1. `lane.files` — the file set the lane already holds exclusive locks on
 *      (`acquireLaneLocks(directory, laneId, lane.files, agent, lane.taskIds[0], …)`
 *      in `src/turbo/lean/runner.ts`), and
 *   2. the authoritative plan's `files_touched` for the lane's own tasks.
 *
 * It therefore grants nothing the lane's pre-existing file locks did not
 * already reserve for this dispatch, and nothing the plan does not attribute to
 * this lane's tasks. It is rooted at the lane worktree, owned by the lane's
 * child session id, and correlated to a single synthetic dispatch id — so it
 * can never authorize a write in another lane or in the project root.
 *
 * ## Known gap (deliberate, not a bypass)
 *
 * A lane may carry several task ids (`src/turbo/lean/planner.ts` assigns every
 * non-conflicting ready task to the first non-conflicting lane). The scope
 * gates resolve a binding by a single `session.currentTaskId`, so a lane gets
 * ONE binding labelled with the lane's representative task id
 * (`lane.taskIds[0]`, the same representative the lock layer already uses) and
 * carrying the lane's whole plan-backed authority. This mirrors the lock
 * record 1:1; it does not widen the lane past what the lock already reserved.
 *
 * ## Fail-closed contract
 *
 * When a lane has no representative task id in strict `N.M[.P]` form, no
 * plan-backed files, or an unusable child identity, this module publishes
 * NOTHING and returns null. The lane coder then hits the ordinary
 * `SCOPE_NOT_DECLARED` block — byte-identical to pre-fix behaviour. There is no
 * path here that grants a lane coder write authority without a validated,
 * plan-correlated, lane-rooted binding.
 */
import type { Plan } from '../../config/plan-schema';
import { savePlan } from '../../plan/manager';
import {
	createScopeBinding,
	deriveChildScopeBinding,
	normalizeScopeFiles,
	type ScopeBinding,
	scopeContains,
} from '../../scope/scope-binding';
import { persistAndRegisterScopeBinding } from '../../scope/scope-persistence';
import { ensureAgentSession, recordSessionWorkspaceRoot } from '../../state';

/**
 * Namespace for the synthetic dispatch-call id that correlates a lane's child
 * binding to its parent Lean Turbo run. Lean Turbo dispatches through the
 * OpenCode session API rather than the Task tool, so there is no upstream
 * `callID`. The prefix keeps these ids disjoint from real Task call ids so a
 * lane binding can never be claimed by a Task-dispatch lookup.
 */
export const LEAN_TURBO_LANE_DISPATCH_PREFIX = 'lean-turbo-lane';

/** Minimal lane shape this module needs. Matches `LeanTurboLane`. */
export interface LeanTurboLaneScopeLane {
	laneId: string;
	taskIds: readonly string[];
	files: readonly string[];
}

export interface PublishLeanTurboLaneScopeInput {
	/** Project root the Lean Turbo run was started in. */
	primaryDirectory: string;
	/** Root the lane's coder session actually executes in. */
	laneRoot: string;
	/**
	 * True only when `laneRoot` is `provisionWorktree`'s own output. Never
	 * derive this from a path comparison and never from an agent-supplied
	 * value: it gates both the lane plan materialization and the workspace-root
	 * recording, which are the two writes that must follow provisioning
	 * authority only.
	 */
	isolated: boolean;
	/** Authoritative plan for this run (already loaded from the project root). */
	plan: Plan;
	lane: LeanTurboLaneScopeLane;
	/** Session running the Lean Turbo phase (the architect). */
	parentSessionId: string;
	/** Session id returned by `session.create` for this lane. */
	childSessionId: string;
}

/**
 * Build the synthetic dispatch-call id for one lane dispatch. Unique per
 * (parent session, lane, child session), so two lanes can never share a
 * correlation id and one lane's binding can never satisfy another's lookup.
 *
 * Module-private: used only by `publishLeanTurboLaneScopeBinding` below. No
 * production or test caller imports this outside this module (verified via
 * grep across `src/` and `tests/`) — exporting it was unwired surface area
 * under the project's "we never ship unwired code" directive.
 */
function deriveLeanTurboLaneDispatchCallId(input: {
	parentSessionId: string;
	laneId: string;
	childSessionId: string;
}): string {
	return `${LEAN_TURBO_LANE_DISPATCH_PREFIX}:${input.parentSessionId}:${input.laneId}:${input.childSessionId}`;
}

/**
 * Normalize one candidate path through the exact primitive the binding layer
 * uses, so authority computed here can never disagree with the authority the
 * gates enforce. `normalizeScopeFiles` is all-or-nothing by design; applying it
 * per entry lets a single malformed plan entry drop out instead of discarding
 * an otherwise valid lane.
 */
function normalizeOne(file: string): string | null {
	const normalized = normalizeScopeFiles([file]);
	return normalized ? (normalized[0] ?? null) : null;
}

/**
 * Resolve the file set a lane may be authorized for: lane-locked files that the
 * authoritative plan also attributes to one of the lane's own tasks.
 *
 * Returns null when the plan attributes no usable file to this lane's tasks or
 * when no locked lane file falls inside that plan authority — both are
 * fail-closed outcomes, never a widening fallback.
 */
export function resolveLeanTurboLaneAuthorityFiles(
	plan: Plan,
	lane: LeanTurboLaneScopeLane,
): string[] | null {
	const laneTaskIds = new Set(lane.taskIds);
	if (laneTaskIds.size === 0) return null;

	const planAuthority: string[] = [];
	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			if (!laneTaskIds.has(task.id)) continue;
			for (const file of task.files_touched ?? []) {
				const normalized = normalizeOne(file);
				if (normalized) planAuthority.push(normalized);
			}
		}
	}
	if (planAuthority.length === 0) return null;

	const authorized = new Set<string>();
	for (const file of lane.files) {
		const normalized = normalizeOne(file);
		if (!normalized) continue;
		if (scopeContains(planAuthority, normalized)) authorized.add(normalized);
	}
	if (authorized.size === 0) return null;
	return normalizeScopeFiles([...authorized]);
}

/**
 * Publish one Lean Turbo lane's write authority.
 *
 * Ordering is deliberate:
 *   1. validate identity and resolve plan-backed authority (cheap, no writes) —
 *      a failure here publishes nothing at all;
 *   2. materialize the authoritative plan into the lane (isolated lanes only,
 *      so concurrent lanes never re-write the project's own plan ledger);
 *   3. derive the active child binding, register it, and persist it under the
 *      lane root;
 *   4. bind the child session to the lane root so the write gates resolve
 *      against the lane instead of the plugin-root `ctx.directory`.
 *
 * @returns the published child binding, or null when the lane cannot be
 *   authorized (fail closed — the caller must NOT grant any substitute).
 * @throws only on unexpected I/O failure (e.g. `savePlan` rejecting). The
 *   caller treats a throw as a hard dispatch failure.
 */
export async function publishLeanTurboLaneScopeBinding(
	input: PublishLeanTurboLaneScopeInput,
): Promise<ScopeBinding | null> {
	const parentSessionId = input.parentSessionId.trim();
	const childSessionId = input.childSessionId.trim();
	// A child that is not a distinct session cannot satisfy the
	// `ownerSessionId !== parentOwnerSessionId` condition the authorization
	// filter enforces — refuse before minting anything.
	if (!parentSessionId || !childSessionId || parentSessionId === childSessionId)
		return null;

	const taskId = input.lane.taskIds[0];
	if (!taskId) return null;

	const files = resolveLeanTurboLaneAuthorityFiles(input.plan, input.lane);
	if (!files) return null;

	const dispatchCallId = deriveLeanTurboLaneDispatchCallId({
		parentSessionId,
		laneId: input.lane.laneId,
		childSessionId,
	});

	// The parent precursor is intentionally NOT registered: only the derived
	// child binding is ever an authorization, and leaving an unregistered
	// precursor keeps the architect session from holding a project-root
	// binding it never needed. `createScopeBinding` still performs every
	// validation (strict task id, normalized files, resolvable workspace).
	const parentBinding = createScopeBinding({
		directory: input.primaryDirectory,
		plan: input.plan,
		taskId,
		files,
		ownerSessionId: parentSessionId,
		ownerMessageId: dispatchCallId,
		source: 'plan',
		dispatchCallId,
		activation: 'pending_child',
	});
	if (!parentBinding) return null;

	if (input.isolated) {
		// Strict child authorization is resolved against the plan projection in
		// the lane's own root, so the lane needs the authoritative plan written
		// through the ledger-aware writer — never a hand-copied projection.
		// Only isolated lanes: a shared-directory lane already reads the
		// project's own plan.json, and re-saving it from concurrent lanes would
		// churn the authoritative plan ledger.
		await savePlan(input.laneRoot, input.plan, {
			preserveCompletedStatuses: false,
		});
	}

	const derivedBinding = deriveChildScopeBinding(parentBinding, {
		childDirectory: input.laneRoot,
		childSessionId,
		parentCallId: dispatchCallId,
	});
	const published = await persistAndRegisterScopeBinding(
		input.laneRoot,
		derivedBinding,
	);
	if (!published.ok) return null;
	const childBinding = published.value;

	// Register the session as a coder BEFORE recording its workspace root.
	// ORDER IS LOAD-BEARING: `recordSessionWorkspaceRoot` deliberately does NOT
	// create the session, so recording before registration is a silent no-op and
	// the lane falls back to the plugin root (blocked). The setter refuses to
	// create precisely because an unnamed session registers
	// `swarmState.activeAgent` as 'unknown', which is truthy and therefore FAILS
	// OPEN through the guardrails no-agent guards into the `noScopeLenient`
	// branch that skips the authority check entirely.
	const childSession = ensureAgentSession(
		childSessionId,
		'coder',
		input.laneRoot,
	);
	childSession.currentTaskId = childBinding.taskId;
	childSession.declaredCoderScope = [...childBinding.files];

	if (input.isolated) {
		// TRUST BOUNDARY: `laneRoot` here is provisionWorktree's own output,
		// threaded down from the runner. Never record a root derived from a
		// tool argument. Shared-directory lanes are deliberately left to the
		// plugin-root fallback, which is already the correct root for them.
		recordSessionWorkspaceRoot(childSessionId, input.laneRoot);
	}

	return childBinding;
}
