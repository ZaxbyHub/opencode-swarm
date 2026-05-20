/**
 * Lean Turbo Stage B bypass verification.
 *
 * Provides a synchronous helper to check whether a task is eligible for
 * Lean Turbo Stage B bypass — i.e., whether it can be marked completed
 * without running the full reviewer + test_engineer gate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listActiveLocks } from '../../parallel/file-locks';
import type { LeanTurboPersistedState, LeanTurboRunState } from './state';

/**
 * Test-only seam. Replaces the lock-list function so tests can inject
 * mock results without touching the real `file-locks` module.
 */
export const _internals: {
	listActiveLocks: typeof listActiveLocks;
	verifyLeanTurboTaskCompletion: typeof verifyLeanTurboTaskCompletion;
} = {
	listActiveLocks,
	verifyLeanTurboTaskCompletion,
};

/**
 * Result of the Lean Turbo task completion eligibility check.
 */
export interface LeanTurboTaskCompletionResult {
	ok: boolean;
	reason: string;
	laneFound?: boolean;
	evidence?: {
		laneId: string;
		laneStatus: string;
		taskIds: string[];
	};
}

/**
 * Tier 3 patterns that require full gate review even in Turbo Mode.
 * These are critical security-sensitive files that must always pass Stage B.
 * Copied from src/tools/update-task-status.ts.
 */
const TIER_3_PATTERNS = [
	/^architect.*\.ts$/i,
	/^delegation.*\.ts$/i,
	/^guardrails.*\.ts$/i,
	/^adversarial.*\.ts$/i,
	/^sanitiz.*\.ts$/i,
	/^auth.*$/i,
	/^permission.*$/i,
	/^crypto.*$/i,
	/^secret.*$/i,
	/^security.*\.ts$/i,
];

/**
 * Check if any file in the list matches a Tier 3 pattern.
 */
function matchesTier3Pattern(files: string[]): boolean {
	for (const file of files) {
		const fileName = path.basename(file);
		for (const pattern of TIER_3_PATTERNS) {
			if (pattern.test(fileName)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Synchronously verify whether a task is eligible for Lean Turbo Stage B bypass.
 *
 * Checks are performed in fail-fast order:
 *  1. Read `.swarm/turbo-state.json` — missing/unreadable → ok: false
 *  2. Find a Lean Turbo run state (strategy === 'lean' AND status === 'running')
 *     → none found → ok: false
 *     If sessionID is provided, also require sessionID to match
 *  3. Find the lane containing taskId in runState.lanes → none → ok: false
 *  4. Check if task is in runState.degradedTasks → yes → ok: false with degradation reason
 *  5. Check lane.status === 'completed' → not completed → ok: false
 *  6. Check lane evidence file exists at `.swarm/evidence/{phase}/lean-turbo/{laneId}.json`
 *     → missing → ok: false
 *  7. Check for active file locks on this lane → any active → ok: false
 *  8. Read plan.json to get task's files_touched and check Tier-3 patterns → matched → ok: false
 *  9. All checks pass → ok: true
 *
 * @param directory - Project root directory
 * @param taskId    - Task ID to verify
 * @param sessionID - Optional session ID to scope which Lean Turbo session may grant bypass.
 *                    When provided, only a running Lean Turbo session with a matching sessionID
 *                    can grant bypass — preventing cross-session Stage B bypass.
 */
export function verifyLeanTurboTaskCompletion(
	directory: string,
	taskId: string,
	sessionID?: string,
): LeanTurboTaskCompletionResult {
	// ── 1. Read turbo-state.json ──────────────────────────────────────────────
	let persisted: LeanTurboPersistedState | null = null;
	try {
		const statePath = path.join(directory, '.swarm', 'turbo-state.json');
		if (!fs.existsSync(statePath)) {
			return {
				ok: false,
				reason: 'Lean Turbo state file not found',
			};
		}
		const raw = fs.readFileSync(statePath, 'utf-8');
		persisted = JSON.parse(raw) as LeanTurboPersistedState;
	} catch {
		return {
			ok: false,
			reason: 'Lean Turbo state file unreadable or malformed',
		};
	}

	// ── 1b. Shape guard: persisted.sessions must be a valid object ───────────
	if (
		typeof persisted !== 'object' ||
		persisted === null ||
		typeof persisted.sessions !== 'object' ||
		persisted.sessions === null ||
		Array.isArray(persisted.sessions)
	) {
		return {
			ok: false,
			reason: 'Lean Turbo state malformed: missing expected fields',
		};
	}

	// ── 2. Find Lean Turbo run state (strategy === 'lean' AND status === 'running') ─
	// When sessionID is provided, also require sessionID to match to prevent cross-session bypass.
	let runState: LeanTurboRunState | null = null;
	for (const sessionState of Object.values(persisted.sessions)) {
		if (
			typeof sessionState === 'object' &&
			sessionState !== null &&
			sessionState.strategy === 'lean' &&
			sessionState.status === 'running'
		) {
			// If sessionID is provided, require it to match
			if (sessionID !== undefined && sessionState.sessionID !== sessionID) {
				continue;
			}
			runState = sessionState as LeanTurboRunState;
			break;
		}
	}
	if (!runState) {
		return {
			ok: false,
			reason: 'No active Lean Turbo run state found',
		};
	}

	// ── 2b. Shape guard: runState.lanes and runState.degradedTasks must be arrays
	if (
		!Array.isArray(runState.lanes) ||
		!Array.isArray(runState.degradedTasks)
	) {
		return {
			ok: false,
			reason: 'Lean Turbo state malformed: missing expected fields',
		};
	}

	// ── 3. Find lane containing taskId ────────────────────────────────────────
	const lane = runState.lanes.find(
		(l) =>
			typeof l === 'object' &&
			l !== null &&
			Array.isArray(l.taskIds) &&
			typeof l.laneId === 'string' &&
			l.taskIds.includes(taskId),
	);
	if (!lane) {
		return {
			ok: false,
			reason: `Task ${taskId} not found in any Lean Turbo lane`,
			laneFound: false,
		};
	}

	// ── 4. Check degraded tasks ────────────────────────────────────────────────
	const degradedTask = runState.degradedTasks.find(
		(dt) => typeof dt === 'object' && dt !== null && dt.taskId === taskId,
	);
	if (degradedTask) {
		return {
			ok: false,
			reason: `Task ${taskId} is degraded: ${degradedTask.reason}`,
			laneFound: true,
		};
	}

	// ── 5. Check lane status === 'completed' ──────────────────────────────────
	if (lane.status !== 'completed') {
		return {
			ok: false,
			reason: `Lane ${lane.laneId} is not completed (status: ${lane.status})`,
			laneFound: true,
			evidence: {
				laneId: lane.laneId,
				laneStatus: lane.status,
				taskIds: lane.taskIds,
			},
		};
	}

	// ── 6. Check lane evidence file exists ───────────────────────────────────
	// Validate laneId to prevent path traversal attacks
	if (
		lane.laneId.length === 0 ||
		lane.laneId.includes('/') ||
		lane.laneId.includes('\\') ||
		lane.laneId.includes('..')
	) {
		return {
			ok: false,
			reason: `Lane ID contains invalid characters: ${lane.laneId}`,
			laneFound: true,
			evidence: {
				laneId: lane.laneId,
				laneStatus: lane.status,
				taskIds: lane.taskIds,
			},
		};
	}

	const phase = runState.phase ?? 0;
	const evidencePath = path.join(
		directory,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
		`${lane.laneId}.json`,
	);

	// Verify the resolved path is contained within the expected directory
	const expectedDir = path.join(
		directory,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
	const resolvedPath = path.resolve(evidencePath);
	const resolvedDir = path.resolve(expectedDir);
	if (
		!resolvedPath.startsWith(resolvedDir + path.sep) &&
		resolvedPath !== resolvedDir
	) {
		return {
			ok: false,
			reason: `Lane ID causes path traversal: ${lane.laneId}`,
			laneFound: true,
			evidence: {
				laneId: lane.laneId,
				laneStatus: lane.status,
				taskIds: lane.taskIds,
			},
		};
	}

	if (!fs.existsSync(evidencePath)) {
		return {
			ok: false,
			reason: `Lane ${lane.laneId} evidence file not found: ${evidencePath}`,
			laneFound: true,
			evidence: {
				laneId: lane.laneId,
				laneStatus: lane.status,
				taskIds: lane.taskIds,
			},
		};
	}

	// ── 7. Check for active file locks on this lane ───────────────────────────
	const activeLocks = _internals.listActiveLocks(directory);
	const laneLocks = activeLocks.filter((lock) => lock.laneId === lane.laneId);
	if (laneLocks.length > 0) {
		return {
			ok: false,
			reason: `Active file locks exist for lane ${lane.laneId}: ${laneLocks.map((l) => l.filePath).join(', ')}`,
			laneFound: true,
			evidence: {
				laneId: lane.laneId,
				laneStatus: lane.status,
				taskIds: lane.taskIds,
			},
		};
	}

	// ── 8. Check Tier-3 patterns against plan.json files_touched ─────────────
	let filesTouched: string[] = [];
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const planRaw = fs.readFileSync(planPath, 'utf-8');
		const plan = JSON.parse(planRaw) as {
			phases: Array<{
				tasks: Array<{
					id: string;
					files_touched?: string[];
				}>;
			}>;
		};
		for (const planPhase of plan.phases ?? []) {
			for (const task of planPhase.tasks ?? []) {
				if (task.id === taskId && task.files_touched) {
					filesTouched = task.files_touched;
					break;
				}
			}
		}
	} catch {
		// plan.json missing or unreadable — Tier-3 check cannot proceed, fail closed
		return {
			ok: false,
			reason: `Cannot verify Tier-3 patterns for task ${taskId}: plan.json unreadable`,
			laneFound: true,
			evidence: {
				laneId: lane.laneId,
				laneStatus: lane.status,
				taskIds: lane.taskIds,
			},
		};
	}

	if (filesTouched.length > 0 && matchesTier3Pattern(filesTouched)) {
		return {
			ok: false,
			reason: `Task ${taskId} touches Tier-3 security-sensitive files and cannot bypass Stage B`,
			laneFound: true,
			evidence: {
				laneId: lane.laneId,
				laneStatus: lane.status,
				taskIds: lane.taskIds,
			},
		};
	}

	// ── 9. All checks passed ──────────────────────────────────────────────────
	return {
		ok: true,
		reason: `Task ${taskId} in completed lane ${lane.laneId}`,
		laneFound: true,
		evidence: {
			laneId: lane.laneId,
			laneStatus: lane.status,
			taskIds: lane.taskIds,
		},
	};
}
