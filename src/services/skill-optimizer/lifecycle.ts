/**
 * Lifecycle state machine for the governed skill optimizer (issue #1822).
 *
 * Legal transitions encode the durable lifecycle:
 *   discovered → drafted → smoke_validated → validation_running
 *                                            → accepted_pending_approval | rejected | inconclusive
 *     accepted_pending_approval → activated | expired | rolled_back
 *     inconclusive → drafted (re-entry with a fresh candidate + task set, D8)
 *     activated → rolled_back
 *     rejected → (terminal)
 *     expired → (terminal)
 *
 * `recordTransition` wraps `store.appendEvent` with:
 *   - legal-transition enforcement (IllegalTransitionError otherwise);
 *   - replay-from-last-complete (restart never reruns a one-shot validation —
 *     validation run refs are immutable; a re-validation is a NEW candidate);
 *   - replay-after-write verification (inherited from the store).
 */

import {
	appendEvent,
	computeStateHash,
	quarantineSuffix,
	replayCandidate,
	type SkillOptEvent,
	type SkillOptState,
	writeStateProjection,
} from './store.js';

export class IllegalTransitionError extends Error {
	constructor(
		public readonly from: SkillOptState | null,
		public readonly to: SkillOptState,
	) {
		super(`illegal skill-opt transition: ${from ?? '<none>'} → ${to}`);
		this.name = 'IllegalTransitionError';
	}
}

/**
 * The legal-transition table. Each entry is `${from} -> Set<to>`. `null` from
 * means "from empty/discovered start".
 *
 * `inconclusive -> drafted` is the D8 re-entry: a fresh round with a new
 * candidate ID and a fresh validation task set (the held-out test set cannot
 * be reused — claimHeldOutTest enforces single-use). This does NOT rerun a
 * one-shot validation; it starts a new candidate.
 */
const LEGAL_TRANSITIONS: Record<SkillOptState, readonly SkillOptState[]> = {
	discovered: ['drafted'],
	drafted: ['smoke_validated', 'rejected'],
	smoke_validated: ['validation_running', 'rejected'],
	validation_running: ['accepted_pending_approval', 'rejected', 'inconclusive'],
	accepted_pending_approval: ['activated', 'expired', 'rolled_back'],
	rejected: [],
	inconclusive: ['drafted', 'rejected'],
	activated: ['rolled_back'],
	expired: [],
	rolled_back: [],
};

const INITIAL_TRANSITIONS: readonly SkillOptState[] = ['discovered'];

export function isLegalTransition(
	from: SkillOptState | null,
	to: SkillOptState,
): boolean {
	const allowed = from === null ? INITIAL_TRANSITIONS : LEGAL_TRANSITIONS[from];
	return allowed.includes(to);
}

export function assertTransition(
	from: SkillOptState | null,
	to: SkillOptState,
): void {
	if (!isLegalTransition(from, to)) {
		throw new IllegalTransitionError(from, to);
	}
}

export interface RecordTransitionInput {
	directory: string;
	skillSlug: string;
	candidateId: string;
	toState: SkillOptState;
	eventType: string;
	actor: string;
	origin: string;
	reason: string;
	evidenceRefs?: string[];
	contentHashBefore?: string | null;
	contentHashAfter?: string | null;
	payload?: Record<string, unknown>;
}

export interface RecordTransitionResult {
	event: SkillOptEvent;
	fromState: SkillOptState | null;
	replayTruncated: boolean;
}

/**
 * Record a lifecycle transition.
 *
 * 1. Replays the candidate ledger to derive the current `fromState` (restart-
 *    safe). If the ledger tail is corrupt, quarantines the suffix and uses the
 *    last complete event's `toState` as `fromState`.
 * 2. Asserts the `from -> to` transition is legal.
 * 3. Appends the event (hash-chained, fsync+rename, replay-after-write verify).
 * 4. Refreshes the derived `state.json` projection.
 *
 * Restart rule: a one-shot validation is NEVER rerun. If `toState` is
 * `validation_running` and the candidate already has a completed validation
 * event, this throws — the caller must mint a new candidate ID for a re-test.
 */
export async function recordTransition(
	input: RecordTransitionInput,
): Promise<RecordTransitionResult> {
	const replay = replayCandidate(
		input.directory,
		input.skillSlug,
		input.candidateId,
	);
	let fromState = replay.state;

	// Quarantine a corrupt tail so the canonical ledger is preserved and the
	// last complete event becomes the restart point. Mirrors plan-ledger.
	if (replay.truncated && replay.badSuffix) {
		quarantineSuffix(input.directory, input.skillSlug, replay.badSuffix);
		// Derive fromState from the last complete event.
		fromState =
			replay.events.length === 0
				? null
				: replay.events[replay.events.length - 1].toState;
	}

	assertTransition(fromState, input.toState);

	// Restart rule: never rerun a one-shot validation. If we are entering
	// validation_running but the candidate already completed validation, refuse.
	if (input.toState === 'validation_running') {
		const alreadyValidated = replay.events.some(
			(e) =>
				e.toState === 'accepted_pending_approval' ||
				e.toState === 'rejected' ||
				e.toState === 'inconclusive',
		);
		if (alreadyValidated) {
			throw new Error(
				`candidate ${input.candidateId} already completed validation — start a new candidate to re-test`,
			);
		}
	}

	const event = await appendEvent(input.directory, {
		candidateId: input.candidateId,
		skillSlug: input.skillSlug,
		eventType: input.eventType,
		fromState,
		toState: input.toState,
		actor: input.actor,
		origin: input.origin,
		contentHashBefore: input.contentHashBefore ?? null,
		contentHashAfter: input.contentHashAfter ?? null,
		reason: input.reason,
		evidenceRefs: input.evidenceRefs ?? [],
		...(input.payload ? { payload: input.payload } : {}),
	});

	// Refresh the derived projection.
	writeStateProjection(input.directory, input.skillSlug, input.candidateId, {
		...replayCandidate(input.directory, input.skillSlug, input.candidateId),
		events: [...replay.events, event],
	});

	return { event, fromState, replayTruncated: replay.truncated };
}

/** Convenience: current candidate state via replay (re-derived each call). */
export function currentCandidateState(
	directory: string,
	skillSlug: string,
	candidateId: string,
): {
	state: SkillOptState | null;
	lastEvent: SkillOptEvent | null;
	truncated: boolean;
} {
	const replay = replayCandidate(directory, skillSlug, candidateId);
	if (replay.truncated && replay.badSuffix) {
		quarantineSuffix(directory, skillSlug, replay.badSuffix);
	}
	return {
		state:
			replay.events.length === 0
				? null
				: replay.events[replay.events.length - 1].toState,
		lastEvent:
			replay.events.length === 0
				? null
				: replay.events[replay.events.length - 1],
		truncated: replay.truncated,
	};
}

/** Whether a candidate has reached a terminal state. */
export function isTerminal(state: SkillOptState | null): boolean {
	return state === 'rejected' || state === 'expired' || state === 'rolled_back';
}

/** Re-export for callers that need the hash helper. */
export { computeStateHash };
