/**
 * The consensus miner (issue #1821, Workstream C).
 *
 * Reads the read-only corpus, counts agreement deterministically, gates the
 * result, and emits a report. It is a **proposals-only** boundary: it activates
 * no skill, writes no knowledge, and mutates none of the evidence it reads.
 * `mineConsensus` itself writes nothing at all; the subsystem's only disk
 * mutations live in `./store.ts`, which persists a report and — under
 * `pruneConsensusReports` — deletes the subsystem's own older ones.
 *
 * Ordering is a correctness property, not a style choice. The pipeline is:
 *
 *   1. deterministic filtering
 *   2. deterministic co-occurrence + distinct-run support counting
 *   3. deterministic gates (support, successful runs, task diversity)
 *   4. deterministic retention of negative evidence
 *   5. deterministic proposal + fingerprint construction
 *   6. ONLY THEN, optional LLM restatement, into a SEPARATE field
 *
 * Step 6 last is what keeps a model from influencing whether something
 * qualifies. A model may only rephrase a conclusion the arithmetic already
 * reached. If no dispatcher is available, or the call times out, or
 * summarization is disabled, or the response fails the restatement guard, the
 * attribute simply has no `llmSummary` — graceful degradation, never a hard
 * dependency.
 *
 * Two properties are easy to lose here and are enforced explicitly:
 *
 * - **Reproducibility.** Ordering alone does NOT make the report reproducible.
 *   Two fields had to be moved out of hashed content, and both were reachable in
 *   ordinary use. `llm_summarization_enabled` defaults to `true`, so a model's
 *   wording in `statement` gave a different `integrityHash` — and a different
 *   `reportId` — on every run over an identical corpus; the restatement now goes
 *   into `ConsensusAttributeV1.llmSummary`, which the hash excludes. And
 *   `provenance.writeOrigin.sessionId` comes from `ctx.sessionID`, so two
 *   sessions mining the same corpus forked the artifact too; the hash now
 *   excludes the whole `writeOrigin`. `statement` is always the deterministic
 *   rendering, and who ran the mine cannot change what the mine found.
 * - **Model prose reaches disk only as one bounded sentence.**
 *   `SUMMARIZATION_SYSTEM` is a request, not a filter, and `sanitizeExcerpt`
 *   only redacts secrets, collapses control characters, and truncates.
 *   `extractRestatement` is the actual guard: model output can only reach disk
 *   through a `FINDING:` envelope whose captured sentence carries no bracket or
 *   angle-bracket markup, no reasoning marker, no interior sentence terminator,
 *   and no truncation (issue #1821 AC18). That keeps a reasoning *trace* out of
 *   the artifact. It is not a claim that the single admitted sentence can never
 *   read as narration — one sentence can, and the guard bounds it rather than
 *   pretending otherwise.
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
	ConsensusTruncationV1,
	ProposedSkillChange,
	ProposedSkillChangeProvenance,
} from './contracts.js';
import {
	ConsensusReportV1Schema,
	MAX_CONSENSUS_ATTRIBUTES,
	MAX_CONSENSUS_REFS,
	MAX_CONSENSUS_STATEMENT_CHARS,
} from './contracts.js';
import type { ConsensusCorpus, CorpusObservation } from './corpus.js';
import { compareRefs, loadConsensusCorpus, sanitizeExcerpt } from './corpus.js';

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
const MAX_LLM_SUMMARIES = 20;

/** Logical agent the summarization dispatch targets. */
const SUMMARIZATION_AGENT = 'curator_postmortem';

export interface MineConsensusDeps {
	/** Effective consensus configuration. Required — the miner reads no config. */
	config: ConsensusConfig;
	/** Corpus loader override. Defaults to the real read-only loader. */
	loadCorpus?: (
		directory: string,
		options: {
			maxEvidenceItems: number;
			maxExcerptChars: number;
			filter?: (observation: CorpusObservation) => boolean;
		},
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
 * Build the request's filter predicate once.
 *
 * Each filter is an intersection over a *declared* field: an observation whose
 * `modelId` is absent is excluded by a `modelIds` filter rather than passed
 * through, because "no model recorded" is not evidence that the requested model
 * was involved. `runIds` matches either the raw id or the namespaced corpus id
 * (`evaluation-run:<id>`), so a caller can pass the run id it already knows.
 *
 * Returned as a predicate rather than applied in place because it is needed
 * TWICE, from one definition: `loadConsensusCorpus` applies it per source so the
 * `maxEvidenceItems` budget is spent on observations that can actually survive
 * (narrowing a request therefore widens the budget instead of shrinking an
 * already-truncated corpus), and `mineConsensus` applies it again to whatever
 * `deps.loadCorpus` returned, because an injected loader is under no obligation
 * to honour the option.
 */
function buildObservationFilter(
	request: ConsensusMineRequest,
): (observation: CorpusObservation) => boolean {
	const runIds = request.runIds ? new Set(request.runIds) : undefined;
	const categories = request.taskCategories
		? new Set(request.taskCategories)
		: undefined;
	const roles = request.agentRoles ? new Set(request.agentRoles) : undefined;
	const models = request.modelIds ? new Set(request.modelIds) : undefined;

	return (observation) => {
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
	};
}

// ---------------------------------------------------------------------------
// Step 2 — deterministic co-occurrence and support counting
// ---------------------------------------------------------------------------

/**
 * Everything one signal accumulated across the filtered corpus.
 *
 * `taskIds` and `taskCategories` are tracked SEPARATELY from `taskKeys` even
 * though `taskKeys` is derived from them. `taskKeys` answers "how many distinct
 * task identities is this attribute based on" — the anecdote gate — and
 * deliberately falls back to the category when a task id is absent, so the two
 * cannot be recovered from it. The separate sets are what let a proposal declare
 * provenance scoped to the observations that actually fed it (issue #1821 AC23)
 * instead of restating the whole corpus.
 */
interface SignalTally {
	signal: string;
	/** Distinct run ids carrying the signal at all. */
	runIds: Set<string>;
	/** Distinct run ids carrying it on a SUCCEEDING observation. */
	successRunIds: Set<string>;
	/** Distinct run ids carrying it on a FAILING observation. */
	failureRunIds: Set<string>;
	/** Distinct task identities (`taskId`, else `taskCategory`). */
	taskKeys: Set<string>;
	/** Distinct task ids among the contributing observations. */
	taskIds: Set<string>;
	/** Distinct task categories among the contributing observations. */
	taskCategories: Set<string>;
	/** Distinct model ids. Empty ⇒ not measurable, not "none". */
	modelIds: Set<string>;
	/** Evidence refs from succeeding observations, insertion-ordered. */
	evidenceRefs: string[];
	/** Evidence refs from FAILING observations. Never discarded. */
	counterexampleRefs: string[];
}

/** A gated attribute paired with the tally it was computed from. */
interface MinedAttribute {
	attribute: ConsensusAttributeV1;
	tally: SignalTally;
}

/**
 * Tally every signal across the filtered corpus.
 *
 * Support is DISTINCT RUNS, not observations: a single run that emits the same
 * signal a hundred times contributes exactly one to `support`. Without that, a
 * chatty trajectory would manufacture consensus by itself.
 */
function tallySignals(
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
					taskIds: new Set(),
					taskCategories: new Set(),
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
			if (observation.taskId !== undefined) {
				tally.taskIds.add(observation.taskId);
			}
			if (observation.taskCategory !== undefined) {
				tally.taskCategories.add(observation.taskCategory);
			}
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
function computeConfidence(
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
function computeAttributeId(signal: string): string {
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
 * Turn tallies into gated attributes, bounded by the producer-side cap.
 *
 * A tally that clears `minSupport` and `minSuccessfulRuns` becomes an attribute.
 * If it also clears the task-diversity gate AND draws support from more than one
 * run, it keeps its signal's target and is proposal-eligible; otherwise its
 * target is forced to `'none'` and it is an investigation note. Anything below
 * the support or successful-run thresholds is dropped entirely.
 *
 * The `maxAttributes` cap is enforced HERE rather than left to
 * `ConsensusReportV1Schema`. A schema-only bound turns an over-large corpus into
 * a `parse` throw at the very end of mining, which means no report is written at
 * all — the caller loses every finding instead of the weakest tail. The tool's
 * `max_evidence_items` accepts up to 10 000, so this is reachable, not
 * theoretical.
 *
 * When the cap binds, the survivors are the STRONGEST (confidence, then support,
 * then id), not the alphabetically-first: dropping the tail of a signal-sorted
 * list would discard findings for a reason with nothing to do with their
 * strength. The retained set is then restored to canonical signal order, so the
 * report hash still does not depend on Map insertion order.
 */
function buildAttributes(
	tallies: ReadonlyMap<string, SignalTally>,
	request: ConsensusMineRequest,
	maxExcerptChars: number,
	maxAttributes: number,
): { mined: MinedAttribute[]; dropped: number } {
	const qualifying: MinedAttribute[] = [];
	// Sort by signal so attribute order — and therefore the report hash — does
	// not depend on Map insertion order.
	for (const tally of [...tallies.values()].sort((left, right) =>
		compareRefs(left.signal, right.signal),
	)) {
		const support = tally.runIds.size;
		const successSupport = tally.successRunIds.size;
		const failureSupport = tally.failureRunIds.size;
		if (support < request.minSupport) continue;
		if (successSupport < request.minSuccessfulRuns) continue;

		const taskDiversity = tally.taskKeys.size;
		const qualifies =
			taskDiversity >= MIN_TASK_DIVERSITY_FOR_PROPOSAL && support > 1;
		qualifying.push({
			tally,
			attribute: {
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
				// Distinct model ids, or 0 when the corpus carries no model
				// attribution for this signal. Never a gate — see the contract doc.
				modelDiversity: tally.modelIds.size,
				evidenceRefs: [...tally.evidenceRefs].sort(),
				// Negative evidence is retained unconditionally. There is no branch
				// anywhere in this function that can drop it.
				counterexampleRefs: [...tally.counterexampleRefs].sort(),
				confidence: computeConfidence(support, successSupport, taskDiversity),
				proposedTarget: qualifies ? targetFromSignal(tally.signal) : 'none',
			},
		});
	}

	if (qualifying.length <= maxAttributes) {
		return { mined: qualifying, dropped: 0 };
	}
	const strongestIds = new Set(
		[...qualifying]
			.sort(
				(left, right) =>
					right.attribute.confidence - left.attribute.confidence ||
					right.attribute.support - left.attribute.support ||
					compareRefs(left.attribute.id, right.attribute.id),
			)
			.slice(0, maxAttributes)
			.map((entry) => entry.attribute.id),
	);
	return {
		mined: qualifying.filter((entry) => strongestIds.has(entry.attribute.id)),
		dropped: qualifying.length - strongestIds.size,
	};
}

// ---------------------------------------------------------------------------
// Step 5 — proposals
// ---------------------------------------------------------------------------

/** Matches `ProposedSkillChangeSchema.validationSelector`'s upper bound. */
const MAX_VALIDATION_SELECTOR_CHARS = 1024;

/** Room reserved so the `;omitted=<count>` suffix always fits. */
const SELECTOR_OMISSION_RESERVE = 24;

/**
 * Longest single identifier a selector will carry. A longer one is DROPPED and
 * counted as omitted rather than clipped — clipping would be the very
 * mid-identifier truncation this renderer exists to avoid.
 */
const MAX_SELECTOR_ENTRY_CHARS = 256;

/**
 * Render a validation selector without ever truncating an identifier, or return
 * `undefined` when this key can name nothing at all.
 *
 * The field is contractually "a deterministic selector describing which slice to
 * validate against", so a mid-identifier cut is not a cosmetic problem: it names
 * a slice that does not exist, and a validation run driven off it would silently
 * measure the wrong thing. Whole entries are dropped instead, and the omission is
 * declared, so an abbreviated selector is distinguishable from a complete one.
 *
 * Returning `undefined` when NOTHING survived matters just as much: a key whose
 * every identifier was over-long would otherwise render as `taskIds=;omitted=2`,
 * a syntactically valid selector that designates the empty slice. The caller
 * falls through to the next key instead.
 */
function renderValidationSelector(
	key: string,
	values: readonly string[],
): string | undefined {
	const budget = MAX_VALIDATION_SELECTOR_CHARS - SELECTOR_OMISSION_RESERVE;
	const kept: string[] = [];
	let length = key.length + 1; // the `<key>=` prefix
	for (const value of values) {
		// `+ 1` so an over-long identifier is DETECTED rather than silently
		// clipped to the bound by `sanitizeExcerpt`.
		const clean = sanitizeExcerpt(value, MAX_SELECTOR_ENTRY_CHARS + 1);
		if (clean.length === 0 || clean.length > MAX_SELECTOR_ENTRY_CHARS) continue;
		const cost = clean.length + (kept.length > 0 ? 1 : 0); // + separator
		if (length + cost > budget) break;
		kept.push(clean);
		length += cost;
	}
	if (kept.length === 0) return undefined;
	const omitted = values.length - kept.length;
	return omitted > 0
		? `${key}=${kept.join(',')};omitted=${omitted}`
		: `${key}=${kept.join(',')}`;
}

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
 * Two properties this function owns:
 *
 * - **The fingerprint is computed from the DETERMINISTIC statement**, never a
 *   model restatement — which is why this runs before summarization, and why
 *   `summarizeStatements` writes to `llmSummary` instead of `statement`.
 *   Otherwise a model rewording the same conclusion on a later run would mint a
 *   new fingerprint and defeat the very deduplication the fingerprint exists for.
 * - **Provenance is scoped to the contributing observations** (issue #1821
 *   AC23). Every `source*` list, and the `validationSelector`, come from the
 *   attribute's own tally, not from the whole filtered corpus. Computing them
 *   once over every observation and stamping them onto every proposal made each
 *   proposal claim provenance it did not have, and made all proposals in a report
 *   indistinguishable from one another — a validation run driven off such a
 *   selector would be testing the wrong slice.
 */
function buildProposals(
	mined: readonly MinedAttribute[],
	options: {
		priorFingerprints: ReadonlySet<string>;
		producedAt: string;
		sessionId?: string;
		agentRole?: string;
	},
): { proposals: ProposedSkillChange[]; deduped: number } {
	const proposals: ProposedSkillChange[] = [];
	const seen = new Set<string>();
	let deduped = 0;

	for (const { attribute, tally } of mined) {
		if (attribute.proposedTarget === 'none') continue;

		// Scoped to THIS attribute's contributing observations.
		const categories = [...tally.taskCategories].sort();
		const runIds = [...tally.runIds].sort();
		const modelIds = [...tally.modelIds].sort();
		const taskIds = [...tally.taskIds].sort();

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
			sourceAttributeId: attribute.id,
			target: attribute.proposedTarget,
			intent: sanitizeExcerpt(
				`Investigate the smallest ${attribute.proposedTarget} change that would remove the observed pattern: ${humanizeSignal(
					tally.signal,
				)}.`,
				MAX_CONSENSUS_STATEMENT_CHARS,
			),
			evidenceRefs: attribute.evidenceRefs,
			counterexampleRefs: attribute.counterexampleRefs,
			confidence: attribute.confidence,
			expectedMetric: EXPECTED_METRIC[attribute.proposedTarget],
			// Most specific key that can actually name a slice wins. Falling THROUGH
			// on an unrenderable key — rather than emitting an empty one — is what
			// keeps the guarantee that a selector always designates something real.
			// The attribute id is the last resort: it is always present, and it
			// names exactly the finding this proposal came from.
			validationSelector:
				renderValidationSelector('taskCategories', categories) ??
				renderValidationSelector('taskIds', taskIds) ??
				renderValidationSelector('runIds', runIds) ??
				`attributeId=${attribute.id}`,
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
	'Reply with exactly one line in the form: FINDING: <one sentence>. ' +
	'Output nothing else — no preamble, no reasoning, no analysis, no lists, no code fences.';

/** The envelope the model must use. Only the captured group can be persisted. */
const RESTATEMENT_ENVELOPE_RE = /^\s*FINDING:\s*(\S.*)$/;

/**
 * Every character a renderer may treat as a line break — not just `\n`.
 *
 * Splitting on `\r?\n` alone leaves a lone `\r`, a vertical tab, a form feed, a
 * next line (U+0085), or a Unicode line/paragraph separator INSIDE what the
 * envelope regex sees as one line (JavaScript's `.` excludes only `\n`). Content
 * after such a separator would then ride along inside the captured group, and
 * `sanitizeExcerpt` would quietly flatten it into the retained sentence —
 * defeating the whole point of accepting only one line.
 *
 * The set is every character Unicode UAX #14 treats as a mandatory break, which
 * is what "every line terminator" has to mean here. U+0085 in particular is not
 * matched by JavaScript's `\s`, so it cannot be covered incidentally.
 */
const LINE_TERMINATOR_RE = /[\r\n\v\f\u0085\u2028\u2029]+/;

/**
 * Phrases that mark a model narrating its own process rather than restating a
 * finding. Applied to the already-extracted sentence, as a second line of
 * defence behind the envelope.
 */
const REASONING_MARKER_RE =
	/\b(?:reasoning|rationale|chain[-\s]?of[-\s]?thought|thought process|scratchpad|deliberation|let(?:'s| us| me) think|step[-\s]by[-\s]step|i(?:'ll| will| need to| should| must| think| considered| analyzed)|my analysis|analysis|thinking)\b\s*[:,]?/i;

/**
 * Any bracket a model delimits a scratchpad with.
 *
 * Reasoning models tag their scratchpad several ways — `<think>`, `[think]`,
 * `【think】`, `{think}` — and the envelope is LINE-scoped, so a response of
 * `FINDING: <think>I counted them</think> Scoring succeeded.` puts the whole
 * scratchpad inside the captured group. Angle brackets alone left the square and
 * CJK forms open. Rejecting outright rather than stripping tags is the safer
 * direction: a restatement of a statistical finding has no legitimate need for
 * markup, and rejection costs only the paraphrase.
 *
 * The CJK range covers U+3008–U+3011 (〈〉《》「」『』【】) plus U+3014/U+3015
 * (〔〕) and the fullwidth ASCII forms.
 */
const MARKUP_RE =
	/[<>[\]{}\u3008-\u3011\u3014\u3015\uFF08\uFF09\uFF3B\uFF3D\uFF5B\uFF5D]/;

/**
 * `sanitizeExcerpt`'s own redaction placeholder.
 *
 * `[REDACTED:<type>]` is OUR output, not the model's, and `sanitizeExcerpt` runs
 * before the bracket test — so without masking it, redacting a secret out of an
 * otherwise-valid restatement would make the guard reject its own handiwork.
 */
const REDACTION_PLACEHOLDER_RE = /\[REDACTED:[A-Za-z0-9_]+\]/g;

/**
 * The only periods that legitimately sit INSIDE one sentence: a closed
 * abbreviation list, and the decimal point of a number.
 */
const NON_TERMINAL_ABBREVIATION_RE = /\b(?:e\.g\.|i\.e\.|etc\.)/gi;
const DECIMAL_POINT_RE = /(\d)\.(?=\d)/g;

/**
 * A single sentence: no interior terminator at all, and at most one trailing
 * terminator run, optionally closed by a quote or parenthesis.
 */
const SINGLE_SENTENCE_RE = /^[^.!?]*(?:[.!?]+["')]?)?$/;

/**
 * True when `value` is one sentence.
 *
 * A POSITIVE whitelist, and it has to be. The previous version detected a
 * sentence boundary only as `[.!?]` followed by whitespace and an ASCII capital
 * or `(`, which let a whole four-sentence lower-case narration through verbatim
 * — as did a continuation starting with a digit, a quote, a non-ASCII capital,
 * or no space at all. Enumerating the ways a second sentence can begin is
 * unbounded; requiring that there be no interior terminator is not.
 *
 * So the two constructs whose period genuinely sits mid-sentence are masked
 * first — `e.g.` / `i.e.` / `etc.` and decimal numbers — and everything else
 * containing a `.`, `!`, or `?` anywhere but a single trailing run is rejected.
 * A legitimate restatement that quotes a terminator mid-sentence is rejected
 * too; that costs only the paraphrase, which is the direction this guard errs in
 * everywhere else.
 */
function isSingleSentence(value: string): boolean {
	const masked = value
		.replace(NON_TERMINAL_ABBREVIATION_RE, (match) => '_'.repeat(match.length))
		.replace(DECIMAL_POINT_RE, '$1_');
	return SINGLE_SENTENCE_RE.test(masked);
}

/**
 * Extract a persistable restatement from raw model output, or reject it.
 *
 * This is a WHITELIST, and it has to be. `SUMMARIZATION_SYSTEM` is a request,
 * not a filter, and `sanitizeExcerpt` only redacts secrets, collapses control
 * characters, and truncates — so a dispatcher returning
 * `"Reasoning: the model thought hard. Answer: X"` passes all three and lands
 * verbatim in the report. Issue #1821 AC18 says chain-of-thought is NEVER
 * persisted, and "never" cannot be delivered by a prompt.
 *
 * So nothing outside a `FINDING:` line can survive at all, and the extracted
 * sentence must additionally:
 * - carry no bracket or angle-bracket markup — the envelope is line-scoped, so a
 *   `<think>…</think>` or `[think]…` block sharing the line would otherwise ride
 *   along inside the captured group;
 * - carry no reasoning markers;
 * - be a single sentence, decided by whitelist: no interior `.`/`!`/`?` outside
 *   the `e.g.`/`i.e.`/`etc.` allowlist and decimal points;
 * - fit `MAX_CONSENSUS_STATEMENT_CHARS` **without truncation**. Clipping model
 *   output to length is precisely how a trailing fragment of reasoning survives a
 *   length bound, so an over-long restatement is rejected outright.
 *
 * Rejection is silent and non-fatal: the attribute keeps its deterministic
 * `statement` and simply carries no `llmSummary`.
 */
function extractRestatement(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	let captured: string | undefined;
	for (const line of raw.split(LINE_TERMINATOR_RE)) {
		const match = RESTATEMENT_ENVELOPE_RE.exec(line);
		if (match?.[1] !== undefined) {
			captured = match[1];
			break;
		}
	}
	if (captured === undefined) return undefined;
	// Redact and collapse BEFORE measuring, so the bound is applied to exactly
	// the text that would be persisted. The `+ 1` bound lets an over-long
	// restatement be detected rather than silently clipped to the limit.
	const cleaned = sanitizeExcerpt(captured, MAX_CONSENSUS_STATEMENT_CHARS + 1);
	if (cleaned.length === 0) return undefined;
	if (cleaned.length > MAX_CONSENSUS_STATEMENT_CHARS) return undefined;
	// Only the bracket test needs the placeholder mask — a `[REDACTED:<type>]`
	// token carries no sentence terminator and no reasoning marker.
	if (MARKUP_RE.test(cleaned.replace(REDACTION_PLACEHOLDER_RE, ' '))) {
		return undefined;
	}
	if (REASONING_MARKER_RE.test(cleaned)) return undefined;
	if (!isSingleSentence(cleaned)) return undefined;
	return cleaned;
}

/**
 * Optionally attach a model restatement to each attribute as `llmSummary`.
 *
 * Every failure mode — no dispatcher, disabled config, non-`completed` status,
 * empty text, a response the restatement guard rejects, a thrown dispatcher —
 * leaves the attribute exactly as the arithmetic produced it. Nothing here can
 * change a count, a gate outcome, a target, a confidence, or `statement` itself,
 * and because `llmSummary` is excluded from the integrity hash, nothing here can
 * change the report's identity either.
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
				right.confidence - left.confidence || compareRefs(left.id, right.id),
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
			const restatement = extractRestatement(result.text);
			if (restatement !== undefined) restated.set(attribute.id, restatement);
		} catch {
			// A dispatcher that throws is exactly as non-fatal as one that returns
			// `status: 'error'`. Keep the deterministic statement and continue.
		}
	}

	if (restated.size === 0) return { attributes, summarized: 0 };
	return {
		attributes: attributes.map((attribute) => {
			const llmSummary = restated.get(attribute.id);
			// `statement` is never overwritten — the model's wording is additive.
			return llmSummary ? { ...attribute, llmSummary } : attribute;
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
 * Exclusions fall into two classes, both failing the same test — "would an
 * identical corpus produce an identical value?":
 *
 * 1. **Who and when, as opposed to what.** The report's own `generatedAt` (plus
 *    `reportId`, which is *derived* from this hash and would otherwise be
 *    circular), and every proposal's ENTIRE `provenance.writeOrigin` — the
 *    `producedAt` clock and the `sessionId` / `agentRole` / `agentId` that
 *    identify whoever physically ran the mine. All are real provenance and stay
 *    in the artifact; none of them is content.
 *
 *    Excluding the identity fields is not cosmetic. `sessionId` comes from
 *    `ctx.sessionID`, so with only `producedAt` excluded, two sessions mining a
 *    byte-identical corpus produced different `integrityHash` values and
 *    therefore different `reportId`s — the same user-visible symptom as hashing
 *    the model's wording, just from a different field. Who ran the mine cannot
 *    be allowed to change what the mine found.
 * 2. **Non-reproducible model prose** — every attribute's `llmSummary`. This one
 *    is not a nicety: `llm_summarization_enabled` defaults to `true`, so hashing
 *    a model's wording made "same inputs ⇒ identical hash" FALSE in the default
 *    configuration. Two mining runs over a byte-identical corpus produced
 *    different `integrityHash` values and therefore different `reportId`s,
 *    which defeats content addressing, defeats `isEquivalent` in the store, and
 *    turns every re-mine into a new artifact. The deterministic `statement` that
 *    the summary paraphrases IS hashed, so nothing about the finding escapes
 *    coverage — only the paraphrase does.
 */
export function computeConsensusIntegrityHash(
	report: ConsensusReportIntegrityInput,
): string {
	const covered: Record<string, unknown> = { ...report };
	delete covered.integrityHash;
	delete covered.reportId;
	delete covered.generatedAt;
	covered.attributes = report.attributes.map((attribute) => {
		const { llmSummary: _llmSummary, ...content } = attribute;
		return content;
	});
	covered.proposals = report.proposals.map((proposal) => {
		const { writeOrigin: _writeOrigin, ...provenance } = proposal.provenance;
		return { ...proposal, provenance };
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
	const matchesRequest = buildObservationFilter(request);
	// The predicate is handed to the loader so the `maxEvidenceItems` budget is
	// spent on observations the request can actually keep. Without it the corpus
	// was cut FIRST and filtered second, so narrowing to the one category that
	// mattered took a 50-observation corpus to 0 instead of filling those 50 slots
	// with matching evidence.
	const corpus = await loadCorpus(directory, {
		maxEvidenceItems: request.maxEvidenceItems,
		maxExcerptChars,
		filter: matchesRequest,
	});

	// 1 — filter. Re-applied here rather than trusted: `deps.loadCorpus` is an
	// injection seam, and an injected loader is free to ignore `filter`.
	const filtered = corpus.observations.filter(matchesRequest);
	// 2 — count
	const tallies = tallySignals(filtered);
	// 3 + 4 — gate, retaining negative evidence, bounded by the producer cap
	const { mined, dropped: attributesDropped } = buildAttributes(
		tallies,
		request,
		maxExcerptChars,
		MAX_CONSENSUS_ATTRIBUTES,
	);
	const deterministicAttributes = mined.map((entry) => entry.attribute);

	const producedAt = (deps.now?.() ?? new Date()).toISOString();
	// 5 — propose, from the DETERMINISTIC statements and per-attribute provenance
	const { proposals, deduped } = buildProposals(mined, {
		priorFingerprints: new Set(deps.priorFingerprints ?? []),
		producedAt,
		sessionId: deps.sessionId,
		agentRole: deps.agentRole,
	});

	// 6 — ONLY NOW, optional restatement, into `llmSummary`
	const summary = await summarizeStatements(
		deterministicAttributes,
		deps,
		directory,
	);

	const allInputIds = [
		...new Set(filtered.map((observation) => observation.runId)),
	].sort();
	const inputIds = allInputIds.slice(0, MAX_CONSENSUS_REFS);

	// Every cut this report made, declared on the artifact itself. A reader who
	// cannot see that the corpus was capped cannot tell `failureSupport: 0` —
	// "nothing failed" — from "the failures were truncated away".
	const truncation: ConsensusTruncationV1 = {
		corpus: corpus.truncated,
		observations: filtered.length,
		inputIds: allInputIds.length > inputIds.length,
		totalInputIds: allInputIds.length,
		attributesDropped,
	};

	const body = {
		v: 1 as const,
		request,
		inputIds,
		corpusHashes: corpus.hashes,
		configHash: canonicalHash(deps.config),
		attributes: summary.attributes,
		proposals,
		truncation,
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
