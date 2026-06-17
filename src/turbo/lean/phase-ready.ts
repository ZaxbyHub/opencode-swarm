/**
 * Lean Turbo Phase Boundary Gate Verification.
 *
 * Provides a synchronous helper to check whether a Lean Turbo phase is ready
 * to advance to the next phase — i.e., whether all gates (lane completion,
 * lock clearance, degraded task resolution, reviewer/critic approval) have
 * been satisfied.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listActiveLocks } from '../../parallel/file-locks';
import { listLaneEvidence } from './evidence';
import type {
	LeanTurboDegradedTask,
	LeanTurboLane,
	LeanTurboPersistedState,
	LeanTurboRunState,
} from './state';
import { readPersisted } from './state';

/**
 * Configuration options for phase gate checks.
 * Passed optionally so callers can control whether reviewer/critic checks run.
 */
export interface LeanTurboPhaseReadyConfig {
	phase_reviewer?: boolean;
	phase_critic?: boolean;
	integrated_diff_required?: boolean;
}

/**
 * Default configuration for phase readiness checks.
 *
 * NOTE (Issue #7 - integrated_diff_required Default Safety Gap):
 * Currently defaults to `false` for backward compatibility with existing projects.
 * For NEW projects and safety-critical lanes, it is recommended to:
 * - Set integrated_diff_required: true explicitly in caller configurations, or
 * - Implement project-level default configuration to enforce this safety check
 *
 * Integrated diff validation ensures that parallel lane changes integrate cleanly
 * back to the primary branch. Setting to true requires diff evidence before phase advance.
 */
const DEFAULT_CONFIG: Required<LeanTurboPhaseReadyConfig> = {
	phase_reviewer: true,
	phase_critic: true,
	integrated_diff_required: false,
};

/**
 * Result of the Lean Turbo phase readiness check.
 */
export interface LeanTurboPhaseReadyResult {
	ok: boolean;
	reason: string;
	evidence?: {
		lanes: string[];
		degradedTasks: string[];
		reviewerVerdict?: string;
		criticVerdict?: string;
	};
}

/**
 * Shape of the plan.json file read by _internals.readPlanJson.
 */
interface PlanJson {
	phases: Array<{
		id?: number;
		tasks: Array<{ id: string; status: string }>;
	}>;
}

/**
 * Shape of the reviewer evidence file (lean-turbo-reviewer.json).
 */
interface ReviewerEvidence {
	phase: number;
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
	reason?: string | null;
	timestamp: string;
}

/**
 * Shape of the critic evidence file (lean-turbo-critic.json).
 */
interface CriticEvidence {
	phase: number;
	verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN';
	reason?: string | null;
	timestamp: string;
}

/**
 * Default implementation: read plan.json synchronously from .swarm/.
 * Returns null if the file cannot be read, parsed, or has malformed shape.
 */
function defaultReadPlanJson(dir: string): PlanJson | null {
	try {
		const planPath = path.join(dir, '.swarm', 'plan.json');
		if (!fs.existsSync(planPath)) return null;
		const raw = fs.readFileSync(planPath, 'utf-8');
		const plan = JSON.parse(raw) as unknown;
		// Shape validation: plan must be a non-null object with a phases array
		if (
			typeof plan !== 'object' ||
			plan === null ||
			!Array.isArray((plan as { phases?: unknown }).phases)
		) {
			return null;
		}
		return plan as PlanJson;
	} catch {
		return null;
	}
}

/**
 * Reads the reviewer evidence from .swarm/evidence/{phase}/lean-turbo-reviewer.json.
 *
 * Returns null for missing or invalid files (fail-closed).
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @returns Parsed reviewer evidence or null
 */
function readReviewerEvidenceFromFile(
	directory: string,
	phase: number,
): ReviewerEvidence | null {
	try {
		const evidencePath = path.join(
			directory,
			'.swarm',
			'evidence',
			String(phase),
			'lean-turbo-reviewer.json',
		);
		if (!fs.existsSync(evidencePath)) {
			return null;
		}
		const raw = fs.readFileSync(evidencePath, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;
		// Validate shape
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			typeof (parsed as ReviewerEvidence).verdict !== 'string'
		) {
			return null;
		}
		const verdict = (parsed as ReviewerEvidence).verdict;
		if (
			verdict !== 'APPROVED' &&
			verdict !== 'NEEDS_REVISION' &&
			verdict !== 'REJECTED'
		) {
			return null;
		}
		return parsed as ReviewerEvidence;
	} catch {
		return null;
	}
}

/**
 * Reads the critic evidence from .swarm/evidence/{phase}/lean-turbo-critic.json.
 *
 * Returns null for missing or invalid files (fail-closed).
 *
 * @param directory - Project root directory
 * @param phase - Phase number
 * @returns Parsed critic evidence or null
 */
function readCriticEvidenceFromFile(
	directory: string,
	phase: number,
): CriticEvidence | null {
	try {
		const evidencePath = path.join(
			directory,
			'.swarm',
			'evidence',
			String(phase),
			'lean-turbo-critic.json',
		);
		if (!fs.existsSync(evidencePath)) {
			return null;
		}
		const raw = fs.readFileSync(evidencePath, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;
		// Validate shape
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			typeof (parsed as CriticEvidence).verdict !== 'string'
		) {
			return null;
		}
		const verdict = (parsed as CriticEvidence).verdict;
		if (
			verdict !== 'APPROVED' &&
			verdict !== 'NEEDS_REVISION' &&
			verdict !== 'REJECTED' &&
			verdict !== 'ESCALATE_TO_HUMAN'
		) {
			return null;
		}
		return parsed as CriticEvidence;
	} catch {
		return null;
	}
}

/**
 * Synchronously lists lane evidence files for a given phase.
 * Returns the set of laneIds found in `.swarm/evidence/{phase}/lean-turbo/*.json`
 * (excluding the phase-level `lean-turbo-phase.json` file).
 */
function listLaneEvidenceSync(directory: string, phase: number): string[] {
	const evidenceDir = path.join(
		directory,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);

	let entries: string[];
	try {
		entries = fs.readdirSync(evidenceDir);
	} catch {
		// Directory doesn't exist — no evidence files
		return [];
	}

	const laneIds: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith('.json') || entry === 'lean-turbo-phase.json') {
			continue;
		}
		// Strip `.json` suffix to get the laneId
		laneIds.push(entry.slice(0, -'.json'.length));
	}
	return laneIds;
}

/**
 * Test-only seam. Replaces the lock-list and state-load functions so tests
 * can inject mock results without touching the real `file-locks` module or
 * the module-level `stateUnreadable` flag used by `loadLeanTurboRunState`.
 */
export const _internals: {
	listActiveLocks: typeof listActiveLocks;
	readPersisted: typeof readPersisted;
	readPlanJson: (dir: string) => PlanJson | null;
	readReviewerEvidence: (dir: string, phase: number) => ReviewerEvidence | null;
	readCriticEvidence: (dir: string, phase: number) => CriticEvidence | null;
	listLaneEvidence: typeof listLaneEvidence;
	listLaneEvidenceSync: (dir: string, phase: number) => string[];
	verifyLeanTurboPhaseReady: typeof verifyLeanTurboPhaseReady;
} = {
	listActiveLocks,
	readPersisted,
	readPlanJson: defaultReadPlanJson,
	readReviewerEvidence: readReviewerEvidenceFromFile,
	readCriticEvidence: readCriticEvidenceFromFile,
	listLaneEvidence,
	listLaneEvidenceSync,
	verifyLeanTurboPhaseReady,
};

/**
 * Validate shape of persisted state at each level (defense-in-depth).
 */
function validatePersistedShape(
	persisted: unknown,
): persisted is LeanTurboPersistedState {
	if (typeof persisted !== 'object' || persisted === null) return false;
	if (Array.isArray(persisted)) return false;
	if (typeof (persisted as LeanTurboPersistedState).sessions !== 'object')
		return false;
	if ((persisted as LeanTurboPersistedState).sessions === null) return false;
	if (Array.isArray((persisted as LeanTurboPersistedState).sessions))
		return false;
	return true;
}

/**
 * Validate shape of a session's lanes array.
 */
function validateLanesArray(lanes: unknown): lanes is LeanTurboLane[] {
	if (!Array.isArray(lanes)) return false;
	for (const lane of lanes) {
		if (typeof lane !== 'object' || lane === null) return false;
		if (typeof (lane as LeanTurboLane).laneId !== 'string') return false;
		if (typeof (lane as LeanTurboLane).status !== 'string') return false;
	}
	return true;
}

/**
 * Validate shape of a session's degradedTasks array.
 */
function validateDegradedTasksArray(
	degradedTasks: unknown,
): degradedTasks is LeanTurboDegradedTask[] {
	if (!Array.isArray(degradedTasks)) return false;
	for (const dt of degradedTasks) {
		if (typeof dt !== 'object' || dt === null) return false;
		if (typeof (dt as LeanTurboDegradedTask).taskId !== 'string') return false;
	}
	return true;
}

/**
 * Synchronously verify whether a Lean Turbo phase is ready to advance.
 *
 * Checks are performed in fail-fast order:
 *  1. Read `.swarm/turbo-state.json` via readPersisted → null/unreadable → ok: false
 *  2. Find a session with status === 'running' and phase === args.phase and strategy === 'lean'
 *     If sessionID is provided, also require sessionId === sessionID → none → ok: false
 *  3. Validate session.lanes is a non-empty array → empty → ok: false
 *  4. Check all eligible lanes have status 'completed' or 'failed' → not → ok: false
 *  5. Check no active lane locks exist for lanes in this phase → locks → ok: false
 *  6. Check all degraded tasks in lane plan are resolved → pending/in_progress → ok: false
 *  7. Check integrated diff evidence exists (when required) → missing → ok: false
 *  8. Check reviewer approval if phase_reviewer enabled → missing/rejected → ok: false
 *  9. Check critic approval if phase_critic enabled → missing/rejected → ok: false
 *  10. All checks pass → ok: true
 *
 * Supports two calling conventions for backward compatibility:
 * - New: verifyLeanTurboPhaseReady(dir, phase, sessionID?, config?)
 * - Legacy: verifyLeanTurboPhaseReady(dir, phase, config?) — config was previously the 3rd param
 *
 * @param directory - Project root directory
 * @param phase     - Phase number to verify readiness for
 * @param sessionIDOrConfig - Optional session ID (string) OR config object (legacy 3rd-param style)
 * @param config    - Optional config; defaults to { phase_reviewer: true, phase_critic: true, integrated_diff_required: true }
 */
export function verifyLeanTurboPhaseReady(
	directory: string,
	phase: number,
	sessionIDOrConfig?: string | LeanTurboPhaseReadyConfig,
	config?: LeanTurboPhaseReadyConfig,
): LeanTurboPhaseReadyResult {
	// Detect calling convention: string = new (sessionID), object = legacy (config)
	const sessionID =
		typeof sessionIDOrConfig === 'string' ? sessionIDOrConfig : undefined;
	const actualConfig: LeanTurboPhaseReadyConfig =
		typeof sessionIDOrConfig === 'object' && sessionIDOrConfig !== null
			? sessionIDOrConfig
			: (config ?? DEFAULT_CONFIG);

	const mergedConfig: Required<LeanTurboPhaseReadyConfig> = {
		...DEFAULT_CONFIG,
		...actualConfig,
	};

	// ── 1. Read turbo-state.json via readPersisted ─────────────────────────────
	const statePath = path.join(directory, '.swarm', 'turbo-state.json');
	if (!fs.existsSync(statePath)) {
		return {
			ok: false,
			reason: 'Lean Turbo state unreadable or missing',
		};
	}

	const persisted = _internals.readPersisted(directory);
	if (!persisted) {
		return {
			ok: false,
			reason: 'Lean Turbo state unreadable or missing',
		};
	}

	// ── 1b. Shape guard: persisted must be a valid object ────────────────────
	if (!validatePersistedShape(persisted)) {
		return {
			ok: false,
			reason: 'Lean Turbo state unreadable or missing',
		};
	}

	// ── 2. Find active session for this phase ─────────────────────────────────
	let runState: LeanTurboRunState | null = null;
	for (const sessionState of Object.values(persisted.sessions)) {
		if (
			typeof sessionState === 'object' &&
			sessionState !== null &&
			(sessionState as LeanTurboRunState).status === 'running' &&
			(sessionState as LeanTurboRunState).phase === phase &&
			(sessionState as LeanTurboRunState).strategy === 'lean' &&
			(sessionState as LeanTurboRunState).sessionID === sessionID
		) {
			runState = sessionState as LeanTurboRunState;
			break;
		}
	}
	// Backward compatibility: if no sessionID was provided, fall back to first matching session
	// (ignoring sessionId check) to avoid breaking existing callers
	if (!runState && sessionID === undefined) {
		for (const sessionState of Object.values(persisted.sessions)) {
			if (
				typeof sessionState === 'object' &&
				sessionState !== null &&
				(sessionState as LeanTurboRunState).status === 'running' &&
				(sessionState as LeanTurboRunState).phase === phase &&
				(sessionState as LeanTurboRunState).strategy === 'lean'
			) {
				runState = sessionState as LeanTurboRunState;
				break;
			}
		}
	}
	if (!runState) {
		return {
			ok: false,
			reason: sessionID
				? `No active Lean Turbo session for phase ${phase} and session ${sessionID}`
				: `No active Lean Turbo session for phase ${phase}`,
		};
	}

	// ── 2b. Shape guard: lanes and degradedTasks must be arrays ──────────────
	if (!validateLanesArray(runState.lanes)) {
		return {
			ok: false,
			reason: `No active Lean Turbo session for phase ${phase}`,
		};
	}
	if (!validateDegradedTasksArray(runState.degradedTasks)) {
		return {
			ok: false,
			reason: `No active Lean Turbo session for phase ${phase}`,
		};
	}

	// ── 3. Lane plan or fallback tasks exist ────────────────────────────────
	if (
		runState.lanes.length === 0 &&
		(!Array.isArray(runState.serializedTasks) ||
			runState.serializedTasks.length === 0) &&
		(!Array.isArray(runState.degradedTasks) ||
			runState.degradedTasks.length === 0)
	) {
		return {
			ok: false,
			reason: `No lane plan or fallback tasks found for phase ${phase}`,
		};
	}

	// ── 4. All eligible lanes completed ──────────────────────────────────────
	const laneIds = runState.lanes.map((l) => l.laneId);
	if (runState.lanes.length > 0) {
		for (const lane of runState.lanes) {
			// 'failed' is treated as completed for phase readiness purposes
			if (lane.status !== 'completed' && lane.status !== 'failed') {
				return {
					ok: false,
					reason: `Lane ${lane.laneId} is not completed (status: ${lane.status})`,
				};
			}
		}
	} // end if (runState.lanes.length > 0)

	// ── 4b. Lane evidence exists for all completed/failed lanes ──────────────
	if (runState.lanes.length > 0) {
		const evidenceLaneIds = new Set(
			_internals.listLaneEvidenceSync(directory, phase),
		);
		for (const lane of runState.lanes) {
			if (
				(lane.status === 'completed' || lane.status === 'failed') &&
				!evidenceLaneIds.has(lane.laneId)
			) {
				return {
					ok: false,
					reason: `Lane ${lane.laneId} is ${lane.status} but lane evidence file is missing`,
				};
			}
		}
	}

	// ── 5. No active lane locks ──────────────────────────────────────────────
	const activeLocks = _internals.listActiveLocks(directory);
	const phaseLaneIds = new Set(laneIds);
	for (const lock of activeLocks) {
		if (lock.laneId && phaseLaneIds.has(lock.laneId)) {
			return {
				ok: false,
				reason: `Active locks remain for lane ${lock.laneId}`,
			};
		}
	}

	// ── 6. Degraded tasks handled ────────────────────────────────────────────
	// Build set of taskIds covered by lanes
	const laneTaskIds = new Set<string>();
	for (const lane of runState.lanes) {
		if (Array.isArray(lane.taskIds)) {
			for (const taskId of lane.taskIds) {
				laneTaskIds.add(taskId);
			}
		}
	}

	// For each degraded task: if it's in laneTaskIds, lane completion (step 4)
	// already covers it. If NOT in laneTaskIds, it must have been completed via
	// standard serial flow — verify via plan.json.
	//
	// First pass: separate lane-covered degraded tasks from serial-flow tasks.
	const serialDegradedTasks = runState.degradedTasks.filter(
		(dt) => !laneTaskIds.has(dt.taskId),
	);

	// Second pass: only read plan.json if there are degraded tasks not covered by lanes.
	if (serialDegradedTasks.length > 0) {
		const plan = _internals.readPlanJson(directory);
		if (!plan) {
			return {
				ok: false,
				reason:
					'Cannot verify degraded task status: plan.json unreadable or malformed',
			};
		}

		for (const dt of serialDegradedTasks) {
			// Defensive: ensure plan.phases is an array before accessing it
			if (!Array.isArray(plan.phases)) {
				return {
					ok: false,
					reason: `Cannot verify degraded task ${dt.taskId}: plan.json malformed (phases is not an array)`,
				};
			}
			// Not in any lane — must be completed via standard serial flow.
			// Find the task in plan.json for the current phase.
			const planPhase = plan.phases.find(
				(p) => p && typeof p === 'object' && p !== null && p.id === phase,
			);
			if (!planPhase) {
				return {
					ok: false,
					reason: `Cannot verify degraded task ${dt.taskId}: phase ${phase} not found in plan.json`,
				};
			}
			// Defensive: validate planPhase.tasks is an array before searching
			if (!Array.isArray(planPhase.tasks)) {
				return {
					ok: false,
					reason: `Cannot verify degraded task ${dt.taskId}: plan.json malformed (phase ${phase} tasks is not an array)`,
				};
			}
			const task = planPhase.tasks.find(
				(t) => t && typeof t === 'object' && t !== null && t.id === dt.taskId,
			);
			if (!task) {
				return {
					ok: false,
					reason: `Degraded task ${dt.taskId} not found in plan`,
				};
			}
			if (task.status !== 'completed') {
				return {
					ok: false,
					reason: `Degraded task ${dt.taskId} not yet completed via standard flow`,
				};
			}
		}
	}

	// ── 6b. Serialized tasks completed via standard flow ────────────────────
	const serializedTasks = runState.serializedTasks;
	if (Array.isArray(serializedTasks) && serializedTasks.length > 0) {
		const plan = _internals.readPlanJson(directory);
		if (!plan) {
			return {
				ok: false,
				reason:
					'Cannot verify serialized task status: plan.json unreadable or malformed',
			};
		}

		if (!Array.isArray(plan.phases)) {
			return {
				ok: false,
				reason: `Cannot verify serialized tasks: plan.json malformed (phases is not an array)`,
			};
		}

		const planPhase = plan.phases.find(
			(p) => p && typeof p === 'object' && p !== null && p.id === phase,
		);
		if (!planPhase) {
			return {
				ok: false,
				reason: `Cannot verify serialized tasks: phase ${phase} not found in plan.json`,
			};
		}

		if (!Array.isArray(planPhase.tasks)) {
			return {
				ok: false,
				reason: `Cannot verify serialized tasks: plan.json malformed (phase ${phase} tasks is not an array)`,
			};
		}

		for (const serTaskId of serializedTasks) {
			const task = planPhase.tasks.find(
				(t) => t && typeof t === 'object' && t !== null && t.id === serTaskId,
			);
			if (!task) {
				return {
					ok: false,
					reason: `Serialized task ${serTaskId} not found in plan`,
				};
			}
			if (task.status !== 'completed') {
				return {
					ok: false,
					reason: `Serialized task ${serTaskId} not yet completed (status: ${task.status})`,
				};
			}
		}
	}

	// ── 7. Integrated diff evidence (when required) ──────────────────────────
	if (mergedConfig.integrated_diff_required) {
		const evidencePath = path.join(
			directory,
			'.swarm',
			'evidence',
			String(phase),
			'lean-turbo-phase.json',
		);
		let hasDiff = false;
		try {
			const content = fs.readFileSync(evidencePath, 'utf-8');
			const evidence = JSON.parse(content) as Record<string, unknown>;
			hasDiff = !!evidence.integratedDiffSummary;
		} catch {
			// file missing or unreadable
		}
		if (!hasDiff) {
			return {
				ok: false,
				reason: `Integrated diff summary is required but missing for phase ${phase}`,
			};
		}
	}

	// ── 8. Reviewer approval (if configured) ─────────────────────────────────
	let reviewerVerdict = runState.lastReviewerVerdict;
	if (!reviewerVerdict) {
		// Fallback to evidence file when runState doesn't have the verdict
		const evidence = _internals.readReviewerEvidence(directory, phase);
		reviewerVerdict = evidence?.verdict ?? undefined;
	}
	if (mergedConfig.phase_reviewer) {
		if (reviewerVerdict !== 'APPROVED') {
			return {
				ok: false,
				reason: 'Integrated reviewer approval missing or rejected',
			};
		}
	}

	// ── 9. Critic approval (if configured) ───────────────────────────────────
	let criticVerdict = runState.lastCriticVerdict;
	if (!criticVerdict) {
		// Fallback to evidence file when runState doesn't have the verdict
		const evidence = _internals.readCriticEvidence(directory, phase);
		criticVerdict = evidence?.verdict ?? undefined;
	}
	if (mergedConfig.phase_critic) {
		if (criticVerdict !== 'APPROVED') {
			return {
				ok: false,
				reason: 'Integrated critic approval missing or rejected',
			};
		}
	}

	// ── 10. All checks passed ────────────────────────────────────────────────
	return {
		ok: true,
		reason: `Phase ${phase} is ready to advance`,
		evidence: {
			lanes: laneIds,
			degradedTasks: runState.degradedTasks.map((dt) => dt.taskId),
			reviewerVerdict: reviewerVerdict ?? runState.lastReviewerVerdict,
			criticVerdict: criticVerdict ?? runState.lastCriticVerdict,
		},
	};
}
