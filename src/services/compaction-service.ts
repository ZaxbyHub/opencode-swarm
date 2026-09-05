/**
 * Compaction service — monitors context budget and triggers graduated compaction
 * when usage crosses configured thresholds.
 *
 * Three tiers (all thresholds as percentages 0-100):
 *  - Observation (default 40%): summarise older turns, preserve key decisions
 *  - Reflection  (default 60%): re-summarise into tighter format
 *  - Emergency   (default 80%): hard truncation to system + current task + last N turns
 *
 * Consumes the per-session FINAL PROMPT PRESSURE recorded by the final
 * context-accounting step (#2107 §3) after every injector has run
 * (`getFinalPromptPressure`); before that step has run for a session it falls
 * back to the legacy injection-footprint pct (`getSessionBudgetPct`) so the
 * tiers never go dark.
 * Never throws. Advisory system message injection via callback. These tiers
 * ADVISE the model to compact — they never compact anything themselves and
 * never claim a compaction was performed (only the physical pruning in
 * src/hooks/context-budget.ts actually removes content).
 */

import * as path from 'node:path';
import type { CompactionConfig } from '../config/schema';
import { resolveRetentionCap } from '../retention/caps';
import { appendCappedJsonl } from '../retention/jsonl-cap';
import { getFinalPromptPressure, getSessionBudgetPct } from '../state';
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

/**
 * Global byte cap on `.swarm/context-snapshot.md` (issue #2483 §2). Enforced
 * via `appendCappedJsonl` with a high entry count so only the byte budget
 * binds; compaction keeps the newest whole records that fit and never empties
 * a non-empty snapshot (whole-record floor ≥ 1 entry).
 */
export const MAX_CONTEXT_SNAPSHOT_BYTES = 65536;

async function appendSnapshot(
	directory: string,
	tier: 'observation' | 'reflection' | 'emergency',
	budgetPct: number,
	message: string,
): Promise<void> {
	try {
		const snapshotPath = path.join(directory, '.swarm', 'context-snapshot.md');
		const timestamp = new Date().toISOString();
		const entry = `\n## [${tier.toUpperCase()}] ${timestamp} — ${budgetPct.toFixed(1)}% used\n${message}\n`;
		// N4 (issue #2483): the entry header/message length (~472 B/entry) is
		// load-bearing for the frozen C3 check's 512-byte override — do not
		// reword the tier messages without re-verifying that probe width.
		await appendCappedJsonl(snapshotPath, entry, {
			maxEntries: 100000,
			maxBytes: resolveRetentionCap(
				'MAX_CONTEXT_SNAPSHOT_BYTES',
				MAX_CONTEXT_SNAPSHOT_BYTES,
			),
		});
	} catch {
		// snapshot write failure is non-fatal
	}
}

// ── Tier messages ─────────────────────────────────────────────────────────────

function buildObservationMessage(budgetPct: number): string {
	return (
		`[CONTEXT COMPACTION ADVISORY — OBSERVATION TIER]\n` +
		`Estimated prompt pressure is ~${budgetPct.toFixed(1)}% of the model window. Consider compacting now (advisory — nothing has been compacted yet).\n` +
		`INSTRUCTIONS: Summarise the key decisions made so far, files changed, errors resolved, ` +
		`and the current task state. Discard verbose tool outputs and raw file reads. ` +
		`Preserve: plan task ID, agent verdicts, file paths touched, unresolved blockers.\n` +
		`[/CONTEXT COMPACTION]`
	);
}

function buildReflectionMessage(budgetPct: number): string {
	return (
		`[CONTEXT COMPACTION ADVISORY — REFLECTION TIER]\n` +
		`Estimated prompt pressure is ~${budgetPct.toFixed(1)}% of the model window. Consider compacting now (advisory — nothing has been compacted yet).\n` +
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
		`[CONTEXT COMPACTION ADVISORY — EMERGENCY TIER]\n` +
		`Estimated prompt pressure is ~${budgetPct.toFixed(1)}% of the model window. Consider compacting immediately (advisory — nothing has been compacted yet).\n` +
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

			// Read the session's final prompt pressure (set by the final
			// context-accounting step after all injectors ran); fall back to the
			// legacy injection-footprint pct before that step has run.
			// Per-session: another session's pressure must never trigger compaction
			// here (AGENTS.md invariant 8).
			const budgetPct =
				getFinalPromptPressure(_input.sessionID)?.pct ??
				getSessionBudgetPct(_input.sessionID);
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
					await appendSnapshot(directory, 'emergency', budgetPct, msg);
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
					await appendSnapshot(directory, 'reflection', budgetPct, msg);
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
					await appendSnapshot(directory, 'observation', budgetPct, msg);
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
