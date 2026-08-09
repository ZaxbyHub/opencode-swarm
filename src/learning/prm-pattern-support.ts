/**
 * PRM pattern persistence support tracking (issue #1821, AC10).
 *
 * PRM already detects recurring failure patterns (repetition loops, ping-pong,
 * context thrash, …) and injects a course correction. Those detections were
 * purely ephemeral: the same crew rediscovered the same pattern next session.
 * This module decides WHEN a detected pattern has earned a durable knowledge
 * entry, and turns it into an insight candidate for the normal bounded
 * admission path.
 *
 * Three properties matter, and each one is a defence against a specific way
 * this could go wrong:
 *
 * 1. **Identity** is `pattern|sortedAgents|sortedTargets`. Two different
 *    repetition loops in different files are different lessons.
 * 2. **Support counts DISTINCT OCCURRENCE STARTS.** PRM re-reports a live
 *    pattern on every subsequent tool call, and `pattern-detector.ts` emits
 *    `stepRange: [startStep, endStep]` with an ADVANCING `endStep` — so
 *    [1,2], [1,3], [1,4] are all the SAME incident. Counting whole ranges would
 *    let one continuous loop self-confirm to the threshold in seconds, so
 *    support is keyed on `stepRange[0]` instead.
 * 3. **Evidence is POINTERS ONLY** — `prm:<sid>:<pattern>:<start>-<end>`.
 *    Transcript text and model reasoning are NEVER copied into a durable
 *    record; a knowledge entry is shared across sessions and must not carry
 *    another session's content.
 *
 * Module state follows the same bounded shape as `./candidate-queue.ts`: FIFO
 * key eviction at `MAX_TRACKED_SESSIONS` plus a per-session identity cap
 * (AGENTS.md invariant 8). No I/O happens here — this runs on the PRM
 * `toolAfter` hot path.
 */

import type { InsightCandidate } from '../hooks/micro-reflector.js';
import type { PatternMatch } from '../prm/types.js';

/** Mirrors `candidate-queue.ts` / `adversarial-detector.ts`. */
const MAX_TRACKED_SESSIONS = 500;

/** Distinct pattern identities retained per session before FIFO eviction. */
const MAX_IDENTITIES_PER_SESSION = 64;

/** Distinct occurrences retained per identity. Support saturates here. */
const MAX_OCCURRENCES_PER_IDENTITY = 20;

/** Tuning knobs, mirroring `learning.prm_persistence`. */
export interface PrmSupportLimits {
	/** Distinct observations required before a pattern is persistable. */
	minSupport: number;
	/** Cooldown between persists for one identity, in milliseconds. */
	cooldownMs: number;
}

export interface PrmObservationResult {
	identity: string;
	/** Number of DISTINCT occurrence starts observed for this identity. */
	support: number;
	/** True when support met the threshold AND the cooldown has elapsed. */
	persistable: boolean;
	/** Why `persistable` is false. Absent when it is true. */
	reason?: 'below_support' | 'cooling_down' | 'unactionable';
	/** Bounded evidence pointers. Never contains transcript or reasoning text. */
	evidenceRefs: string[];
	/** Present only when `persistable` — ready for `enqueueCandidate`. */
	candidate?: InsightCandidate;
}

interface IdentityState {
	/**
	 * Occurrence START step -> the widest `[start, end]` window seen for it.
	 * Size IS the support count; the value keeps each evidence pointer accurate
	 * as the detector extends a still-live window.
	 */
	occurrences: Map<number, [number, number]>;
	/**
	 * Epoch millis this identity was first observed. Used as the emitted
	 * candidate's `created_at` so the candidate IDENTITY is stable across
	 * cooldown-spaced re-emissions of the same pattern (issue #1821 D1).
	 */
	firstSeenAt: number;
	/** Epoch millis of the last persist, or 0 when never persisted. */
	lastPersistedAt: number;
}

const supportBySession = new Map<string, Map<string, IdentityState>>();

/** Injectable clock — tests pin time instead of sleeping. */
export const _internals: { now: () => number } = { now: () => Date.now() };

/** Agent / tool names must satisfy the knowledge validator's NAME_PATTERN. */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Normalize a PRM agent label into the snake_case shape
 * `validateActionableFields` accepts, dropping anything that cannot be
 * represented. A candidate with no usable scope is never emitted.
 */
function normalizeAgentName(raw: string): string | undefined {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return NAME_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * Stable identity for a detected pattern.
 *
 * Agents and targets are sorted so detection order cannot mint a second
 * identity for the same underlying situation.
 */
function computePatternIdentity(
	match: Pick<PatternMatch, 'pattern' | 'affectedAgents' | 'affectedTargets'>,
): string {
	const agents = [...(match.affectedAgents ?? [])].sort().join(',');
	const targets = [...(match.affectedTargets ?? [])].sort().join(',');
	return `${match.pattern}|${agents}|${targets}`;
}

/**
 * Build ONE evidence pointer. Deliberately carries only the session id, the
 * pattern name, and the step window — enough to re-derive the evidence from
 * that session's own trajectory, and nothing that leaks its content.
 */
function buildPrmEvidenceRef(
	sessionID: string,
	pattern: string,
	stepRange: [number, number],
): string {
	return `prm:${sessionID}:${pattern}:${stepRange[0]}-${stepRange[1]}`;
}

function getOrCreateSessionMap(sessionID: string): Map<string, IdentityState> {
	let identities = supportBySession.get(sessionID);
	if (!identities) {
		identities = new Map<string, IdentityState>();
		supportBySession.set(sessionID, identities);
		// FIFO-cap the KEY count to bound memory. Skip the entry just created.
		while (supportBySession.size > MAX_TRACKED_SESSIONS) {
			const oldest = supportBySession.keys().next().value;
			if (oldest === undefined || oldest === sessionID) break;
			supportBySession.delete(oldest);
		}
	}
	return identities;
}

function getOrCreateIdentity(
	identities: Map<string, IdentityState>,
	identity: string,
): IdentityState {
	let state = identities.get(identity);
	if (!state) {
		state = {
			occurrences: new Map<number, [number, number]>(),
			firstSeenAt: _internals.now(),
			lastPersistedAt: 0,
		};
		identities.set(identity, state);
		while (identities.size > MAX_IDENTITIES_PER_SESSION) {
			const oldest = identities.keys().next().value;
			if (oldest === undefined || oldest === identity) break;
			identities.delete(oldest);
		}
	}
	return state;
}

/**
 * Build the durable lesson for a supported pattern.
 *
 * Returns undefined when the pattern yields no usable scope — an entry with no
 * `applies_to_agents` / `applies_to_tools` fails the Layer-5 actionability gate
 * and would only be quarantined, so it is better not to emit it at all.
 */
function buildPrmPatternCandidate(
	match: PatternMatch,
	evidenceRefs: string[],
	createdAt: string,
): InsightCandidate | undefined {
	const agents = [
		...new Set(
			(match.affectedAgents ?? [])
				.map(normalizeAgentName)
				.filter((name): name is string => name !== undefined),
		),
	].slice(0, 20);
	if (agents.length === 0) return undefined;

	// Deliberately free of the support COUNT and of any per-emission value.
	// `computeInsightCandidateId` hashes {lesson, taskId, createdAt}, so a lesson
	// that embedded the running count would mint a NEW candidate identity on every
	// cooldown-spaced re-emission — and a new identity carries a new
	// `insight:` marker, which is exactly what the D1 mechanism keys on. The
	// pattern would then be re-confirmed every cooldown, inflating confidence
	// toward hive auto-promotion from one continuously-recurring incident.
	const lesson =
		`Recurring ${match.pattern} pattern on ${match.affectedTargets?.[0] ?? 'this work'}: ` +
		'change approach instead of repeating the same step sequence.';

	return {
		lesson: lesson.slice(0, 280),
		category: 'process',
		tags: ['prm', match.category].filter(
			(tag): tag is string => typeof tag === 'string' && tag.length > 0,
		),
		applies_to_agents: agents,
		required_actions: [
			`change approach after a ${match.pattern} pattern rather than retrying the same steps`.slice(
				0,
				200,
			),
		],
		verification_checks: [
			`no repeated ${match.pattern} pattern in the following steps`.slice(
				0,
				200,
			),
		],
		// Evidence POINTERS only — never transcript or reasoning text.
		source_refs: evidenceRefs,
		source: {
			kind: 'prm_pattern',
			agent: agents[0],
			outcome: 'partial',
			trajectory_steps: match.stepRange?.[1] ?? 0,
		},
		created_at: createdAt,
	};
}

/**
 * Record one PRM pattern detection and report whether it now warrants a durable
 * knowledge entry.
 *
 * MUST be called only after PRM's `matches.length === 0` early return, so the
 * overwhelmingly common no-match path costs nothing.
 */
export function recordPatternObservation(
	sessionID: string,
	match: PatternMatch,
	limits: PrmSupportLimits,
): PrmObservationResult {
	const identity = computePatternIdentity(match);
	if (typeof sessionID !== 'string' || sessionID.length === 0) {
		return {
			identity,
			support: 0,
			persistable: false,
			reason: 'below_support',
			evidenceRefs: [],
		};
	}
	const identities = getOrCreateSessionMap(sessionID);
	const state = getOrCreateIdentity(identities, identity);

	const stepRange: [number, number] = match.stepRange ?? [0, 0];
	const startStep = stepRange[0];
	// Keyed on the occurrence START, NOT the whole range. `pattern-detector.ts`
	// emits `stepRange: [startStep, endStep]` and ADVANCES `endStep` on every
	// tool call while a pattern stays live, so one continuous incident produces
	// [1,2], [1,3], [1,4], … Keying on the whole range would count each of those
	// as a fresh observation and let a single four-step loop cross the default
	// min_support of 3 in seconds. A genuinely separate incident starts at a
	// different step; a growing one does not.
	const known = state.occurrences.get(startStep);
	if (known) {
		// Same incident, wider window: keep the pointer accurate, do not re-count.
		if (stepRange[1] > known[1]) known[1] = stepRange[1];
	} else if (state.occurrences.size < MAX_OCCURRENCES_PER_IDENTITY) {
		state.occurrences.set(startStep, [stepRange[0], stepRange[1]]);
	}

	const support = state.occurrences.size;
	const evidenceRefs = [...state.occurrences.values()].map((range) =>
		buildPrmEvidenceRef(sessionID, match.pattern, range),
	);
	const minSupport = Math.max(1, Math.floor(Number(limits.minSupport) || 1));
	if (support < minSupport) {
		return {
			identity,
			support,
			persistable: false,
			reason: 'below_support',
			evidenceRefs,
		};
	}

	const now = _internals.now();
	const cooldownMs = Math.max(0, Number(limits.cooldownMs) || 0);
	if (state.lastPersistedAt > 0 && now - state.lastPersistedAt < cooldownMs) {
		return {
			identity,
			support,
			persistable: false,
			reason: 'cooling_down',
			evidenceRefs,
		};
	}

	// Stable `created_at` = first observation of THIS identity, so every
	// re-emission of the same pattern resolves to the SAME candidate id (and
	// therefore the same `insight:` marker) and admission reports
	// `already_admitted` instead of re-confirming.
	const candidate = buildPrmPatternCandidate(
		match,
		evidenceRefs,
		new Date(state.firstSeenAt).toISOString(),
	);
	if (!candidate) {
		return {
			identity,
			support,
			persistable: false,
			reason: 'unactionable',
			evidenceRefs,
		};
	}

	// Start the cooldown at the moment we hand the candidate over, so a burst of
	// detections in the same window cannot enqueue the same lesson repeatedly.
	state.lastPersistedAt = now;
	return { identity, support, persistable: true, evidenceRefs, candidate };
}

/** Read-only support view for one identity. Test/observability seam. */
function getPatternSupport(
	sessionID: string,
	identity: string,
): { support: number; lastPersistedAt: number; occurrenceStarts: number[] } {
	const state = supportBySession.get(sessionID)?.get(identity);
	if (!state) return { support: 0, lastPersistedAt: 0, occurrenceStarts: [] };
	return {
		support: state.occurrences.size,
		lastPersistedAt: state.lastPersistedAt,
		occurrenceStarts: [...state.occurrences.keys()],
	};
}

/** Drop one session's support state, or every session when omitted. */
export function resetPrmPatternSupport(sessionID?: string): void {
	if (sessionID === undefined) {
		supportBySession.clear();
		return;
	}
	supportBySession.delete(sessionID);
}

/** Number of distinct sessions tracked. Bound-eviction test seam. */
function getTrackedPrmSessionCount(): number {
	return supportBySession.size;
}

/** Number of distinct identities tracked for a session. */
function getTrackedPrmIdentityCount(sessionID: string): number {
	return supportBySession.get(sessionID)?.size ?? 0;
}

/**
 * Tier-0 pure-function and observability seam (see the writing-tests skill, and
 * the sibling seam in `candidate-queue.ts`).
 *
 * Everything here was a bare `export` with no importer outside the tests — the
 * three caps, the three pure builders, and the three read-only probes. The issue
 * #1821 dead-export pass moved them behind this seam rather than deleting them:
 * each is genuinely needed to assert a bound or a pure mapping that the public
 * `recordPatternObservation` path only exercises indirectly, but as bare exports
 * they were indistinguishable from public API and read as unwired code.
 *
 * `_internals` stays separate and stays small: it is the DI seam tests
 * SUBSTITUTE (the clock). Nothing below is substitutable.
 */
export const _test_exports = {
	buildPrmEvidenceRef,
	buildPrmPatternCandidate,
	computePatternIdentity,
	getPatternSupport,
	getTrackedPrmIdentityCount,
	getTrackedPrmSessionCount,
	MAX_IDENTITIES_PER_SESSION,
	MAX_OCCURRENCES_PER_IDENTITY,
	MAX_TRACKED_SESSIONS,
};
