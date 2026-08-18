/**
 * Session snapshot writer for OpenCode Swarm plugin.
 * Serializes swarmState to .swarm/session/state.json using atomic write (temp-file + rename).
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	unlinkSync,
} from 'node:fs';
import { rename as fsRename } from 'node:fs/promises';
import * as path from 'node:path';
import { TASK_WORKFLOW_SCHEMA_MARKER } from '../gate-evidence.js';
import { validateSwarmPath } from '../hooks/utils';
import type {
	AgentSessionState,
	DelegationEntry,
	ToolAggregate,
} from '../state';
import { swarmState } from '../state';
import { log } from '../utils';
import { bunWrite } from '../utils/bun-compat';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';

/**
 * v6.35.4: In-flight write guard.
 * Prevents concurrent atomic renames from colliding when multiple tool.execute.after
 * hooks fire simultaneously.  State is written immediately on each call; the guard
 * ensures only one write is in flight at a time so the last writer wins.
 */
let _writeInFlight: Promise<void> = Promise.resolve();

/**
 * Windows can transiently fail a rename with EEXIST/EBUSY/EPERM while another
 * process (an external snapshot reader, an AV scanner) briefly holds the
 * target open. Mirrors the retry policy in `bunWrite`
 * (src/utils/bun-compat.ts:36) — kept local rather than imported so this
 * module adds no new bun-compat exports for existing non-spread
 * `mock.module('../utils/bun-compat', ...)` test factories to miss.
 */
export const SNAPSHOT_RENAME_MAX_ATTEMPTS = 3;
const SNAPSHOT_RENAME_RETRY_DELAY_MS = 50;

/**
 * Atomic swap for the snapshot temp file, retrying the transient Windows
 * sharing violations. A bare rename converts an external reader briefly
 * holding `state.json` open into silent snapshot staleness: `writeSnapshot`'s
 * catch only logs, so the update is dropped while the in-memory state moves
 * on. Any non-transient code fails immediately — retrying an EACCES or
 * ENOENT would only delay the log.
 *
 * Throws the last rename error when the budget is exhausted; the caller owns
 * temp-file cleanup and error swallowing.
 */
async function renameWithTransientRetry(
	tempPath: string,
	targetPath: string,
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < SNAPSHOT_RENAME_MAX_ATTEMPTS; attempt++) {
		try {
			await _internals.rename(tempPath, targetPath);
			return;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			// Windows can report a sharing violation for a rename that actually
			// committed, so a retry then finds the source already gone. Treating
			// that as a failure would skip the caller's cache invalidation for a
			// file that really did change — the precise stale-read the #1729
			// invalidation exists to prevent. Only a retry can observe this, so
			// the check is scoped to attempt > 0.
			if (
				code === 'ENOENT' &&
				attempt > 0 &&
				!existsSync(tempPath) &&
				existsSync(targetPath)
			) {
				return;
			}
			if (code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EPERM') {
				break;
			}
			// No point sleeping after the final attempt — nothing follows it.
			if (attempt < SNAPSHOT_RENAME_MAX_ATTEMPTS - 1) {
				await new Promise((resolve) =>
					setTimeout(resolve, SNAPSHOT_RENAME_RETRY_DELAY_MS),
				);
			}
		}
	}
	throw lastError;
}

/**
 * Serialized form of AgentSessionState with Map/Set fields converted to plain arrays/objects
 */
export interface SerializedAgentSession {
	agentName: string;
	lastToolCallTime: number;
	lastAgentEventTime: number;
	delegationActive: boolean;
	activeInvocationId: number;
	lastInvocationIdByAgent: Record<string, number>;
	windows: Record<string, SerializedInvocationWindow>;
	lastCompactionHint: number;
	architectWriteCount: number;
	lastCoderDelegationTaskId: string | null;
	currentTaskId: string | null;
	turboMode: boolean;
	turboStrategy?: 'standard' | 'lean';
	leanTurboActive?: boolean;
	leanTurboCurrentPhase?: number;
	epicModeActive?: boolean;
	gateLog: Record<string, string[]>;
	reviewerCallCount: Record<string, number>;
	lastGateFailure: {
		tool: string;
		taskId: string;
		timestamp: number;
		code?: string;
	} | null;
	partialGateWarningsIssuedForTask: string[];
	completionGateWarnedForTask: string[];
	selfFixAttempted: boolean;
	selfCodingWarnedAtCount: number;
	catastrophicPhaseWarnings: number[];
	lastPhaseCompleteTimestamp: number;
	lastPhaseCompletePhase: number;
	phaseAgentsDispatched: string[];
	lastCompletedPhaseAgentsDispatched: string[];
	qaSkipCount: number;
	qaSkipTaskIds: string[];
	pendingAdvisoryMessages: string[];
	taskWorkflowStates?: Record<string, string>;
	/** Task-keyed coder file attribution. Optional for backward compatibility. */
	modifiedFilesByTask?: Record<string, string[]>;
	/** Flag for one-shot scope violation warning injection (omitted when undefined for additive-only schema) */
	scopeViolationDetected?: boolean;
	/** Current index into the fallback_models array (v6.33) */
	model_fallback_index: number;
	/** Flag set when all fallback models have been exhausted (v6.33) */
	modelFallbackExhausted: boolean;
	/** Number of coder revisions in the current task (v6.33) */
	coderRevisions: number;
	/** Flag set when coder revisions hit the configured ceiling (v6.33) */
	revisionLimitHit: boolean;
	/** Session-scoped Full Auto flag for autonomous multi-agent oversight (Phase 2) */
	fullAutoMode?: boolean;
	/** Count of full-auto interactions this phase (Phase 2) */
	fullAutoInteractionCount?: number;
	/** Count of detected deadlocks in full-auto mode (Phase 2) */
	fullAutoDeadlockCount?: number;
	/** Hash of last question asked in full-auto mode (Phase 2) */
	fullAutoLastQuestionHash?: string | null;
	/** Timestamp when session was rehydrated from snapshot (0 if never rehydrated) */
	sessionRehydratedAt?: number;
	/** Stage B completion tracking: per-task set of completed Stage B agents. Optional for backward compat with old snapshots. */
	stageBCompletion?: Record<string, string[]>;
	/** Session-scoped concurrency override for max_concurrent_tasks (Issue #761) */
	maxConcurrencyOverride?: number;
	/** Session-level auto-proceed override (Phase 1) */
	autoProceedOverride?: boolean;
	/** Flag tracking whether the auto-proceed nudge has been shown (Phase 1) */
	autoProceedNudgeDone?: boolean;
	/**
	 * Cached canonical cohort id (issue #1849). Omitted on disk when undefined
	 * so older snapshots deserialize cleanly; the reader defaults to undefined.
	 */
	cachedCohortId?: string;
	/**
	 * Last observed `provider/model` for this (architect) session (#1896). Omitted
	 * when undefined for additive-only schema. MUST survive rehydration (it is NOT
	 * a transient-reset field) so a silent cross-interrupt model switch is
	 * detectable on resume.
	 */
	lastObservedModel?: string;
	/** Provider id paired with lastObservedModel (#1896). Omitted when undefined. */
	lastObservedProviderID?: string;
}

/**
 * Minimal interface for serialized InvocationWindow
 */
export interface SerializedInvocationWindow {
	id: number;
	agentName: string;
	startedAtMs: number;
	toolCalls: number;
	consecutiveErrors: number;
	hardLimitHit: boolean;
	lastSuccessTimeMs: number;
	recentToolCalls: Array<{ tool: string; argsHash: number; timestamp: number }>;
	warningIssued: boolean;
	warningReason: string;
	transientRetryCount: number;
}

/**
 * Snapshot data structure written to disk
 */
export interface SnapshotData {
	version: 1 | 2 | 3;
	writtenAt: number;
	workflowSchema?: typeof TASK_WORKFLOW_SCHEMA_MARKER;
	toolAggregates: Record<string, ToolAggregate>;
	activeAgent: Record<string, string>;
	delegationChains: Record<string, DelegationEntry[]>;
	agentSessions: Record<string, SerializedAgentSession>;
}

/**
 * Convert a live AgentSessionState to its serialized form.
 * Handles missing/undefined Map/Set fields gracefully (migration safety).
 */
export function serializeAgentSession(
	s: AgentSessionState,
): SerializedAgentSession {
	// Convert gateLog: Map<string, Set<string>> -> Record<string, string[]>
	const gateLog: Record<string, string[]> = {};
	const rawGateLog = s.gateLog ?? new Map();
	for (const [taskId, gates] of rawGateLog) {
		gateLog[taskId] = Array.from(gates ?? []);
	}

	// Convert reviewerCallCount: Map<number, number> -> Record<string, number>
	const reviewerCallCount: Record<string, number> = {};
	const rawReviewerCallCount = s.reviewerCallCount ?? new Map();
	for (const [phase, count] of rawReviewerCallCount) {
		reviewerCallCount[String(phase)] = count;
	}

	// Convert partialGateWarningsIssuedForTask: Set<string> -> string[]
	const partialGateWarningsIssuedForTask = Array.from(
		s.partialGateWarningsIssuedForTask ?? new Set(),
	);

	// Convert completionGateWarnedForTask: Set<string> -> string[]
	const completionGateWarnedForTask = Array.from(
		s.completionGateWarnedForTask ?? new Set(),
	);

	// Convert catastrophicPhaseWarnings: Set<number> -> number[]
	const catastrophicPhaseWarnings = Array.from(
		s.catastrophicPhaseWarnings ?? new Set(),
	);

	// Convert phaseAgentsDispatched: Set<string> -> string[]
	const phaseAgentsDispatched = Array.from(
		s.phaseAgentsDispatched ?? new Set(),
	);

	// Convert lastCompletedPhaseAgentsDispatched: Set<string> -> string[]
	const lastCompletedPhaseAgentsDispatched = Array.from(
		s.lastCompletedPhaseAgentsDispatched ?? new Set(),
	);

	// Convert stageBCompletion: Map<string, Set<string>> -> Record<string, string[]>
	const stageBCompletion: Record<string, string[]> = {};
	if (s.stageBCompletion) {
		for (const [taskId, agents] of s.stageBCompletion) {
			stageBCompletion[taskId] = Array.from(agents);
		}
	}

	const modifiedFilesByTask: Record<string, string[]> = Object.create(null);
	for (const [taskId, files] of s.modifiedFilesByTask ?? new Map()) {
		modifiedFilesByTask[taskId] = [...files];
	}

	// Convert windows: Record<string, InvocationWindow> (already serializable)
	const windows: Record<string, SerializedInvocationWindow> = {};
	const rawWindows = s.windows ?? {};
	for (const [key, win] of Object.entries(rawWindows)) {
		windows[key] = {
			id: win.id,
			agentName: win.agentName,
			startedAtMs: win.startedAtMs,
			toolCalls: win.toolCalls,
			consecutiveErrors: win.consecutiveErrors,
			hardLimitHit: win.hardLimitHit,
			lastSuccessTimeMs: win.lastSuccessTimeMs,
			recentToolCalls: win.recentToolCalls,
			warningIssued: win.warningIssued,
			warningReason: win.warningReason,
			transientRetryCount: win.transientRetryCount ?? 0,
		};
	}

	return {
		agentName: s.agentName,
		lastToolCallTime: s.lastToolCallTime,
		lastAgentEventTime: s.lastAgentEventTime,
		delegationActive: s.delegationActive,
		activeInvocationId: s.activeInvocationId,
		lastInvocationIdByAgent: s.lastInvocationIdByAgent ?? {},
		windows,
		lastCompactionHint: s.lastCompactionHint ?? 0,
		architectWriteCount: s.architectWriteCount ?? 0,
		lastCoderDelegationTaskId: s.lastCoderDelegationTaskId ?? null,
		currentTaskId: s.currentTaskId ?? null,
		turboMode: s.turboMode ?? false,
		...(s.turboStrategy !== undefined && { turboStrategy: s.turboStrategy }),
		leanTurboActive: s.leanTurboActive ?? false,
		...(s.leanTurboCurrentPhase !== undefined && {
			leanTurboCurrentPhase: s.leanTurboCurrentPhase,
		}),
		epicModeActive: s.epicModeActive ?? false,
		gateLog,
		reviewerCallCount,
		lastGateFailure: s.lastGateFailure ?? null,
		partialGateWarningsIssuedForTask,
		completionGateWarnedForTask,
		selfFixAttempted: s.selfFixAttempted ?? false,
		selfCodingWarnedAtCount: s.selfCodingWarnedAtCount ?? 0,
		catastrophicPhaseWarnings,
		lastPhaseCompleteTimestamp: s.lastPhaseCompleteTimestamp ?? 0,
		lastPhaseCompletePhase: s.lastPhaseCompletePhase ?? 0,
		phaseAgentsDispatched,
		lastCompletedPhaseAgentsDispatched,
		qaSkipCount: s.qaSkipCount ?? 0,
		qaSkipTaskIds: s.qaSkipTaskIds ?? [],
		pendingAdvisoryMessages: s.pendingAdvisoryMessages ?? [],
		taskWorkflowStates: Object.fromEntries(s.taskWorkflowStates ?? new Map()),
		...(Object.keys(modifiedFilesByTask).length > 0 && {
			modifiedFilesByTask,
		}),
		...(s.scopeViolationDetected !== undefined && {
			scopeViolationDetected: s.scopeViolationDetected,
		}),
		model_fallback_index: s.model_fallback_index ?? 0,
		modelFallbackExhausted: s.modelFallbackExhausted ?? false,
		coderRevisions: s.coderRevisions ?? 0,
		revisionLimitHit: s.revisionLimitHit ?? false,
		fullAutoMode: s.fullAutoMode ?? false,
		fullAutoInteractionCount: s.fullAutoInteractionCount ?? 0,
		fullAutoDeadlockCount: s.fullAutoDeadlockCount ?? 0,
		fullAutoLastQuestionHash: s.fullAutoLastQuestionHash ?? null,
		sessionRehydratedAt: s.sessionRehydratedAt ?? 0,
		...(Object.keys(stageBCompletion).length > 0 && { stageBCompletion }),
		...(s.maxConcurrencyOverride !== undefined && {
			maxConcurrencyOverride: s.maxConcurrencyOverride,
		}),
		...(s.autoProceedOverride !== undefined && {
			autoProceedOverride: s.autoProceedOverride,
		}),
		...(s.autoProceedNudgeDone !== undefined && {
			autoProceedNudgeDone: s.autoProceedNudgeDone,
		}),
		...(s.cachedCohortId !== undefined && {
			cachedCohortId: s.cachedCohortId,
		}),
		...(s.lastObservedModel !== undefined && {
			lastObservedModel: s.lastObservedModel,
		}),
		...(s.lastObservedProviderID !== undefined && {
			lastObservedProviderID: s.lastObservedProviderID,
		}),
	};
}

/**
 * Write a snapshot of swarmState to .swarm/session/state.json atomically.
 * Silently swallows errors (non-fatal — never crash the plugin).
 */
export async function writeSnapshot(
	directory: string,
	state: typeof swarmState,
): Promise<void> {
	try {
		// Build SnapshotData object from state
		const snapshot: SnapshotData = {
			version: 3,
			writtenAt: Date.now(),
			workflowSchema: TASK_WORKFLOW_SCHEMA_MARKER,
			toolAggregates: Object.fromEntries(state.toolAggregates),
			activeAgent: Object.fromEntries(state.activeAgent),
			delegationChains: Object.fromEntries(state.delegationChains),
			agentSessions: {},
		};

		// Serialize each agent session
		for (const [sessionId, sessionState] of state.agentSessions) {
			snapshot.agentSessions[sessionId] = serializeAgentSession(sessionState);
		}

		// Serialize to JSON
		const content = JSON.stringify(snapshot, null, 2);

		// Get the resolved path for the state.json file
		const resolvedPath = validateSwarmPath(directory, 'session/state.json');

		// Ensure directory exists
		const dir = path.dirname(resolvedPath);
		mkdirSync(dir, { recursive: true });

		// Atomic write: write to temp file then rename
		const tempPath = `${resolvedPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
		await bunWrite(tempPath, content);
		// FR-004: fsync the temp file so the rename below cannot leave us with
		// an empty or partial canonical file on power-loss / kill -9.
		try {
			const fd = openSync(tempPath, 'r+');
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch {
			// fsync is best-effort; OSes / filesystems that don't support it
			// (e.g. tmpfs, ramdisk) shouldn't block the main path.
		}
		try {
			await renameWithTransientRetry(tempPath, resolvedPath);
		} finally {
			// No-op after a successful swap (the temp path no longer exists);
			// drops the orphan when every retry failed, so a persistently locked
			// target cannot litter .swarm/session with one .tmp file per
			// tool.execute.after. Mirrors src/evidence/task-file.ts:atomicWriteFile.
			try {
				unlinkSync(tempPath);
			} catch {
				/* already renamed or never created */
			}
		}
		// Only after a SUCCESSFUL rename. `session/state.json` is read through the
		// cached reader (`readSwarmFileAsync(directory, 'session/state.json')` at
		// src/services/handoff-service.ts:376), and this writer runs on every
		// tool.execute.after — a snapshot whose only delta is a counter or a
		// timestamp field of identical width is the SAME SIZE as its predecessor,
		// which the cache's stat stamp (mtime+ctime+size) cannot distinguish from
		// "unchanged" inside one filesystem timestamp tick (issue #1729).
		invalidateCachedArtifact(resolvedPath);
	} catch (error) {
		log('[snapshot-writer] write failed', {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Create a snapshot writer hook suitable for use in tool.execute.after.
 * Writes state immediately on every call.  Concurrent calls are serialised so
 * the last writer wins without producing a corrupt interleaved file.
 */
export function createSnapshotWriterHook(
	directory: string,
): (input: unknown, output: unknown) => Promise<void> {
	return (_input: unknown, _output: unknown): Promise<void> => {
		// Chain writes so concurrent calls don't race on the temp-rename sequence.
		// Each write sees the latest swarmState snapshot at the moment it runs.
		_writeInFlight = _writeInFlight.then(
			() => _internals.writeSnapshot(directory, swarmState),
			() => _internals.writeSnapshot(directory, swarmState),
		);
		return _writeInFlight;
	};
}

/**
 * v6.35.4: Flush any in-flight snapshot write.
 * Called by phase-complete and handoff to ensure critical state transitions
 * are persisted before returning.
 */
export async function flushPendingSnapshot(directory: string): Promise<void> {
	// Trigger a fresh write and wait for it (and any already-in-flight write) to finish.
	_writeInFlight = _writeInFlight.then(
		() => _internals.writeSnapshot(directory, swarmState),
		() => _internals.writeSnapshot(directory, swarmState),
	);
	await _writeInFlight;
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	writeSnapshot: typeof writeSnapshot;
	createSnapshotWriterHook: typeof createSnapshotWriterHook;
	flushPendingSnapshot: typeof flushPendingSnapshot;
	rename: typeof fsRename;
} = {
	writeSnapshot,
	createSnapshotWriterHook,
	flushPendingSnapshot,
	rename: fsRename,
} as const;
