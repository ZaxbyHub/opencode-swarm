/**
 * Lean Turbo Module — barrel export.
 *
 * Re-exports all public symbols from sub-modules so consumers can import
 * everything from a single path:
 *
 * ```ts
 * import { LeanTurboRunner, planLeanTurboLanes, LeanTurboLane, ... } from './turbo/lean';
 * ```
 */

// ─── Runner ────────────────────────────────────────────────────────────────────

export type {
	LaneDispatchResult,
	LaneResult,
	LaneStatus,
	LeanTurboPhaseResult,
} from './runner';
export { LeanTurboRunner } from './runner';

// ─── Planner ─────────────────────────────────────────────────────────────────

export type {
	LeanTurboLanePlan,
	PlanPhase,
	PlanTask,
} from './planner';
// Re-export conflict utilities from planner (already re-exported there)
export {
	GLOBAL_FILES_LIST,
	isGlobalFile,
	isPathSafe,
	isProtectedPath,
	normalizePath,
	PROTECTED_PATTERNS_LIST,
	pathsConflict,
	planLeanTurboLanes,
	readTaskScopes,
} from './planner';

// ─── State ────────────────────────────────────────────────────────────────────

export type {
	LeanTurboCounters,
	LeanTurboDegradedTask,
	LeanTurboLane,
	LeanTurboPersistedState,
	LeanTurboRunState,
	LeanTurboStatus,
} from './state';

export {
	emptyCounters,
	emptyPersisted,
	emptyRunState,
	isLeanTurboRunActive,
	isStateUnreadable,
	loadLeanTurboRunState,
	pauseLeanTurboRun,
	repairStateUnreadable,
	resetLeanTurboRun,
	saveLeanTurboRunState,
} from './state';

// ─── Conflicts ─────────────────────────────────────────────────────────────────

// Re-exported via ./planner (above) — do not duplicate

// ─── Evidence ─────────────────────────────────────────────────────────────────

export type { LeanTurboConfig } from '../../config/schema';
export type { LaneEvidence, PhaseEvidence } from './evidence';
export {
	listLaneEvidence,
	readLaneEvidence,
	readPhaseEvidence,
	writeLaneEvidence,
	writePhaseEvidence,
} from './evidence';

// ─── Phase Ready ───────────────────────────────────────────────────────────────

export type {
	LeanTurboPhaseReadyConfig,
	LeanTurboPhaseReadyResult,
} from './phase-ready';
export { verifyLeanTurboPhaseReady } from './phase-ready';

// ─── Risk ─────────────────────────────────────────────────────────────────────

export type { TaskRiskAssessment, TaskRiskCategory } from './risk';
export { assessTaskRisk } from './risk';

// ─── Integration (Phase Critic) ───────────────────────────────────────────────

export type {
	LeanTurboPhaseCriticConfig,
	PhaseCriticResult,
} from './integration';
export { dispatchPhaseCritic } from './integration';

// ─── Reviewer (Phase Reviewer) ────────────────────────────────────────────────

export type {
	LeanTurboPhaseReviewerConfig,
	PhaseReviewerResult,
} from './reviewer';
export { dispatchPhaseReviewer } from './reviewer';
