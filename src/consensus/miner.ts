/**
 * The consensus miner (issue #1821, Workstream C).
 *
 * Reads the read-only corpus, counts agreement deterministically, gates the
 * result, and emits a report. It is a **proposals-only** boundary: it activates
 * no skill, writes no knowledge, and mutates no artifact. The single write in
 * this subsystem lives in `./store.ts` and persists the report itself.
 *
 * Ordering is a correctness property, not a style choice. The pipeline is:
 *
 *   1. deterministic filtering
 *   2. deterministic co-occurrence + distinct-run support counting
 *   3. deterministic gates (support, successful runs, task diversity)
 *   4. deterministic retention of negative evidence
 *   5. deterministic proposal + fingerprint construction
 *   6. ONLY THEN, optional LLM restatement of `statement`
 *
 * Step 6 last is what makes the miner reproducible and what keeps a model from
 * influencing whether something qualifies. A model may only rephrase a
 * conclusion the arithmetic already reached. If no dispatcher is available, or
 * the call times out, or summarization is disabled, every attribute keeps its
 * deterministic statement — graceful degradation, never a hard dependency.
 */

import type { ConsensusConfig } from '../config/schema.js';
import { canonicalHash } from '../evaluation/hashing.js';
import type { EvaluationModelDispatcher } from '../evaluation/model-dispatcher.js';
import { computeRecommendationFingerprint } from '../learning/fingerprint.js';
import { stampLearningProvenance } from '../learning/provenance.js';
import { computeRedactionPolicyVersion } from '../memory/redaction.js';
import type {
	ConsensusAttributeV1,
	ConsensusMineRequest,
	ConsensusProposedTarget,
	ConsensusReportV1,
	ProposedSkillChange,
	ProposedSkillChangeProvenance,
} from './contracts.js';
import {
	ConsensusReportV1Schema,
	MAX_CONSENSUS_REFS,
	MAX_CONSENSUS_STATEMENT_CHARS,
} from './contracts.js';
import type { ConsensusCorpus, CorpusObservation } from './corpus.js';
import { loadConsensusCorpus, sanitizeExcerpt } from './corpus.js';

/**
 * Minimum distinct task identities before an attribute may become a proposal.
 *
 * Two is not a tuning knob. One anecdote — one task, however many times it was
 * observed — cannot distinguish "this is how the system behaves" from "this is
 * how that one task behaves". Below this an attribute is still emitted, as an
 * investigation note with `proposedTarget: 'none'`, because suppressing it
 * entirely would hide the very evidence a human needs to decide whether to go
 * looking for a second task.
 */
export const MIN_TASK_DIVERSITY_FOR_PROPOSAL = 2;

/** Laplace-style smoothing on the support term of `confidence`. */
const CONFIDENCE_SUPPORT_SMOOTHING = 3;

/** Confidence multiplier applied while an attribute is below the task gate. */
const UNDIVERSE_CONFIDENCE_FACTOR = 0.5;

/**
 * Hard cap on LLM restatement calls per report. Summarization is a cosmetic
 * pass over an already-final result, so it gets a small fixed budget rather
 * than scaling with corpus size (AGENTS.md invariant 1: bounded is not free).
 */
export const MAX_LLM_SUMMARIES = 20;

/** Logical agent the summarization dispatch targets. */
const SUMMARIZATION_AGENT = 'curator_postmortem';

export interface MineConsensusDeps {
	/** Effective consensus configuration. Required — the miner reads no config. */
	config: ConsensusConfig;
	/** Corpus loader override. Defaults to the real read-only loader. */
	loadCorpus?: (
		directory: string,
		options: { maxEvidenceItems: number; maxExcerptChars: number },
	) => Promise<ConsensusCorpus>;
	/**
	 * Optional LLM dispatcher. Absent ⇒ deterministic statements are kept.
	 * Injected rather than constructed so the miner never reaches for a runtime
	 * client and stays unit-testable without one.
	 */
	dispatcher?: EvaluationModelDispatcher;
	/** Model id for summarization dispatches. */
	summarizationModelId?: string;
	/** Prefixed-swarm selector forwarded to the dispatcher. */
	preferredSwarm?: string;
	/** Parent session for dispatched child sessions. */
	sessionId?: string;
	/** Agent role recorded in proposal provenance. */
	agentRole?: string;
	/**
	 * Fingerprints already proposed by earlier reports. A proposal whose
	 * fingerprint appears here is suppressed so a standing recommendation is not
	 * re-proposed on every mining run.
	 */
	priorFingerprints?: Iterable<string>;
	/** Clock seam. Defaults to `Date.now`-backed ISO output. */
	now?: () => Date;
}

export interface MineConsensusResult {
	report: ConsensusReportV1;
	/** True when `maxEvidenceItems` truncated the corpus. */
	truncated: boolean;
	/** Corpus sources that could not be read. */
	unreadableSources: string[];
	/** Attributes emitted as investigation notes rather than proposals. */
	investigationNoteCount: number;
	/** Proposals suppressed because a prior report already carries them. */
	dedupedProposalCount: number;
	/** How many statements the LLM actually restated. */
	summarizedCount: number;
	/** Why summarization did not run, when it did not. */
	summarizationSkippedReason?:
		| 'disabled_by_config'
		| 'no_dispatcher'
		| 'no_attributes';
}

// ---------------------------------------------------------------------------
// Step 1 — deterministic filtering
// ---------------------------------------------------------------------------

/**
 * Apply the request's filters.
 *
 * Each filter is an intersection over a *declared* field: an observation whose
 * `modelId` is absent is excluded by a `modelIds` filter rather than passed
 * through, because "no model recorded" is not evidence that the requested model
 * was involved. `runIds` matches either the raw id or the namespaced corpus id
 * (`evaluation-run:<id>`), so a caller can pass the run id it already knows.
 */
export function filterObservations(
	observations: readonly CorpusObservation[],
	request: ConsensusMineRequest,
): CorpusObservation[] {
	const runIds = request.runIds ? new Set(request.runIds) : undefined;
	const categories = request.taskCategories
		? new Set(request.taskCategories)
		: undefined;
	const roles = request.agentRoles ? new Set(request.agentRoles) : undefined;
	const models = request.modelIds ? new Set(request.modelIds) : undefined;

	return observations.filter((observation) => {
		if (runIds) {
			const bare = observation.runId.slice(observation.runId.indexOf(':') + 1);
			if (!runIds.has(observation.runId) && !runIds.has(bare)) return false;
		}
		if (categories) {
			if (
				observation.taskCategory === undefined ||
				!categories.has(observation.taskCategory)
			) {
				return false;
			}
		}
		if (roles) {
			if (
				observation.agentRole === undefined ||
				!roles.has(observation.agentRole)
			) {
				return false;
			}
		}
		if (models) {
			if (
				observation.modelId === undefined ||
				!models.has(observation.modelId)
			) {
				return false;
			}
		}
		return true;
	});
}

// ---------------------------------------------------------------------------
// Step 2 — deterministic co-occurrence and support counting
// ---------------------------------------------------------------------------

export interface SignalTally {
	signal: string;
	/** Distinct run ids carrying the signal at all. */
	runIds: Set<string>;
	/** Distinct run ids carrying it on a SUCCEEDING observation. */
	successRunIds: Set<string>;
	/** Distinct run ids carrying it on a FAILING observation. */
	failureRunIds: Set<string>;
	/** Distinct task identities (`taskId`, else `taskCategory`). */
	taskKeys: Set<string>;
	/** Distinct model ids. Empty ⇒ not measurable, not "none". */
	modelIds: Set<string>;
	/** Evidence refs from succeeding observations, insertion-ordered. */
	evidenceRefs: string[];
	/** Evidence refs from FAILING observations. Never discarded. */
	counterexampleRefs: string[];
}

/**
 * Tally every signal across the filtered corpus.
 *
 * Support is DISTINCT RUNS, not observations: a single run that emits the same
 * signal a hundred times contributes exactly one to `support`. Without that, a
 * chatty trajectory would manufacture consensus by itself.
 */
export function tallySignals(
	observations: readonly CorpusObservation[],
): Map<string, SignalTally> {
	const tallies = new Map<string, SignalTally>();
	for (const observation of observations) {
		const taskKey = observation.taskId ?? observation.taskCategory;
		for (const signal of observation.signals) {
			let tally = tallies.get(signal);
			if (!tally) {
				tally = {
					signal,
					runIds: new Set(),
					successRunIds: new Set(),
					failureRunIds: new Set(),
					taskKeys: new Set(),
					modelIds: new Set(),
					evidenceRefs: [],
					counterexampleRefs: [],
				};
				tallies.set(signal, tally);
			}
			tally.runIds.add(observation.runId);
			if (observation.success) {
				tally.successRunIds.add(observation.runId);
				if (tally.evidenceRefs.length < MAX_CONSENSUS_REFS) {
					tally.evidenceRefs.push(observation.evidenceRef);
				}
			} else {
				tally.failureRunIds.add(observation.runId);
				if (tally.counterexampleRefs.length < MAX_CONSENSUS_REFS) {
					tally.counterexampleRefs.push(observation.evidenceRef);
				}
			}
			if (taskKey !== undefined) tally.taskKeys.add(taskKey);
			if (observation.modelId !== undefined) {
				tally.modelIds.add(observation.modelId);
			}
		}
	}
	return tallies;
}

// ---------------------------------------------------------------------------
// Steps 3–4 — gating, negative-evidence retention, statement rendering
// ---------------------------------------------------------------------------

/** A signal's namespace decides where a qualifying attribute would be actioned. */
function targetFromSignal(signal: string): ConsensusProposedTarget {
	const domain = signal.slice(0, signal.indexOf(':'));
	switch (domain) {
		case 'skill':
		case 'prompt':
		case 'tooling':
		case 'orchestration':
			return domain;
		default:
			return 'none';
	}
}

/** Human-readable rendering of a namespaced signal. */
function humanizeSignal(signal: string): string {
	const parts = signal.split(':');
	return parts.slice(1).join(' / ') || signal;
}

/**
 * Deterministic confidence in [0, 1].
 *
 * Three independent factors, all monotonic and all derived from counts the
 * caller can re-derive from the report:
 * - support saturation, so a 3-run agreement scores below a 30-run agreement;
 * - the successful-run ratio, so retained negative evidence actually costs the
 *   attribute confidence rather than merely being listed beside it;
 * - a halving while below the task-diversity gate, so investigation notes are
 *   visibly weaker than proposals without being reported as worthless.
 */
export function computeConfidence(
	support: number,
	successSupport: number,
	taskDiversity: number,
): number {
	if (support <= 0) return 0;
	const supportFactor = support / (support + CONFIDENCE_SUPPORT_SMOOTHING);
	const successRatio = successSupport / support;
	const diversityFactor =
		taskDiversity >= MIN_TASK_DIVERSITY_FOR_PROPOSAL
			? 1
			: UNDIVERSE_CONFIDENCE_FACTOR;
	const raw = supportFactor * successRatio * diversityFactor;
	// Three decimals: enough to order attributes, few enough that floating-point
	// noise cannot change a report's integrity hash between identical runs.
	return Math.min(1, Math.max(0, Math.round(raw * 1000) / 1000));
}

/** Stable attribute id derived from the signal alone, so it survives rewording. */
export function computeAttributeId(signal: string): string {
	return `cattr_${canonicalHash({ signal }).slice(0, 16)}`;
}

function renderStatement(
	tally: SignalTally,
	support: number,
	successSupport: number,
	failureSupport: number,
	maxExcerptChars: number,
): string {
	const subject = humanizeSignal(tally.signal);
	const diversity = tally.taskKeys.size;
	const scope =
		diversity >= MIN_TASK_DIVERSITY_FOR_PROPOSAL
			? `${diversity} distinct tasks`
			: diversity === 1
				? '1 task (single-task evidence)'
				: 'no attributed task (task attribution unavailable)';
	const rendered =
		`${subject} recurs across ${support} independent run(s) spanning ${scope}: ` +
		`${successSupport} succeeded, ${failureSupport} failed.`;
	return sanitizeExcerpt(
		rendered,
		Math.min(MAX_CONSENSUS_STATEMENT_CHARS, Math.max(64, maxExcerptChars * 2)),
	);
}

/**
 * Turn tallies into gated attributes.
 *
 * A tally that clears `minSupport` and `minSuccessfulRuns` becomes an attribute.
 * If it also clears the task-diversity gate AND draws support from more than one
 * run, it keeps its signal's target and is proposal-eligible; otherwise its
 * target is forced to `'none'` and it is an investigation note. Anything below
 * the support or successful-run thresholds is dropped entirely.
 */
export function buildAttributes(
	tallies: ReadonlyMap<string, SignalTally>,
	request: ConsensusMineRequest,
	maxExcerptChars: number,
): ConsensusAttributeV1[] {
	const attributes: ConsensusAttributeV1[] = [];
	// Sort by signal so attribute order — and therefore the report hash — does
	// not depend on Map insertion order.
	for (const tally of [...tallies.values()].sort((left, right) =>
		left.signal.localeCompare(right.signal),
	)) {
		const support = tally.runIds.size;
		const successSupport = tally.successRunIds.size;
		const failureSupport = tally.failureRunIds.size;
		if (support < request.minSupport) continue;
		if (successSupport < request.minSuccessfulRuns) continue;

		const taskDiversity = tally.taskKeys.size;
		const qualifies =
			taskDiversity >= MIN_TASK_DIVERSITY_FOR_PROPOSAL && support > 1;
		attributes.push({
			v: 1,
			id: computeAttributeId(tally.signal),
			statement: renderStatement(
				tally,
				support,
				successSupport,
				failureSupport,
				maxExcerptChars,
			),
			support,
			successSupport,
			failureSupport,
			taskDiversity,
			// Distinct model ids, or 0 when the corpus carries no model attribution
			// for this signal. Never consulted as a gate — see the contract doc.
			modelDiversity: tally.modelIds.size,
			evidenceRefs: [...tally.evidenceRefs].sort(),
			// Negative evidence is retained unconditionally. There is no branch
			// anywhere in this function that can drop it.
			counterexampleRefs: [...tally.counterexampleRefs].sort(),
			confidence: computeConfidence(support, successSupport, taskDiversity),
			proposedTarget: qualifies ? targetFromSignal(tally.signal) : 'none',
		});
	}
	return attributes;
}

// ---------------------------------------------------------------------------
// Step 5 — proposals
// ---------------------------------------------------------------------------

/** The metric a validation run should move, per proposal target. */
const EXPECTED_METRIC: Record<
	Exclude<ConsensusProposedTarget, 'none'>,
	string
> = {
	skill: 'skill-usage.compliance_rate',
	prompt: 'evidence.verdict_pass_rate',
	tooling: 'evaluation.scored_outcome_rate',
	orchestration: 'trajectory.step_failure_rate',
};

/**
 * Build one proposal per proposal-eligible attribute.
 *
 * The fingerprint is computed from the DETERMINISTIC statement, never the
 * LLM-restated one — which is why this runs before summarization. Otherwise a
 * model rewording the same conclusion on a later run would mint a new
 * fingerprint and defeat the very deduplication the fingerprint exists for.
 */
export function buildProposals(
	attributes: readonly ConsensusAttributeV1[],
	observations: readonly CorpusObservation[],
	options: {
		/** Attribute id → the signal it was derived from, for intent rendering. */
		signalById: ReadonlyMap<string, string>;
		priorFingerprints: ReadonlySet<string>;
		producedAt: string;
		sessionId?: string;
		agentRole?: string;
	},
): { proposals: ProposedSkillChange[]; deduped: number } {
	const proposals: ProposedSkillChange[] = [];
	const seen = new Set<string>();
	let deduped = 0;

	const categories = [
		...new Set(
			observations
				.map((observation) => observation.taskCategory)
				.filter((value): value is string => value !== undefined),
		),
	].sort();
	const runIds = [
		...new Set(observations.map((observation) => observation.runId)),
	].sort();
	const modelIds = [
		...new Set(
			observations
				.map((observation) => observation.modelId)
				.filter((value): value is string => value !== undefined),
		),
	].sort();
	const taskIds = [
		...new Set(
			observations
				.map((observation) => observation.taskId)
				.filter((value): value is string => value !== undefined),
		),
	].sort();

	const validationSelector = sanitizeExcerpt(
		categories.length > 0
			? `taskCategories=${categories.join(',')}`
			: taskIds.length > 0
				? `taskIds=${taskIds.join(',')}`
				: 'scope=full-corpus',
		1024,
	);

	for (const attribute of attributes) {
		if (attribute.proposedTarget === 'none') continue;
		const fingerprint = computeRecommendationFingerprint({
			kind: 'miner',
			target: attribute.proposedTarget,
			statement: attribute.statement,
			scopeKeys: categories,
		});
		if (options.priorFingerprints.has(fingerprint) || seen.has(fingerprint)) {
			deduped += 1;
			continue;
		}
		seen.add(fingerprint);

		const provenance = stampLearningProvenance(
			{
				mechanism: 'consensus_mine',
				sourceEvidenceRefs: attribute.evidenceRefs,
				sourceRunIds: runIds,
				sourceModelIds: modelIds,
				sourceTaskIds: taskIds,
			},
			{
				producedAt: options.producedAt,
				sessionId: options.sessionId,
				agentRole: options.agentRole,
			},
		) as ProposedSkillChangeProvenance;

		proposals.push({
			target: attribute.proposedTarget,
			intent: sanitizeExcerpt(
				`Investigate the smallest ${attribute.proposedTarget} change that would remove the observed pattern: ${humanizeSignal(
					options.signalById.get(attribute.id) ?? attribute.id,
				)}.`,
				MAX_CONSENSUS_STATEMENT_CHARS,
			),
			evidenceRefs: attribute.evidenceRefs,
			counterexampleRefs: attribute.counterexampleRefs,
			confidence: attribute.confidence,
			expectedMetric: EXPECTED_METRIC[attribute.proposedTarget],
			validationSelector,
			fingerprint,
			provenance,
		});
	}
	return { proposals, deduped };
}

// ---------------------------------------------------------------------------
// Step 6 — optional LLM restatement (LAST)
// ---------------------------------------------------------------------------

const SUMMARIZATION_SYSTEM =
	'You restate an already-computed statistical finding in one sentence. ' +
	'You may not add claims, causes, recommendations, or numbers that are not in the input. ' +
	'Reply with the sentence only.';

/**
 * Optionally restate each attribute's `statement`.
 *
 * Every failure mode — no dispatcher, disabled config, non-`completed` status,
 * empty text, a thrown dispatcher — leaves the deterministic statement in place.
 * The returned attributes are otherwise untouched: nothing here can change a
 * count, a gate outcome, a target, or a confidence.
 */
async function summarizeStatements(
	attributes: ConsensusAttributeV1[],
	deps: MineConsensusDeps,
	directory: string,
): Promise<{
	attributes: ConsensusAttributeV1[];
	summarized: number;
	skipped?: MineConsensusResult['summarizationSkippedReason'];
}> {
	if (attributes.length === 0) {
		return { attributes, summarized: 0, skipped: 'no_attributes' };
	}
	if (!deps.config.llm_summarization_enabled) {
		return { attributes, summarized: 0, skipped: 'disabled_by_config' };
	}
	const dispatcher = deps.dispatcher;
	if (!dispatcher) {
		return { attributes, summarized: 0, skipped: 'no_dispatcher' };
	}

	// Highest-confidence first, ties broken by id so the budget is spent
	// deterministically. `attributes` itself keeps its canonical signal order.
	const budget = [...attributes]
		.sort(
			(left, right) =>
				right.confidence - left.confidence || left.id.localeCompare(right.id),
		)
		.slice(0, MAX_LLM_SUMMARIES);
	const restated = new Map<string, string>();

	for (const attribute of budget) {
		try {
			const result = await dispatcher({
				directory,
				agentName: SUMMARIZATION_AGENT,
				modelId: deps.summarizationModelId ?? 'configured',
				system: SUMMARIZATION_SYSTEM,
				prompt: attribute.statement,
				timeoutMs: deps.config.llm_timeout_ms,
				parentSessionId: deps.sessionId,
				preferredSwarm: deps.preferredSwarm,
			});
			if (result.status !== 'completed') continue;
			const cleaned = sanitizeExcerpt(
				result.text,
				MAX_CONSENSUS_STATEMENT_CHARS,
			);
			if (cleaned.length > 0) restated.set(attribute.id, cleaned);
		} catch {
			// A dispatcher that throws is exactly as non-fatal as one that returns
			// `status: 'error'`. Keep the deterministic statement and continue.
		}
	}

	if (restated.size === 0) return { attributes, summarized: 0 };
	return {
		attributes: attributes.map((attribute) => {
			const replacement = restated.get(attribute.id);
			return replacement ? { ...attribute, statement: replacement } : attribute;
		}),
		summarized: restated.size,
	};
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * A report body, with the three hash-excluded fields optional so both the
 * pre-id construction path and the post-read verification path can call the
 * same function.
 */
export type ConsensusReportIntegrityInput = Omit<
	ConsensusReportV1,
	'integrityHash' | 'reportId' | 'generatedAt'
> &
	Partial<
		Pick<ConsensusReportV1, 'integrityHash' | 'reportId' | 'generatedAt'>
	>;

/**
 * Recompute a report's integrity hash from its own content.
 *
 * Deliberately subtractive rather than additive: it hashes everything except
 * the named exclusions, so a field added to `ConsensusReportV1` later is covered
 * automatically. An additive allow-list would silently leave new fields
 * unhashed — the failure mode where a report's content changes but its
 * integrity hash does not.
 *
 * Two classes of field are excluded, both for the same reason — they are wall
 * clocks, and a content hash that moves with the clock cannot satisfy "same
 * inputs ⇒ identical hash":
 * - the report's own `generatedAt` (plus `reportId`, which is *derived* from
 *   this hash and would otherwise be circular);
 * - every proposal's `provenance.writeOrigin.producedAt`, which the miner
 *   stamps from the same clock as `generatedAt`. It is real provenance and
 *   stays in the artifact; it just is not content.
 */
export function computeConsensusIntegrityHash(
	report: ConsensusReportIntegrityInput,
): string {
	const covered: Record<string, unknown> = { ...report };
	delete covered.integrityHash;
	delete covered.reportId;
	delete covered.generatedAt;
	covered.proposals = report.proposals.map((proposal) => {
		const { producedAt: _producedAt, ...origin } =
			proposal.provenance.writeOrigin;
		return {
			...proposal,
			provenance: { ...proposal.provenance, writeOrigin: origin },
		};
	});
	return canonicalHash(covered);
}

/** Deterministic report id, derived from the integrity hash. */
export function deriveReportId(integrityHash: string): string {
	return `consensus-${integrityHash.slice(0, 16)}`;
}

/**
 * Mine consensus attributes and proposals from `directory`'s `.swarm/` evidence.
 *
 * MUTATES NOTHING. The returned report is a value; persisting it is the
 * caller's separate, explicit `writeConsensusReport` call.
 */
export async function mineConsensus(
	directory: string,
	request: ConsensusMineRequest,
	deps: MineConsensusDeps,
): Promise<MineConsensusResult> {
	const loadCorpus = deps.loadCorpus ?? loadConsensusCorpus;
	const maxExcerptChars = deps.config.max_excerpt_chars;
	const corpus = await loadCorpus(directory, {
		maxEvidenceItems: request.maxEvidenceItems,
		maxExcerptChars,
	});

	// 1 — filter
	const filtered = filterObservations(corpus.observations, request);
	// 2 — count
	const tallies = tallySignals(filtered);
	// 3 + 4 — gate, retaining negative evidence
	const deterministicAttributes = buildAttributes(
		tallies,
		request,
		maxExcerptChars,
	);

	const producedAt = (deps.now?.() ?? new Date()).toISOString();
	const signalById = new Map(
		[...tallies.keys()].map((signal) => [computeAttributeId(signal), signal]),
	);
	// 5 — propose, from the DETERMINISTIC statements
	const { proposals, deduped } = buildProposals(
		deterministicAttributes,
		filtered,
		{
			signalById,
			priorFingerprints: new Set(deps.priorFingerprints ?? []),
			producedAt,
			sessionId: deps.sessionId,
			agentRole: deps.agentRole,
		},
	);

	// 6 — ONLY NOW, optional restatement
	const summary = await summarizeStatements(
		deterministicAttributes,
		deps,
		directory,
	);

	const inputIds = [
		...new Set(filtered.map((observation) => observation.runId)),
	]
		.sort()
		.slice(0, MAX_CONSENSUS_REFS);

	const body = {
		v: 1 as const,
		request,
		inputIds,
		corpusHashes: corpus.hashes,
		configHash: canonicalHash(deps.config),
		attributes: summary.attributes,
		proposals,
		redactionPolicyVersion: computeRedactionPolicyVersion(false),
	};
	const integrityHash = computeConsensusIntegrityHash(body);
	const report = ConsensusReportV1Schema.parse({
		...body,
		reportId: deriveReportId(integrityHash),
		generatedAt: producedAt,
		integrityHash,
	}) as ConsensusReportV1;

	return {
		report,
		truncated: corpus.truncated,
		unreadableSources: [...corpus.unreadableSources],
		investigationNoteCount: summary.attributes.filter(
			(attribute) => attribute.proposedTarget === 'none',
		).length,
		dedupedProposalCount: deduped,
		summarizedCount: summary.summarized,
		...(summary.skipped ? { summarizationSkippedReason: summary.skipped } : {}),
	};
}
