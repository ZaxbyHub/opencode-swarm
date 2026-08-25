import { createHash } from 'node:crypto';

const MAX_TRACKED_ACTION_CIRCUITS = 500;
const ACTION_CIRCUIT_TTL_MS = 30 * 60_000;
const MAX_RESET_AUDIT_ROWS = 128;

export interface ActionCircuitEntry {
	sessionID: string;
	invocationID: number;
	actionDigest: string;
	circuitKind: string;
	count: number;
	hardStop: boolean;
	generationToken: number;
	lastSignalDigest: string | null;
	firstSeenAt: number;
	updatedAt: number;
	expiresAt: number;
}

export interface ActionCircuitResetRecord {
	sessionID: string;
	invocationID: number;
	actionDigest: string;
	reason: 'success' | 'external' | 'invocation' | 'session';
	actor: string | null;
	at: number;
}

const actionCircuits = new Map<string, ActionCircuitEntry>();
const actionGenerationTokens = new Map<string, number>();
const armedActions = new Map<string, number>();
const resetAudit: ActionCircuitResetRecord[] = [];

function hashString(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function circuitKey(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
	circuitKind: string,
): string {
	return `${sessionID}\0${invocationID}\0${actionDigest}\0${circuitKind}`;
}

function familyKey(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
): string {
	return `${sessionID}\0${invocationID}\0${actionDigest}`;
}

function familyPrefix(sessionID: string, invocationID: number): string {
	return `${sessionID}\0${invocationID}\0`;
}

function sessionPrefix(sessionID: string): string {
	return `${sessionID}\0`;
}

function removeEntry(key: string): void {
	actionCircuits.delete(key);
}

function pruneGenerationTokenIfUnused(family: string): void {
	const prefix = `${family}\0`;
	const hasEntries = [...actionCircuits.keys()].some((key) =>
		key.startsWith(prefix),
	);
	const isArmed = armedActions.has(family);
	if (!hasEntries && !isArmed) actionGenerationTokens.delete(family);
}

function sweepExpired(now: number): void {
	for (const [key, entry] of actionCircuits) {
		if (entry.expiresAt <= now) {
			removeEntry(key);
			pruneGenerationTokenIfUnused(
				familyKey(entry.sessionID, entry.invocationID, entry.actionDigest),
			);
		}
	}
	for (const [family, armedToken] of armedActions) {
		const currentToken = actionGenerationTokens.get(family);
		if (currentToken !== armedToken) armedActions.delete(family);
	}
}

function ensureGenerationToken(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
): number {
	const family = familyKey(sessionID, invocationID, actionDigest);
	const current = actionGenerationTokens.get(family);
	if (current !== undefined) return current;
	actionGenerationTokens.set(family, 1);
	return 1;
}

function bumpGenerationToken(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
): number {
	const family = familyKey(sessionID, invocationID, actionDigest);
	const next = ensureGenerationToken(sessionID, invocationID, actionDigest) + 1;
	actionGenerationTokens.set(family, next);
	armedActions.delete(family);
	return next;
}

function touchEntry(
	key: string,
	entry: ActionCircuitEntry,
	now: number,
): ActionCircuitEntry {
	const touched = { ...entry, expiresAt: now + ACTION_CIRCUIT_TTL_MS };
	actionCircuits.delete(key);
	actionCircuits.set(key, touched);
	return touched;
}

function enforceCapacity(): void {
	while (actionCircuits.size > MAX_TRACKED_ACTION_CIRCUITS) {
		const oldest = actionCircuits.keys().next().value;
		if (oldest === undefined) break;
		const entry = actionCircuits.get(oldest);
		removeEntry(oldest);
		if (entry) {
			pruneGenerationTokenIfUnused(
				familyKey(entry.sessionID, entry.invocationID, entry.actionDigest),
			);
		}
	}
}

function recordResetAudit(record: ActionCircuitResetRecord): void {
	resetAudit.push(record);
	if (resetAudit.length > MAX_RESET_AUDIT_ROWS) resetAudit.shift();
}

export function armActionCircuitAttempt(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
): number {
	const token = ensureGenerationToken(sessionID, invocationID, actionDigest);
	armedActions.set(familyKey(sessionID, invocationID, actionDigest), token);
	return token;
}

export function noteActionCircuitFailure(input: {
	sessionID: string;
	invocationID: number;
	actionDigest: string;
	circuitKind: string;
	signal: string;
	hardStopThreshold: number;
	now?: number;
	generationToken?: number;
}): {
	entry: ActionCircuitEntry | null;
	enteredHardStop: boolean;
	ignoredLateEvent: boolean;
} {
	const now = input.now ?? Date.now();
	sweepExpired(now);
	const family = familyKey(
		input.sessionID,
		input.invocationID,
		input.actionDigest,
	);
	const expectedToken =
		input.generationToken ?? armedActions.get(family) ?? null;
	const currentToken = ensureGenerationToken(
		input.sessionID,
		input.invocationID,
		input.actionDigest,
	);
	if (expectedToken === null || expectedToken !== currentToken) {
		return { entry: null, enteredHardStop: false, ignoredLateEvent: true };
	}
	const key = circuitKey(
		input.sessionID,
		input.invocationID,
		input.actionDigest,
		input.circuitKind,
	);
	const existing = actionCircuits.get(key);
	const count = (existing?.count ?? 0) + 1;
	const hardStop = count >= input.hardStopThreshold;
	const entry: ActionCircuitEntry = {
		sessionID: input.sessionID,
		invocationID: input.invocationID,
		actionDigest: input.actionDigest,
		circuitKind: input.circuitKind,
		count,
		hardStop,
		generationToken: currentToken,
		lastSignalDigest: input.signal ? hashString(input.signal) : null,
		firstSeenAt: existing?.firstSeenAt ?? now,
		updatedAt: now,
		expiresAt: now + ACTION_CIRCUIT_TTL_MS,
	};
	actionCircuits.delete(key);
	actionCircuits.set(key, entry);
	enforceCapacity();
	return {
		entry,
		enteredHardStop: hardStop && !existing?.hardStop,
		ignoredLateEvent: false,
	};
}

function clearActionCircuitEntries(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
): void {
	const prefix = `${familyKey(sessionID, invocationID, actionDigest)}\0`;
	for (const key of [...actionCircuits.keys()]) {
		if (key.startsWith(prefix)) removeEntry(key);
	}
}

export function clearActionCircuit(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
	options?: {
		reason?: 'success' | 'external' | 'invocation' | 'session';
		actor?: string | null;
		now?: number;
	},
): void {
	clearActionCircuitEntries(sessionID, invocationID, actionDigest);
	bumpGenerationToken(sessionID, invocationID, actionDigest);
	if (options?.reason) {
		recordResetAudit({
			sessionID,
			invocationID,
			actionDigest,
			reason: options.reason,
			actor: options.actor ?? null,
			at: options.now ?? Date.now(),
		});
	}
}

export function resetActionCircuitExternally(input: {
	sessionID: string;
	invocationID: number;
	actionDigest: string;
	actor?: string | null;
	now?: number;
}): void {
	clearActionCircuit(input.sessionID, input.invocationID, input.actionDigest, {
		reason: 'external',
		actor: input.actor ?? null,
		now: input.now,
	});
}

export function clearInvocationActionCircuits(
	sessionID: string,
	invocationID: number,
	now?: number,
): void {
	const prefix = familyPrefix(sessionID, invocationID);
	for (const key of [...actionCircuits.keys()]) {
		if (key.startsWith(prefix)) removeEntry(key);
	}
	for (const family of [...actionGenerationTokens.keys()]) {
		if (family.startsWith(prefix)) {
			actionGenerationTokens.delete(family);
			armedActions.delete(family);
			recordResetAudit({
				sessionID,
				invocationID,
				actionDigest: family.slice(prefix.length),
				reason: 'invocation',
				actor: null,
				at: now ?? Date.now(),
			});
		}
	}
}

export function clearSessionActionCircuits(
	sessionID: string,
	now?: number,
): void {
	const prefix = sessionPrefix(sessionID);
	for (const key of [...actionCircuits.keys()]) {
		if (key.startsWith(prefix)) removeEntry(key);
	}
	for (const family of [...actionGenerationTokens.keys()]) {
		if (family.startsWith(prefix)) {
			const familyTail = family.slice(prefix.length);
			const separatorIndex = familyTail.indexOf('\0');
			const invocationID =
				separatorIndex > 0 ? Number(familyTail.slice(0, separatorIndex)) : 0;
			const actionDigest =
				separatorIndex > 0 ? familyTail.slice(separatorIndex + 1) : familyTail;
			actionGenerationTokens.delete(family);
			armedActions.delete(family);
			recordResetAudit({
				sessionID,
				invocationID,
				actionDigest,
				reason: 'session',
				actor: null,
				at: now ?? Date.now(),
			});
		}
	}
}

export function getBlockingActionCircuit(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
): ActionCircuitEntry | null {
	const now = Date.now();
	sweepExpired(now);
	const prefix = `${familyKey(sessionID, invocationID, actionDigest)}\0`;
	for (const [key, entry] of actionCircuits) {
		if (key.startsWith(prefix) && entry.hardStop) {
			return touchEntry(key, entry, now);
		}
	}
	return null;
}

export function listBlockingActionCircuitsForInvocation(
	sessionID: string,
	invocationID: number,
): ActionCircuitEntry[] {
	const now = Date.now();
	sweepExpired(now);
	const prefix = familyPrefix(sessionID, invocationID);
	const result: ActionCircuitEntry[] = [];
	// Snapshot before touching LRU order. Deleting and re-inserting the current
	// Map key during live iteration makes that key visible again and can loop
	// forever whenever at least one blocking circuit exists.
	for (const [key, entry] of [...actionCircuits]) {
		if (key.startsWith(prefix) && entry.hardStop) {
			result.push(touchEntry(key, entry, now));
		}
	}
	return result;
}

export function peekActionCircuitCount(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
	circuitKind: string,
): number {
	return (
		actionCircuits.get(
			circuitKey(sessionID, invocationID, actionDigest, circuitKind),
		)?.count ?? 0
	);
}

export function expireActionCircuit(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
	circuitKind: string,
): void {
	const entry = actionCircuits.get(
		circuitKey(sessionID, invocationID, actionDigest, circuitKind),
	);
	if (entry) entry.expiresAt = Date.now() - 1;
}

export function clearAllActionCircuits(): void {
	actionCircuits.clear();
	actionGenerationTokens.clear();
	armedActions.clear();
	resetAudit.length = 0;
}

export const _test_exports = {
	ACTION_CIRCUIT_TTL_MS,
	MAX_TRACKED_ACTION_CIRCUITS,
	size: (): number => actionCircuits.size,
	getGenerationToken: (
		sessionID: string,
		invocationID: number,
		actionDigest: string,
	) => ensureGenerationToken(sessionID, invocationID, actionDigest),
	getResetAudit: () => resetAudit.map((entry) => ({ ...entry })),
};
