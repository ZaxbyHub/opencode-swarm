/**
 * Session snapshot writer for OpenCode Swarm plugin.
 * Serializes swarmState to .swarm/session/state.json using atomic write (temp-file + rename).
 */

import { mkdirSync, renameSync } from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import type {
	AgentSessionState,
	DelegationEntry,
	ToolAggregate,
} from '../state';
import { swarmState } from '../state';
import { log } from '../utils';
import { bunWrite } from '../utils/bun-compat';

/**
 * v6.35.4: In-flight write guard.
 * Prevents concurrent atomic renames from colliding when multiple tool.execute.after
 * hooks fire simultaneously.  State is written immediately on each call; the guard
 * ensures only one write is in flight at a time so the last writer wins.
 */
let _writeInFlight: Promise<void> = Promise.resolve();

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
	gateLog: Record<string, string[]>;
	reviewerCallCount: Record<string, number>;
	lastGateFailure: { tool: string; taskId: string; timestamp: number } | null;
	partialGateWarningsIssuedForTask: string[];
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
	version: 1 | 2;
	writtenAt: number;
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
		gateLog,
		reviewerCallCount,
		lastGateFailure: s.lastGateFailure ?? null,
		partialGateWarningsIssuedForTask,
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
			version: 2,
			writtenAt: Date.now(),
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
		renameSync(tempPath, resolvedPath);
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
} = {
	writeSnapshot,
	createSnapshotWriterHook,
	flushPendingSnapshot,
} as const;
