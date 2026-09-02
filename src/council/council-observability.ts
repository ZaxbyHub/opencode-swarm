/**
 * Council observability emissions (issue #2046 item 9).
 *
 * Emits canonical attempt and accepted-transition observations for the three
 * council levels (task / phase / final) into the telemetry pipeline so council
 * activity joins the PR-17 lifecycle correlation system (`hostSessionId`,
 * `taskId`, `phaseId`) plus the round identity `councilRoundId` — the
 * server-derived scope token, never a client-supplied label.
 *
 * Observability is NOT the authoritative gate store: the durable audit
 * (`.swarm/council/attempts/`) and projection (`.swarm/council/round-state/`)
 * remain authoritative. Every emitter here is best-effort and never throws —
 * an observability failure can never change a verdict, gate effect, or durable
 * state, and a durability failure upstream emits nothing (the JSON response
 * remains the operator signal for those).
 *
 * Payloads are privacy class `pseudonymous`: identifiers, closed-vocabulary
 * enums, counts, and hashes only. No member names, no evidence paths, no raw
 * request content — consumers join `attemptId`/`councilRoundId` back to the
 * durable audit when they need more.
 */
import { emit } from '../telemetry.js';

/** The bounded audit-record fields an observation is derived from. */
export interface CouncilAttemptAuditLike {
	event: 'received' | 'finalized' | 'recovered';
	attemptId: string;
	disposition: string;
	authoritativeRound: number;
	clientRound?: number;
	verdictCount: number;
	members: readonly string[];
	transition?: 'stay' | 'advance' | 'close';
	gateEffect?: 'none' | 'blocked' | 'allowed';
	verdict?: 'APPROVE' | 'CONCERNS' | 'REJECT';
	quorumSize?: number;
	nextState?: {
		currentRound: number;
		status: 'open' | 'closed';
		maxRoundsExhausted: boolean;
	};
}

/** The scope identity carried on every scoped observation. */
export interface CouncilObservationScope {
	kind: 'task' | 'phase' | 'final';
	taskId?: string;
	phaseNumber?: number;
	identityDigest: string;
}

function scopeIdentityPayload(scope: CouncilObservationScope): {
	level: 'task' | 'phase' | 'final';
	taskId?: string;
	phase?: number;
	identityDigest: string;
} {
	return {
		level: scope.kind,
		...(scope.kind === 'task' && scope.taskId !== undefined
			? { taskId: scope.taskId }
			: {}),
		...(scope.kind === 'phase' && scope.phaseNumber !== undefined
			? { phase: scope.phaseNumber }
			: {}),
		identityDigest: scope.identityDigest,
	};
}

/**
 * Observe one durably-appended council audit record. Called by the round-state
 * wrapper immediately after `_internals.appendAudit` succeeds — the emitted
 * stage mirrors the durable audit event (`received` / `finalized` / `recovered`),
 * and an accepted-transition observation is additionally emitted when a
 * finalized/recovered record moves the accepted projection (`advance`/`close`);
 * `'stay'` records never produce a transition observation.
 */
export function observeCouncilAuditAppend(
	scope: CouncilObservationScope,
	sessionID: string | undefined,
	councilRoundId: string,
	record: CouncilAttemptAuditLike,
): void {
	try {
		emit('council_attempt', {
			...(sessionID !== undefined ? { sessionId: sessionID } : {}),
			councilRoundId,
			...scopeIdentityPayload(scope),
			stage: record.event,
			attemptId: record.attemptId,
			disposition: record.disposition,
			authoritativeRound: record.authoritativeRound,
			...(record.clientRound !== undefined
				? { clientRound: record.clientRound }
				: {}),
			verdictCount: record.verdictCount,
			memberCount: record.members.length,
			...(record.quorumSize !== undefined
				? { quorumSize: record.quorumSize }
				: {}),
			...(record.verdict !== undefined ? { verdict: record.verdict } : {}),
			...(record.transition !== undefined
				? { transition: record.transition }
				: {}),
			...(record.gateEffect !== undefined
				? { gateEffect: record.gateEffect }
				: {}),
		});
		const next = record.nextState;
		if (
			record.event !== 'received' &&
			(record.transition === 'advance' || record.transition === 'close') &&
			next !== undefined
		) {
			emit('council_round_transition', {
				...(sessionID !== undefined ? { sessionId: sessionID } : {}),
				councilRoundId,
				...scopeIdentityPayload(scope),
				attemptId: record.attemptId,
				transition: record.transition,
				gateEffect: record.gateEffect,
				round: record.authoritativeRound,
				nextRound: next.currentRound,
				roundStatus: next.status,
				maxRoundsExhausted: next.maxRoundsExhausted,
				...(record.verdict !== undefined ? { verdict: record.verdict } : {}),
				...(record.quorumSize !== undefined
					? { quorumSize: record.quorumSize }
					: {}),
			});
		}
	} catch {
		// Observability must never break the council flow, even if emit()'s
		// never-throw guarantee regresses.
	}
}

/**
 * Observe one durably-appended unscoped council attempt (pre-validation
 * failure: invalid arguments, wrong root, or the round-state uncertainty /
 * persistence-failure catch-alls). These attempts have no round identity, so
 * no `councilRoundId` is carried or required.
 */
export function emitUnscopedCouncilAttemptObservation(
	sessionID: string | undefined,
	level: 'task' | 'phase' | 'final',
	disposition: string,
	fingerprint: string,
	attemptId: string,
): void {
	try {
		emit('council_attempt_unscoped', {
			...(sessionID !== undefined ? { sessionId: sessionID } : {}),
			level,
			disposition,
			fingerprint,
			attemptId,
		});
	} catch {
		// Never break the council flow.
	}
}
