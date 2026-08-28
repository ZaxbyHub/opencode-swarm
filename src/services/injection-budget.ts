/**
 * Unified Injection Budget Service (FR-002).
 *
 * Pure, side-effect-free allocation function for the combined
 * system-enhancer + knowledge-injector injection ceiling.
 *
 * Allocation strategy: proportional share.
 * - When combined demand fits within the budget, each component receives its
 *   full requested amount.
 * - When one component alone exceeds the budget, it receives the entire budget
 *   and the other receives zero (SC-005: single-component overrun is impossible).
 * - When both together exceed the budget but neither alone does, the budget is
 *   split proportionally to each component's demand. The system-enhancer
 *   receives the floor of its proportional share; the knowledge-injector
 *   receives the remainder so the total always equals the ceiling (SC-006).
 *
 * Proportional share is chosen over first-come-first-served because this
 * service is a pure function with no knowledge of hook ordering; it must
 * produce the same allocation regardless of which component calls first.
 * Priority-based allocation would require an arbitrary component ranking
 * not specified by the acceptance criteria.
 *
 * Char-to-token conversion goes through the canonical estimator
 * (`estimateTokensFromCharCount` in src/hooks/utils.ts — issue #1616/#2107).
 */

import { estimateTokensFromCharCount } from '../hooks/utils';

/**
 * Allocation result for a single turn's unified injection budget.
 */
export interface InjectionBudgetAllocation {
	/** Tokens granted to the system-enhancer (input was already in tokens). */
	systemEnhancerTokens: number;
	/** Tokens granted to the knowledge-injector (converted from chars to tokens). */
	knowledgeInjectorTokens: number;
	/** Sum of both allocations; never exceeds the configured budget. */
	totalTokens: number;
}

/**
 * Configuration for the unified injection budget.
 */
export interface InjectionBudgetConfig {
	/** Unified ceiling (tokens) for combined system-enhancer + knowledge-injector injection per turn. */
	totalBudgetTokens: number;
}

/**
 * Convert a character count to tokens via the canonical estimator
 * (`estimateTokensFromCharCount` in src/hooks/utils.ts — issue #1616/#2107).
 */
function charsToTokens(chars: number): number {
	return estimateTokensFromCharCount(chars);
}

/**
 * Allocate the unified injection budget between system-enhancer and
 * knowledge-injector for a single turn.
 *
 * The allocation respects the configured ceiling and guarantees:
 * - totalTokens ≤ config.totalBudgetTokens
 * - If one component alone exceeds the budget, the other receives zero.
 * - If combined demand fits, each receives its full demand.
 * - If combined demand exceeds the budget but neither alone does, the split
 *   is proportional to each component's demand.
 *
 * @param systemEnhancerDemandTokens - Tokens requested by the system-enhancer.
 * @param knowledgeInjectorDemandChars - Characters requested by the knowledge-injector.
 * @param config - Budget configuration containing the total ceiling.
 * @returns Allocation breakdown with per-component token grants.
 */
export function allocateInjectionBudget(
	systemEnhancerDemandTokens: number,
	knowledgeInjectorDemandChars: number,
	config: InjectionBudgetConfig,
): InjectionBudgetAllocation {
	const budget = config.totalBudgetTokens;

	// Clamp negative inputs to zero (defensive; callers should pass non-negative values).
	const seDemand = Math.max(0, systemEnhancerDemandTokens);
	const kiChars = Math.max(0, knowledgeInjectorDemandChars);
	const ceiling = Math.max(0, budget);

	// Convert knowledge-injector demand to tokens for comparison.
	const kiDemand = charsToTokens(kiChars);

	// Fast path: both demands fit within the budget.
	if (seDemand + kiDemand <= ceiling) {
		return {
			systemEnhancerTokens: seDemand,
			knowledgeInjectorTokens: kiDemand,
			totalTokens: seDemand + kiDemand,
		};
	}

	// Single-component overrun: the component that alone exceeds the ceiling
	// receives the entire budget; the other receives zero.
	if (seDemand >= ceiling) {
		return {
			systemEnhancerTokens: ceiling,
			knowledgeInjectorTokens: 0,
			totalTokens: ceiling,
		};
	}

	if (kiDemand >= ceiling) {
		return {
			systemEnhancerTokens: 0,
			knowledgeInjectorTokens: ceiling,
			totalTokens: ceiling,
		};
	}

	// Proportional share: both together exceed the budget, but neither alone does.
	// System-enhancer gets the floor of its proportional share; knowledge-injector
	// receives the remainder so the total equals the ceiling exactly.
	const totalDemand = seDemand + kiDemand;
	const seShare = Math.floor((seDemand / totalDemand) * ceiling);
	const kiShare = ceiling - seShare;

	return {
		systemEnhancerTokens: seShare,
		knowledgeInjectorTokens: kiShare,
		totalTokens: ceiling,
	};
}

// ---------------------------------------------------------------------------
// Per-session, per-turn producer ledger (issue #2107 §2; supersedes the FR-002
// "legacy stateful session-ledger API" that shipped with zero production
// callers). One ledger per session; the system-enhancer begins it exactly once
// per request composition; every producer that contributes to the model-visible
// request either claims from it or records its emission as fixed/base content.
// ---------------------------------------------------------------------------

/**
 * Producers that contribute to the model-visible request surface. The
 * `surface` on each accounting entry records WHERE the producer's bytes live:
 * `'system'` entries are pushed to `output.system` in the system.transform
 * chain (invisible to the messages chain and to final accounting's direct
 * measurement of `output.messages` — they MUST be added to the final total via
 * this ledger); `'messages'` entries are spliced into `output.messages` and are
 * therefore already inside the final measurement (attribution only — adding
 * them again would double-count).
 */
export type InjectionProducer =
	| 'system-enhancer'
	| 'knowledge-injector'
	| 'context-capsule'
	| 'memory-recall'
	| 'advisory-queue'
	| 'swarm-command-banner'
	| 'context-budget-warning'
	| 'final-accounting-warning';

export type InjectionSurface = 'system' | 'messages';

export interface ProducerAccounting {
	/** Tokens the producer asked the ledger for this turn (claims only). */
	requested: number;
	/** Tokens the ledger granted under the ceiling + local max (claims only). */
	granted: number;
	/** Tokens actually emitted to the model-visible surface. */
	emitted: number;
	/** Tokens the producer wanted but did not emit (its own pruning). */
	truncated: number;
	surface: InjectionSurface;
	/** True when the producer ran with NO ledger present (fail-open, #1617). */
	failOpen: boolean;
}

export interface TurnLedgerSummary {
	generation: number;
	totalBudget: number;
	/** Ceiling enforcement is only active when `unified_injection_tokens` is configured. */
	ceilingActive: boolean;
	used: number;
	producers: Array<{ producer: InjectionProducer } & ProducerAccounting>;
}

interface TurnLedger {
	generation: number;
	totalBudget: number;
	ceilingActive: boolean;
	used: number;
	producers: Map<InjectionProducer, ProducerAccounting>;
}

const turnLedgers = new Map<string, TurnLedger>();

// ============================================================================
// Bounded session tracking (AGENTS.md invariant 8)
// ============================================================================

const MAX_TRACKED_SESSIONS = 256;

/** Global monotonic turn generation. Embedded per ledger so any consumer can
 * observe that a new request composition began. */
let turnGenerationCounter = 0;

function evictTurnLedgers(): void {
	while (turnLedgers.size > MAX_TRACKED_SESSIONS) {
		const firstKey = turnLedgers.keys().next().value;
		if (firstKey === undefined) break;
		turnLedgers.delete(firstKey);
	}
}

function getOrCreateAccounting(
	ledger: TurnLedger,
	producer: InjectionProducer,
	surface: InjectionSurface,
): ProducerAccounting {
	let accounting = ledger.producers.get(producer);
	if (!accounting) {
		accounting = {
			requested: 0,
			granted: 0,
			emitted: 0,
			truncated: 0,
			surface,
			failOpen: false,
		};
		ledger.producers.set(producer, accounting);
	}
	accounting.surface = surface;
	return accounting;
}

/**
 * Begin a new turn ledger for a session: reset exactly once at the start of
 * composing that request (the system-enhancer is the first producer and calls
 * this). Mints a fresh generation, so any stale claim from a prior composition
 * is discarded. `ceilingActive` is only true when
 * `context_budget.unified_injection_tokens` is configured; when false the
 * ledger records accounting but never denies a claim (default configs keep
 * their pre-#2107 behavior).
 */
export function beginTurnLedger(
	sessionID: string,
	totalBudget: number,
	ceilingActive: boolean,
): number {
	const generation = ++turnGenerationCounter;
	turnLedgers.set(sessionID, {
		generation,
		totalBudget: Math.max(0, totalBudget),
		ceilingActive,
		used: 0,
		producers: new Map(),
	});
	evictTurnLedgers();
	return generation;
}

/**
 * Claim tokens from the turn ledger. The grant is bounded by the producer's
 * own local maximum (`localMaxTokens`) and, only when the ceiling is active,
 * by what remains of the unified ceiling. When NO ledger exists for the session
 * (system-enhancer never ran this turn — native agent, first turn, or hook
 * disabled), the claim fails open to the local maximum and is not recorded,
 * preserving #1617's fail-open contract; the caller is expected to report that
 * the hard ceiling was unavailable.
 */
export function claimTurnBudget(
	sessionID: string,
	producer: InjectionProducer,
	requestedTokens: number,
	opts?: { localMaxTokens?: number; surface?: InjectionSurface },
): { granted: number; ledgerPresent: boolean; ceilingActive: boolean } {
	const requested = Math.max(0, requestedTokens);
	const localMax =
		opts?.localMaxTokens === undefined
			? requested
			: Math.max(0, opts.localMaxTokens);
	const surface = opts?.surface ?? 'system';

	const ledger = turnLedgers.get(sessionID);
	if (!ledger) {
		return {
			granted: Math.min(requested, localMax),
			ledgerPresent: false,
			ceilingActive: false,
		};
	}

	const accounting = getOrCreateAccounting(ledger, producer, surface);
	accounting.requested += requested;

	let granted: number;
	if (!ledger.ceilingActive) {
		granted = Math.min(requested, localMax);
	} else {
		const remaining = Math.max(0, ledger.totalBudget - ledger.used);
		granted = Math.min(requested, localMax, remaining);
		ledger.used += granted;
	}
	accounting.granted += granted;
	return { granted, ledgerPresent: true, ceilingActive: ledger.ceilingActive };
}

/**
 * Record a producer's grant without claiming through `claimTurnBudget`.
 *
 * The system-enhancer and knowledge-injector enforce their split through the
 * pure `allocateInjectionBudget` (FR-002 contract, pinned by tests) rather than
 * sequential claims; this books their allocator-derived grants into the shared
 * ceiling so later claimants (capsule, memory recall) draw from what actually
 * remains. When the ceiling is inactive the grant is recorded but deducts
 * nothing. The deduction is clamped to the remaining budget so `used` can never
 * exceed `totalBudget`.
 */
export function recordProducerGrant(
	sessionID: string,
	producer: InjectionProducer,
	requestedTokens: number,
	grantedTokens: number,
	surface: InjectionSurface,
): void {
	const ledger = turnLedgers.get(sessionID);
	if (!ledger) return;
	const accounting = getOrCreateAccounting(ledger, producer, surface);
	accounting.requested += Math.max(0, requestedTokens);
	const granted = Math.max(0, grantedTokens);
	accounting.granted += granted;
	if (ledger.ceilingActive) {
		ledger.used += Math.min(
			granted,
			Math.max(0, ledger.totalBudget - ledger.used),
		);
	}
}

/**
 * Record what a producer actually emitted (and pruned itself) this turn.
 * Producers that never claim (fixed/base content: advisory queue, banners,
 * the context-budget warning, the final-accounting warning) still record their
 * emission here so the final accounting can include them.
 */
export function recordProducerEmission(
	sessionID: string,
	producer: InjectionProducer,
	emittedTokens: number,
	truncatedTokens: number,
	surface: InjectionSurface,
): void {
	const ledger = turnLedgers.get(sessionID);
	if (!ledger) return;
	const accounting = getOrCreateAccounting(ledger, producer, surface);
	accounting.emitted += Math.max(0, emittedTokens);
	accounting.truncated += Math.max(0, truncatedTokens);
}

/**
 * Snapshot of the session's current turn ledger (null when absent).
 */
export function getTurnLedgerSummary(
	sessionID: string,
): TurnLedgerSummary | null {
	const ledger = turnLedgers.get(sessionID);
	if (!ledger) return null;
	return {
		generation: ledger.generation,
		totalBudget: ledger.totalBudget,
		ceilingActive: ledger.ceilingActive,
		used: ledger.used,
		producers: Array.from(ledger.producers.entries()).map(([producer, a]) => ({
			producer,
			requested: a.requested,
			granted: a.granted,
			emitted: a.emitted,
			truncated: a.truncated,
			surface: a.surface,
			failOpen: a.failOpen,
		})),
	};
}

/**
 * Emitted tokens recorded for one producer this turn (0 when no ledger or the
 * producer has not run). Replaces the old `getSystemEnhancerDemand` relay: the
 * knowledge-injector reads the system-enhancer's actual emission from here.
 */
export function getProducerEmission(
	sessionID: string,
	producer: InjectionProducer,
): number {
	return turnLedgers.get(sessionID)?.producers.get(producer)?.emitted ?? 0;
}

/**
 * Advance the turn generation for a session: the current ledger is discarded so
 * the next request composition starts from a fresh generation. Called when
 * compaction changes the message surface (`experimental.session.compacting`)
 * and at session teardown.
 */
export function advanceTurnGeneration(sessionID: string): void {
	turnLedgers.delete(sessionID);
}

/**
 * Test/maintenance hook: clear one session's ledger.
 */
export function clearTurnLedger(sessionID: string): void {
	turnLedgers.delete(sessionID);
}
