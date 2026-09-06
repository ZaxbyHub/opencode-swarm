/**
 * Action-local spawn-protection circuit for native task delegations
 * (issue #2507 / ADR 0002 G3 — reimplemented, no upstream code ported).
 *
 * Ownership boundary (one accounting owner per failure category,
 * docs/invocation-failures.md): this circuit owns repeated ACTUAL dispatch
 * failures of the SAME semantic action on the native `task` route. Policy
 * denials stay with the gate-denial tracker, shell-structural failures with
 * the non-transient circuit, PR-review lane provider-terminal with the
 * PR-review resilience circuit, provable-non-acceptance launch retry with
 * #2473, and lane liveness with #2506.
 *
 * State machine (the src/pr-review/circuit.ts timed HALF_OPEN precedent):
 * CLOSED -> (threshold failures) -> OPEN -> (openUntil elapses, next dispatch
 * admitted) -> HALF_OPEN (exactly one probe) -> completed probe closes |
 * failed probe re-opens with a fresh interval.
 *
 * The state is process-local, invocation-owned, and bounded — the
 * docs/invocation-failures.md contract for action circuits (only the
 * PR-review resilience circuit is durable).
 */

import type { DispatchProtectionConfig } from '../config/schema';
import { createActionIdentity } from '../failures/action-identity';
import { normalizeToolNameLowerCase } from '../hooks/normalize-tool-name';
import { getAgentSession } from '../state';

/** Bounded memory: same discipline as MAX_TRACKED_ACTION_CIRCUITS. */
export const MAX_TRACKED_SPAWN_CIRCUITS = 500;
export const SPAWN_CIRCUIT_TTL_MS = 30 * 60_000;
/** Bounded armed-digest map (late toolAfter results must not grow it). */
export const MAX_ARMED_DISPATCH_IDENTITIES = 500;

/** Frozen denial code — gate-denial-tracker exempts exactly this code. */
export const SPAWN_CIRCUIT_DENIAL_CODE = 'SPAWN PROTECTION CIRCUIT OPEN';

export interface SpawnCircuitEntry {
	state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
	sessionID: string;
	invocationID: string;
	actionDigest: string;
	actionPattern: string;
	failureCount: number;
	openedAt: number;
	openUntil: number;
	probeAdmitted: boolean;
	/** Denials issued in the current OPEN episode (reset on each OPEN). */
	denialsInEpisode: number;
	updatedAt: number;
}

const spawnCircuits = new Map<string, SpawnCircuitEntry>();
const armedIdentities = new Map<string, { digest: string; pattern: string }>();

function entryKey(
	sessionID: string,
	invocationID: string,
	actionDigest: string,
): string {
	return `${sessionID}\0${invocationID}\0${actionDigest}`;
}

export function invocationIdForSession(sessionID: string): string {
	const invocation = getAgentSession(sessionID)?.activeInvocationId;
	return invocation === undefined || invocation === null
		? 'none'
		: String(invocation);
}

function evictExpired(now: number): void {
	if (spawnCircuits.size <= MAX_TRACKED_SPAWN_CIRCUITS) {
		for (const [key, entry] of spawnCircuits) {
			if (now - entry.updatedAt > SPAWN_CIRCUIT_TTL_MS) {
				spawnCircuits.delete(key);
			}
		}
		return;
	}
	// Over cap: drop the stalest entries first (LRU-style), then TTL-sweep
	// the remainder so the map is bounded no matter the arrival order.
	const byAge = [...spawnCircuits.entries()].sort(
		(a, b) => a[1].updatedAt - b[1].updatedAt,
	);
	const excess = spawnCircuits.size - MAX_TRACKED_SPAWN_CIRCUITS;
	for (let i = 0; i < excess && i < byAge.length; i++) {
		spawnCircuits.delete(byAge[i][0]);
	}
	for (const [key, entry] of spawnCircuits) {
		if (now - entry.updatedAt > SPAWN_CIRCUIT_TTL_MS) {
			spawnCircuits.delete(key);
		}
	}
}

/**
 * Arm the pre-mutation dispatch identity for a callID. Step 0 of the
 * fail-closed tool.execute.before region calls this BEFORE any hook can
 * mutate `output.args` (skill / delegate-directive injection), so the
 * toolAfter recorder consumes the SAME digest the circuit was keyed with —
 * a corrected success can never clear a phantom key (plan Round 1
 * revision 2).
 */
export function armDispatchIdentity(
	callID: string,
	tool: string,
	args: unknown,
): { digest: string; pattern: string } {
	const identity = createActionIdentity({
		tool,
		args:
			args != null && typeof args === 'object' && !Array.isArray(args)
				? (args as Record<string, unknown>)
				: undefined,
	});
	if (armedIdentities.size >= MAX_ARMED_DISPATCH_IDENTITIES) {
		const oldest = armedIdentities.keys().next().value;
		if (oldest !== undefined) armedIdentities.delete(oldest);
	}
	armedIdentities.set(callID, {
		digest: identity.digest,
		pattern: identity.pattern,
	});
	return { digest: identity.digest, pattern: identity.pattern };
}

/** Consume the armed identity for a callID (fallback: undefined). */
export function takeArmedDispatchIdentity(
	callID: string,
): { digest: string; pattern: string } | undefined {
	const armed = armedIdentities.get(callID);
	if (armed) armedIdentities.delete(callID);
	return armed;
}

/**
 * Record one ACTUAL dispatch failure for the matching action. Returns the
 * entry and whether this call performed the CLOSED->OPEN transition (the
 * caller emits exactly one bounded telemetry event on that transition).
 */
export function noteDispatchSpawnFailure(input: {
	sessionID: string;
	invocationID: string;
	actionDigest: string;
	actionPattern: string;
	threshold: number;
	halfOpenAfterMs: number;
	now?: number;
}): { entry: SpawnCircuitEntry; opened: boolean } {
	const now = input.now ?? _internals.now();
	const key = entryKey(input.sessionID, input.invocationID, input.actionDigest);
	const existing = spawnCircuits.get(key);
	const entry: SpawnCircuitEntry = existing
		? { ...existing, failureCount: existing.failureCount + 1, updatedAt: now }
		: {
				state: 'CLOSED',
				sessionID: input.sessionID,
				invocationID: input.invocationID,
				actionDigest: input.actionDigest,
				actionPattern: input.actionPattern,
				failureCount: 1,
				openedAt: 0,
				openUntil: 0,
				probeAdmitted: false,
				denialsInEpisode: 0,
				updatedAt: now,
			};
	let opened = false;
	if (
		entry.state !== 'OPEN' &&
		entry.failureCount >= Math.max(1, input.threshold)
	) {
		entry.state = 'OPEN';
		entry.openedAt = now;
		entry.openUntil = now + Math.max(1, input.halfOpenAfterMs);
		entry.probeAdmitted = false;
		entry.denialsInEpisode = 0;
		opened = true;
	}
	if (entry.state === 'HALF_OPEN') {
		// A failure while a half-open probe is in flight re-opens the
		// circuit with a fresh interval (pr-review HALF_OPEN precedent).
		entry.state = 'OPEN';
		entry.openedAt = now;
		entry.openUntil = now + Math.max(1, input.halfOpenAfterMs);
		entry.probeAdmitted = false;
		entry.denialsInEpisode = 0;
	}
	entry.updatedAt = now;
	spawnCircuits.set(key, entry);
	evictExpired(now);
	return { entry, opened };
}

/**
 * Deny when the matching action's circuit is OPEN (before its interval
 * elapses) or when a half-open probe is already in flight. When the open
 * interval has elapsed, this call is ADMITTED as the single probe.
 * Throws an Error whose leading token is the frozen
 * SPAWN_CIRCUIT_DENIAL_CODE so the gate-denial tracker can exempt it.
 */
export function assertDispatchSpawnCircuitAdmits(input: {
	sessionID: string;
	invocationID: string;
	actionDigest: string;
	threshold: number;
	halfOpenAfterMs: number;
	now?: number;
}): void {
	const now = input.now ?? _internals.now();
	const key = entryKey(input.sessionID, input.invocationID, input.actionDigest);
	const entry = spawnCircuits.get(key);
	if (!entry || entry.state === 'CLOSED') return;
	if (entry.state === 'OPEN') {
		// An OPEN episode must DENY at least once before any half-open probe
		// can be admitted: the agent has to be told the circuit is open
		// before a probe counts as a recovery attempt. Without this, an
		// open interval that elapses during post-failure bookkeeping (the
		// composed after-hook chain) would silently skip the denial phase
		// entirely.
		if (now < entry.openUntil || entry.denialsInEpisode === 0) {
			entry.denialsInEpisode += 1;
			entry.updatedAt = now;
			throw new Error(
				`${SPAWN_CIRCUIT_DENIAL_CODE}: repeated dispatch failures for this action (${entry.failureCount} of ${Math.max(1, input.threshold)}). Read, diagnose, repair, rescope, abort, and handoff controls remain available; one recovery probe is admitted after the half-open interval.`,
			);
		}
		entry.state = 'HALF_OPEN';
		entry.probeAdmitted = true;
		entry.updatedAt = now;
		return;
	}
	// HALF_OPEN with a probe already admitted this interval.
	throw new Error(
		`${SPAWN_CIRCUIT_DENIAL_CODE}: a recovery probe for this action is already in flight. Read, diagnose, repair, rescope, abort, and handoff controls remain available.`,
	);
}

/**
 * A corrected successful execution clears ONLY the matching action's entry
 * (and closes an in-flight half-open probe). Failures of other actions are
 * never touched.
 */
export function noteDispatchSpawnSuccess(input: {
	sessionID: string;
	invocationID: string;
	actionDigest: string;
}): void {
	spawnCircuits.delete(
		entryKey(input.sessionID, input.invocationID, input.actionDigest),
	);
}

export function getSpawnCircuitEntry(input: {
	sessionID: string;
	invocationID: string;
	actionDigest: string;
}): SpawnCircuitEntry | undefined {
	return spawnCircuits.get(
		entryKey(input.sessionID, input.invocationID, input.actionDigest),
	);
}

export function spawnCircuitIsTaskTool(tool: string): boolean {
	return normalizeToolNameLowerCase(tool) === 'task';
}

export function protectionEnabled(
	config: DispatchProtectionConfig | undefined,
): boolean {
	return (config?.enabled ?? true) === true;
}

/** Test seam: reset all circuits + armed identities between test files. */
export function _clearAllSpawnCircuits(): void {
	spawnCircuits.clear();
	armedIdentities.clear();
}

export const _internals = {
	now: (): number => Date.now(),
};
