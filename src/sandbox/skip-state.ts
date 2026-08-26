export interface SandboxWrapOutcome {
	sessionID: string;
	callID: string;
	originalCommandHash: number;
	finalCommandHash: number;
	wrapped: boolean;
	capabilityIdentity: string;
	assessmentCacheKey: string;
	reason: string;
	originalCommand: string;
	executorMechanism: string;
	capabilityMechanism: string;
}

const MAX_SANDBOX_WRAP_OUTCOMES = 512;
const sandboxWrapOutcomes = new Map<string, SandboxWrapOutcome>();
const sandboxSkipReasons: string[] = [];

function key(sessionID: string, callID: string): string {
	return JSON.stringify([sessionID, callID]);
}

function prune(): void {
	while (sandboxWrapOutcomes.size > MAX_SANDBOX_WRAP_OUTCOMES) {
		const oldest = sandboxWrapOutcomes.keys().next().value;
		if (oldest === undefined) return;
		sandboxWrapOutcomes.delete(oldest);
	}
}

export function recordSandboxWrapOutcome(outcome: SandboxWrapOutcome): void {
	const bounded = {
		...outcome,
		originalCommand: outcome.originalCommand.slice(0, 64 * 1024),
		reason: outcome.reason.slice(0, 512),
	};
	sandboxWrapOutcomes.set(key(outcome.sessionID, outcome.callID), bounded);
	if (!bounded.wrapped) {
		sandboxSkipReasons.push(bounded.reason);
		while (sandboxSkipReasons.length > MAX_SANDBOX_WRAP_OUTCOMES) {
			sandboxSkipReasons.shift();
		}
	}
	prune();
}

export function readSandboxWrapOutcome(
	sessionID: string,
	callID: string,
): SandboxWrapOutcome | null {
	return sandboxWrapOutcomes.get(key(sessionID, callID)) ?? null;
}

export function clearSandboxWrapOutcome(
	sessionID: string,
	callID: string,
): void {
	sandboxWrapOutcomes.delete(key(sessionID, callID));
}

export function getSandboxSkipSummary(): {
	count: number;
	reasons: readonly string[];
} {
	return {
		count: sandboxSkipReasons.length,
		reasons: Object.freeze([...new Set(sandboxSkipReasons)].slice(-10)),
	};
}

/** @internal test seam */
export function _resetSandboxWrapOutcomeState(): void {
	sandboxWrapOutcomes.clear();
	sandboxSkipReasons.length = 0;
}

/** @internal test seam */
export function _sandboxWrapOutcomeStateSize(): number {
	return sandboxWrapOutcomes.size;
}
