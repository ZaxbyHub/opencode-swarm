/**
 * Compaction service — monitors context budget and triggers graduated compaction
 * when usage crosses configured thresholds.
 *
 * Three tiers (all thresholds as percentages 0-100):
 *  - Observation (default 40%): summarise older turns, preserve key decisions
 *  - Reflection  (default 60%): re-summarise into tighter format
 *  - Emergency   (default 80%): hard truncation to system + current task + last N turns
 *
 * Consumes the per-session budget pct recorded by system-enhancer.ts after
 * each budget calc (`getSessionBudgetPct`).
 * Never throws. Advisory system message injection via callback.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompactionConfig } from '../config/schema';
import { getSessionBudgetPct } from '../state';
export type { CompactionConfig };

// ── Compaction state (module-level, resets on plugin reload) ─────────────────

interface CompactionState {
	lastObservationAt: number; // budgetPct when observation last ran
	lastReflectionAt: number;
	lastEmergencyAt: number;
	observationCount: number;
	reflectionCount: number;
	emergencyCount: number;
	lastSnapshotAt: string | null;
}

function makeInitialState(): CompactionState {
	return {
		lastObservationAt: 0,
		lastReflectionAt: 0,
		lastEmergencyAt: 0,
		observationCount: 0,
		reflectionCount: 0,
		emergencyCount: 0,
		lastSnapshotAt: null,
	};
}

// Per-session compaction state keyed by sessionId.
// Isolates hysteresis thresholds so concurrent sessions don't suppress each other's compaction.
const sessionStates = new Map<string, CompactionState>();

// FIFO cap (AGENTS.md invariant 8). Mirrors MAX_TRACKED_BUDGET_SESSIONS in
// state.ts: the budget map and this hysteresis map are the two per-session
// records that drive compaction, so they share one bounded-growth contract.
// Without this, the create-on-read in getSessionState below grew unbounded
// under session churn while the budget map (capped at 500) evicted — leaving
// the two maps free to desync (hysteresis without a budget record, or a
// budget record whose hysteresis was silently dropped).
export const MAX_TRACKED_COMPACTION_SESSIONS = 500;

function getSessionState(sessionId: string): CompactionState {
	let state = sessionStates.get(sessionId);
	if (state) return state;
	state = makeInitialState();
	sessionStates.set(sessionId, state);
	// `set` just made `sessionId` the newest entry, so the FIFO oldest can never
	// be `sessionId` here — the guard is defensive and mirrors setSessionBudget.
	if (sessionStates.size > MAX_TRACKED_COMPACTION_SESSIONS) {
		const oldest = sessionStates.keys().next().value;
		if (oldest !== undefined && oldest !== sessionId) {
			sessionStates.delete(oldest);
		}
	}
	return state;
}

// ── Snapshot writer ────────────────────────────────────────────────────────────

function appendSnapshot(
	directory: string,
	tier: 'observation' | 'reflection' | 'emergency',
	budgetPct: number,
	message: string,
): void {
	try {
		const snapshotPath = path.join(directory, '.swarm', 'context-snapshot.md');
		const timestamp = new Date().toISOString();
		const entry = `\n## [${tier.toUpperCase()}] ${timestamp} — ${budgetPct.toFixed(1)}% used\n${message}\n`;
		fs.appendFileSync(snapshotPath, entry, 'utf-8');
	} catch {
		// snapshot write failure is non-fatal
	}
}

// ── Tier messages ─────────────────────────────────────────────────────────────

function buildObservationMessage(budgetPct: number): string {
	return (
		`[CONTEXT COMPACTION — OBSERVATION TIER]\n` +
		`Context window is ${budgetPct.toFixed(1)}% used. Initiating observation compaction.\n` +
		`INSTRUCTIONS: Summarise the key decisions made so far, files changed, errors resolved, ` +
		`and the current task state. Discard verbose tool outputs and raw file reads. ` +
		`Preserve: plan task ID, agent verdicts, file paths touched, unresolved blockers.\n` +
		`[/CONTEXT COMPACTION]`
	);
}

function buildReflectionMessage(budgetPct: number): string {
	return (
		`[CONTEXT COMPACTION — REFLECTION TIER]\n` +
		`Context window is ${budgetPct.toFixed(1)}% used. Initiating reflection compaction.\n` +
		`INSTRUCTIONS: Re-summarise into a tighter format. Discard completed task details ` +
		`and resolved errors. Retain ONLY: current phase tasks remaining, open blockers, ` +
		`last 3 reviewer/test verdicts, and active file scope.\n` +
		`[/CONTEXT COMPACTION]`
	);
}

function buildEmergencyMessage(
	budgetPct: number,
	preserveLastN: number,
): string {
	return (
		`[CONTEXT COMPACTION — EMERGENCY TIER]\n` +
		`Context window is ${budgetPct.toFixed(1)}% used. EMERGENCY compaction required.\n` +
		`INSTRUCTIONS: Retain ONLY the system prompt, the current task context, and the ` +
		`last ${preserveLastN} conversation turns. Discard everything else. ` +
		`If you cannot complete the current task in the remaining context, escalate to the user.\n` +
		`[/CONTEXT COMPACTION]`
	);
}

// ── Service factory ────────────────────────────────────────────────────────────

export interface CompactionServiceHook {
	toolAfter: (
		input: { tool: string; sessionID: string },
		output: { output?: unknown },
	) => Promise<void>;
}

export function createCompactionService(
	config: CompactionConfig,
	directory: string,
	injectMessage: (sessionId: string, message: string) => void,
): CompactionServiceHook {
	return {
		toolAfter: async (_input, _output) => {
			if (!config.enabled) return;

			// Read last known budget from swarmState (set by system-enhancer)
			// Per-session: another session's pressure must never trigger compaction
			// here (AGENTS.md invariant 8).
			const budgetPct = getSessionBudgetPct(_input.sessionID);
			if (budgetPct <= 0) return; // No budget data yet

			const sessionId = _input.sessionID;
			const state = getSessionState(sessionId);

			try {
				// Emergency tier — highest priority
				if (
					budgetPct >= config.emergencyThreshold &&
					budgetPct > state.lastEmergencyAt + 5 // 5% hysteresis to prevent spam
				) {
					state.lastEmergencyAt = budgetPct;
					state.emergencyCount++;
					const msg = buildEmergencyMessage(
						budgetPct,
						config.preserveLastNTurns,
					);
					appendSnapshot(directory, 'emergency', budgetPct, msg);
					state.lastSnapshotAt = new Date().toISOString();
					injectMessage(sessionId, msg);
					return;
				}

				// Reflection tier
				if (
					budgetPct >= config.reflectionThreshold &&
					budgetPct > state.lastReflectionAt + 5
				) {
					state.lastReflectionAt = budgetPct;
					state.reflectionCount++;
					const msg = buildReflectionMessage(budgetPct);
					appendSnapshot(directory, 'reflection', budgetPct, msg);
					state.lastSnapshotAt = new Date().toISOString();
					injectMessage(sessionId, msg);
					return;
				}

				// Observation tier
				if (
					budgetPct >= config.observationThreshold &&
					budgetPct > state.lastObservationAt + 5
				) {
					state.lastObservationAt = budgetPct;
					state.observationCount++;
					const msg = buildObservationMessage(budgetPct);
					appendSnapshot(directory, 'observation', budgetPct, msg);
					state.lastSnapshotAt = new Date().toISOString();
					injectMessage(sessionId, msg);
				}
			} catch {
				// compaction hook is best-effort — never propagate
			}
		},
	};
}

export function getCompactionMetrics(sessionId?: string): {
	compactionCount: number;
	lastSnapshotAt: string | null;
} {
	if (sessionId) {
		const state = getSessionState(sessionId);
		return {
			compactionCount:
				state.observationCount + state.reflectionCount + state.emergencyCount,
			lastSnapshotAt: state.lastSnapshotAt,
		};
	}
	// Aggregate across all sessions for backward compatibility
	let total = 0;
	let lastSnapshot: string | null = null;
	for (const state of sessionStates.values()) {
		total +=
			state.observationCount + state.reflectionCount + state.emergencyCount;
		if (
			state.lastSnapshotAt &&
			(!lastSnapshot || state.lastSnapshotAt > lastSnapshot)
		) {
			lastSnapshot = state.lastSnapshotAt;
		}
	}
	return { compactionCount: total, lastSnapshotAt: lastSnapshot };
}

export function resetCompactionState(sessionId?: string): void {
	if (sessionId) {
		sessionStates.delete(sessionId);
	} else {
		sessionStates.clear();
	}
}
