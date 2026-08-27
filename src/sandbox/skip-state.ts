import { sanitizeDiagnosticText } from '../scope/path-identity';

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
const MAX_TRACKED_SKIP_SESSIONS = 128;
const MAX_SKIP_REASONS_PER_SESSION = 128;
const sandboxWrapOutcomes = new Map<string, SandboxWrapOutcome>();
const sandboxSkipReasonsBySession = new Map<string, string[]>();

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

function pruneSkipSessions(): void {
	while (sandboxSkipReasonsBySession.size > MAX_TRACKED_SKIP_SESSIONS) {
		const oldest = sandboxSkipReasonsBySession.keys().next().value;
		if (oldest === undefined) return;
		sandboxSkipReasonsBySession.delete(oldest);
	}
}

function redactSandboxSkipReason(reason: string): string {
	return sanitizeDiagnosticText(reason, 1024)
		.replace(/\\\\[^\\\s,;)\]]+(?:\\[^\\\s,;)\]]+)+/g, '[redacted-path]')
		.replace(/[A-Za-z]:\\[^\\\s,;)\]]+(?:\\[^\\\s,;)\]]+)*/g, '[redacted-path]')
		.replace(/\/[^/\s,;)\]]+(?:\/[^/\s,;)\]]+)+/g, '[redacted-path]')
		.replace(
			/(^|[\s(])(?:\.\.?[\\/][^\s,;)\]]+|~[\\/][^\s,;)\]]+)/g,
			'$1[redacted-path]',
		)
		.slice(0, 512);
}

function recordSandboxSkipReason(sessionID: string, reason: string): void {
	let reasons = sandboxSkipReasonsBySession.get(sessionID);
	if (!reasons) {
		reasons = [];
		sandboxSkipReasonsBySession.set(sessionID, reasons);
		pruneSkipSessions();
	}
	reasons.push(redactSandboxSkipReason(reason));
	while (reasons.length > MAX_SKIP_REASONS_PER_SESSION) {
		reasons.shift();
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
		recordSandboxSkipReason(outcome.sessionID, bounded.reason);
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

export function getSandboxSkipSummary(sessionID?: string): {
	count: number;
	reasons: readonly string[];
} {
	if (!sessionID) {
		return {
			count: 0,
			reasons: Object.freeze([]),
		};
	}
	const reasons = sandboxSkipReasonsBySession.get(sessionID) ?? [];
	return {
		count: reasons.length,
		reasons: Object.freeze([...new Set(reasons)].slice(-10)),
	};
}

/** @internal test seam */
export function _resetSandboxWrapOutcomeState(): void {
	sandboxWrapOutcomes.clear();
	sandboxSkipReasonsBySession.clear();
}

/** @internal test seam */
export function _sandboxWrapOutcomeStateSize(): number {
	return sandboxWrapOutcomes.size;
}
