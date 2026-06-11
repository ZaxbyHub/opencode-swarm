/**
 * Session snapshot reader for OpenCode Swarm plugin.
 * Reads .swarm/session/state.json and rehydrates swarmState on plugin init.
 */

import { renameSync } from 'node:fs';
import { validateSwarmPath } from '../hooks/utils';
import type { AgentSessionState, TaskWorkflowState } from '../state';
import {
	applyRehydrationCache,
	buildRehydrationCache,
	swarmState,
} from '../state';
import { bunFile } from '../utils/bun-compat';
import type {
	SerializedAgentSession,
	SerializedInvocationWindow,
	SnapshotData,
} from './snapshot-writer';

/**
 * Transient session fields that must be reset on rehydration.
 * Centralised here to keep the reset logic DRY and auditable.
 */
export const TRANSIENT_SESSION_FIELDS: ReadonlyArray<{
	name: string;
	resetValue: unknown;
}> = [
	{ name: 'revisionLimitHit', resetValue: false },
	{ name: 'coderRevisions', resetValue: 0 },
	{ name: 'selfFixAttempted', resetValue: false },
	{ name: 'lastGateFailure', resetValue: null },
	{ name: 'architectWriteCount', resetValue: 0 },
	{ name: 'selfCodingWarnedAtCount', resetValue: 0 },
	{ name: 'pendingAdvisoryMessages', resetValue: [] },
	{ name: 'model_fallback_index', resetValue: 0 },
	{ name: 'modelFallbackExhausted', resetValue: false },
	{ name: 'scopeViolationDetected', resetValue: false },
	{ name: 'delegationActive', resetValue: false },
	{ name: 'autoProceedOverride', resetValue: undefined },
	{ name: 'autoProceedNudgeDone', resetValue: undefined },
] as const;

const VALID_TASK_WORKFLOW_STATES: TaskWorkflowState[] = [
	'idle',
	'coder_delegated',
	'pre_check_passed',
	'reviewer_run',
	'tests_run',
	'complete',
];

/**
 * Deserialize taskWorkflowStates from a serialized Record<string, string> to Map.
 * Validates each value against VALID_TASK_WORKFLOW_STATES and skips invalid entries.
 */
function deserializeTaskWorkflowStates(
	raw: Record<string, string> | undefined,
): Map<string, TaskWorkflowState> {
	const m = new Map<string, TaskWorkflowState>();
	if (!raw || typeof raw !== 'object') {
		return m;
	}
	for (const [taskId, stateVal] of Object.entries(raw)) {
		if (VALID_TASK_WORKFLOW_STATES.includes(stateVal as TaskWorkflowState)) {
			m.set(taskId, stateVal as TaskWorkflowState);
		}
	}
	return m;
}

/**
 * Deserialize a SerializedAgentSession back to AgentSessionState.
 * Handles Map/Set conversion and migration safety defaults.
 */
export function deserializeAgentSession(
	s: SerializedAgentSession,
): AgentSessionState {
	// Convert gateLog: Record<string, string[]> -> Map<string, Set<string>>
	const gateLog = new Map<string, Set<string>>();
	if (s.gateLog) {
		for (const [taskId, gates] of Object.entries(s.gateLog)) {
			gateLog.set(taskId, new Set(gates ?? []));
		}
	}

	// Convert reviewerCallCount: Record<string, number> -> Map<number, number>
	const reviewerCallCount = new Map<number, number>();
	if (s.reviewerCallCount) {
		for (const [phase, count] of Object.entries(s.reviewerCallCount)) {
			const numPhase = Number(phase);
			if (Number.isFinite(numPhase)) {
				reviewerCallCount.set(numPhase, count);
			}
		}
	}

	// Convert partialGateWarningsIssuedForTask: string[] -> Set<string>
	const partialGateWarningsIssuedForTask = new Set(
		s.partialGateWarningsIssuedForTask ?? [],
	);

	// Convert catastrophicPhaseWarnings: number[] -> Set<number>
	const catastrophicPhaseWarnings = new Set(s.catastrophicPhaseWarnings ?? []);

	// Convert phaseAgentsDispatched: string[] -> Set<string>
	const phaseAgentsDispatched = new Set(s.phaseAgentsDispatched ?? []);

	// Convert lastCompletedPhaseAgentsDispatched: string[] -> Set<string>
	const lastCompletedPhaseAgentsDispatched = new Set(
		s.lastCompletedPhaseAgentsDispatched ?? [],
	);

	// Convert stageBCompletion: Record<string, string[]> -> Map<string, Set<'reviewer' | 'test_engineer'>>
	const stageBCompletion = new Map<string, Set<'reviewer' | 'test_engineer'>>();
	if (s.stageBCompletion) {
		for (const [taskId, agents] of Object.entries(s.stageBCompletion)) {
			stageBCompletion.set(
				taskId,
				new Set(agents as Array<'reviewer' | 'test_engineer'>),
			);
		}
	}

	// Migration: ensure transientRetryCount exists on all windows (v6.86.14)
	const windows: Record<string, SerializedInvocationWindow> = {};
	for (const [key, win] of Object.entries(s.windows ?? {})) {
		if (!win || typeof win !== 'object') {
			continue;
		}
		windows[key] = {
			...win,
			transientRetryCount:
				'transientRetryCount' in win
					? (((win as unknown as Record<string, unknown>)
							.transientRetryCount as number) ?? 0)
					: 0,
		} as SerializedInvocationWindow;
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
		taskWorkflowStates: deserializeTaskWorkflowStates(s.taskWorkflowStates),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		scopeViolationDetected: s.scopeViolationDetected,
		modifiedFilesThisCoderTask: [],
		loopDetectionWindow: [],
		pendingAdvisoryMessages: s.pendingAdvisoryMessages ?? [],
		model_fallback_index: s.model_fallback_index ?? 0,
		modelFallbackExhausted: s.modelFallbackExhausted ?? false,
		coderRevisions: s.coderRevisions ?? 0,
		revisionLimitHit: s.revisionLimitHit ?? false,
		fullAutoMode: s.fullAutoMode ?? false,
		fullAutoInteractionCount: s.fullAutoInteractionCount ?? 0,
		fullAutoDeadlockCount: s.fullAutoDeadlockCount ?? 0,
		fullAutoLastQuestionHash: s.fullAutoLastQuestionHash ?? null,
		maxConcurrencyOverride:
			typeof s.maxConcurrencyOverride === 'number'
				? Math.min(64, Math.max(1, s.maxConcurrencyOverride))
				: undefined,
		autoProceedOverride: s.autoProceedOverride,
		autoProceedNudgeDone: s.autoProceedNudgeDone,
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		sessionRehydratedAt: s.sessionRehydratedAt ?? 0,
		stageBCompletion,
		prSubscriptions: new Map(),
	};
}

/**
 * Read the snapshot file from .swarm/session/state.json.
 * Returns null if file doesn't exist, parse fails, or version is wrong.
 * NEVER throws - always returns null on any error.
 */
export async function readSnapshot(
	directory: string,
): Promise<SnapshotData | null> {
	try {
		const resolvedPath = validateSwarmPath(directory, 'session/state.json');
		const file = bunFile(resolvedPath);
		const content = await file.text();

		// Check if file is empty or just whitespace
		if (!content.trim()) {
			return null;
		}

		const parsed = JSON.parse(content, (key, value) => {
			if (key === '__proto__' || key === 'constructor') return undefined;
			return value;
		}) as SnapshotData;

		// Validate version — quarantine incompatible snapshots so they are not
		// re-read on every subsequent restart.
		if (parsed.version !== 1 && parsed.version !== 2) {
			try {
				const quarantinePath = validateSwarmPath(
					directory,
					'session/state.json.quarantine',
				);
				// Rename the stale file.  Errors are swallowed — the important
				// thing is that we return null so the caller starts fresh.
				renameSync(resolvedPath, quarantinePath);
			} catch {
				// Quarantine rename failed — not fatal, still return null below.
			}
			return null;
		}

		return parsed;
	} catch {
		// File doesn't exist, parse fails, or any other error - return null
		return null;
	}
}

/**
 * Rehydrate swarmState from a SnapshotData object.
 * Clears existing maps first, then populates from snapshot.
 * Does NOT touch activeToolCalls or pendingEvents (remain at defaults).
 */
export async function rehydrateState(snapshot: SnapshotData): Promise<void> {
	// Await any in-flight rehydrations before clearing agentSessions.
	// This prevents a race where startAgentSession fires rehydrateSessionFromDisk
	// and rehydrateState clears the map before it completes.
	// Errors are already swallowed inside each pending promise.
	if (swarmState.pendingRehydrations.size > 0) {
		await Promise.allSettled([...swarmState.pendingRehydrations]);
	}

	// Clear existing maps first to prevent data leakage
	swarmState.toolAggregates.clear();
	swarmState.activeAgent.clear();
	swarmState.delegationChains.clear();
	swarmState.agentSessions.clear();

	// Populate toolAggregates
	if (snapshot.toolAggregates) {
		for (const [key, value] of Object.entries(snapshot.toolAggregates)) {
			swarmState.toolAggregates.set(key, value);
		}
	}

	// Populate activeAgent
	if (snapshot.activeAgent) {
		for (const [key, value] of Object.entries(snapshot.activeAgent)) {
			swarmState.activeAgent.set(key, value);
		}
	}

	// Populate delegationChains
	if (snapshot.delegationChains) {
		for (const [key, value] of Object.entries(snapshot.delegationChains)) {
			swarmState.delegationChains.set(key, value);
		}
	}

	// Populate agentSessions with deserialized data
	// v6.33.1: Skip malformed sessions missing required fields instead of injecting bad state
	// v6.33.3: Refresh timestamps to prevent immediate stale eviction after rehydration
	const now = Date.now();
	if (snapshot.agentSessions) {
		for (const [sessionId, serializedSession] of Object.entries(
			snapshot.agentSessions,
		)) {
			// Validate required fields exist before deserializing
			if (
				!serializedSession ||
				typeof serializedSession !== 'object' ||
				typeof serializedSession.agentName !== 'string' ||
				typeof serializedSession.lastToolCallTime !== 'number' ||
				typeof serializedSession.delegationActive !== 'boolean'
			) {
				console.warn(
					'[snapshot-reader] Skipping malformed session %s: missing required fields (agentName, lastToolCallTime, delegationActive)',
					sessionId,
				);
				continue;
			}
			const session = deserializeAgentSession(serializedSession);

			// ── Timestamps ────────────────────────────────────────────────
			// Refresh timestamps so the stale eviction sweep in startAgentSession
			// (now - lastToolCallTime > 2h) does not delete rehydrated sessions.
			session.lastToolCallTime = now;
			session.lastAgentEventTime = now;

			// Mark this session as rehydrated so delegation-gate can detect stale
			// coder_delegated state that was persisted from a prior session (Bug B).
			session.sessionRehydratedAt = now;

			// ── InvocationWindows ─────────────────────────────────────────
			// A process restart means OpenCode will resume the agent from scratch,
			// so accumulated counters and circuit breaker flags must not carry over.
			if (session.windows) {
				for (const window of Object.values(session.windows)) {
					window.startedAtMs = now;
					window.lastSuccessTimeMs = now;
					window.hardLimitHit = false;
					window.toolCalls = 0;
					window.consecutiveErrors = 0;
					window.recentToolCalls = [];
					window.warningIssued = false;
					window.warningReason = '';
				}
			}

			// ── Transient per-session state ───────────────────────────────
			// These fields accumulate during a single process lifetime and
			// MUST NOT survive restart.  Carrying them forward causes:
			//   - revisionLimitHit/coderRevisions: premature coder revision cap
			//   - selfFixAttempted + lastGateFailure: false self-fix warnings
			//   - architectWriteCount/selfCodingWarnedAtCount: false self-coding warnings
			//   - pendingAdvisoryMessages: stale advisories injected into prompts
			//   - model_fallback_index/modelFallbackExhausted: stuck fallback state
			//   - scopeViolationDetected: false scope violation warnings
			//   - delegationActive: prevents clean delegation lifecycle on restart
			for (const field of TRANSIENT_SESSION_FIELDS) {
				(session as unknown as Record<string, unknown>)[field.name] =
					field.resetValue;
			}

			// ── Full-auto config reconciliation ──────────────────────────
			// A snapshot may have fullAutoMode: true from a previous session
			// where full-auto was enabled in config. If the current config
			// has full_auto.enabled=false, we must clear the flag to prevent
			// a false-enabled state where the session thinks full-auto is on
			// but the intercept hook is disabled.
			if (session.fullAutoMode && !swarmState.fullAutoEnabledInConfig) {
				session.fullAutoMode = false;
			}

			swarmState.agentSessions.set(sessionId, session);
		}
	}
}

/**
 * Load snapshot from disk and rehydrate swarmState.
 * Called on plugin init to restore state from previous session.
 * NEVER throws - swallows any errors silently.
 */
export async function loadSnapshot(directory: string): Promise<void> {
	try {
		// Always build the rehydration cache from plan+evidence on disk.
		// This is needed even when no snapshot exists: sessions created later by
		// startAgentSession() will apply this cache synchronously, ensuring
		// guardrails see correct workflow state without a race.
		await buildRehydrationCache(directory);

		const snapshot = await readSnapshot(directory);
		if (snapshot !== null) {
			await rehydrateState(snapshot);
			// Apply cached plan+evidence to every restored session before the
			// plugin begins accepting tool calls.
			for (const session of swarmState.agentSessions.values()) {
				applyRehydrationCache(session);
			}
			// reconcileTaskStatesFromPlan() removed — superseded by applyRehydrationCache()
		}
	} catch {
		// Silently swallow any errors - leave state at defaults
	}
}
