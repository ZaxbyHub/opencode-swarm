/**
 * Legacy transcript adapter — the transcript/artifact-text → canonical
 * conversion authority (issue #2385).
 *
 * This is the ONLY module allowed to convert raw transcript / artifact text
 * into canonical PR-review data (verdict rows, per-item verdicts, feedback
 * classifications). The locality contract is enforced mechanically by
 * `scanTranscriptParsingOutsideAdapter` in `src/pr-review/guardrails.ts`:
 * every identifier in `TRANSCRIPT_CONVERSION_SYMBOLS` may appear only in this
 * file across `src/`. The gate therefore consumes this boundary through the
 * `legacy*`-prefixed aliases and the test surface exported below — never
 * through the conversion identifiers themselves.
 *
 * Compat gating: the settlement path that accepts legacy (pre-structured-
 * receipt) transcript text is governed by the delegation record's
 * `pr_review_legacy_transcript_compatibility` flag (default false), read
 * through `prReviewLegacyTranscriptCompatibilityEnabled` from
 * `src/background/pr-review-contract.ts`. That settlement path emits no
 * deprecation diagnostic today and none is added here; this header documents
 * the gate only.
 *
 * Binding contract (same precedent as `bindPrReviewCompletionHelpers` in
 * `completion.ts` and `bindPrReviewReentryBindingReader` in
 * `authorization.ts`): this boundary must never import the orchestration gate
 * back. Gate-owned composition/settlement helpers are supplied by the owning
 * gate through `bindPrReviewTranscriptAdapterHelpers`, bound once at gate
 * module init.
 *
 * State typing: the moved functions read only the PR-review slices of the
 * gate's `PrWorkflowGateState` and `PrReviewGateContext`, expressed as the
 * local structural interfaces below; the gate passes its full state and
 * context, which satisfy the slices structurally without a projection step.
 */

import { createHash } from 'node:crypto';
import {
	type LaneOutputArtifact,
	readLaneOutput,
} from '../background/lane-output-store.js';
import {
	type BackgroundDelegationRecord,
	findByBatchId,
} from '../background/pending-delegations.js';
import {
	PR_REVIEW_DISCARDED_EXAMPLE_ITEM_ID,
	PrReviewCriticVerdictFieldsSchema,
	PrReviewReviewerVerdictFieldsSchema,
	type PrReviewRiskImpact,
	type PrReviewRiskTag,
	parsePrReviewRiskTagsField,
	parsePrReviewVerdictRow,
} from '../background/pr-review-contract.js';
import { warn } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Shared composition types (moved from the gate; the adapter owns them)
// ---------------------------------------------------------------------------

export type PrReviewComposablePhase = 'reviewer' | 'critic';

/** One item's admitted verdict plus the lane provenance that admitted it. */
export interface PrReviewItemClaim {
	batchId: string;
	laneId: string;
	workflowLane: string;
	/** Reviewer classification, or critic status. */
	classification: string;
	severity: string;
	/**
	 * Typed risk metadata from the reviewer row (issue #2383). Reviewer claims
	 * only; absent on critic claims, which never re-assess routing risk.
	 */
	riskImpact?: PrReviewRiskImpact;
	riskTags?: PrReviewRiskTag[];
	/**
	 * sha256 of the full canonical `[REVIEWED]` row this claim was parsed from.
	 * Reviewer claims only — this is what a critic batch binds to per item.
	 */
	rowDigest?: string;
}

export interface PrReviewPhaseComposition {
	/** Item id -> winning claim. Most recent successful lane per item wins. */
	claims: Map<string, PrReviewItemClaim>;
	requiredInventory: string[];
	unclaimed: string[];
	contributingBatchIds: string[];
	diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Structural state/context slices + gate-helper binding seam
// ---------------------------------------------------------------------------

/** Validation-batch shape, as the transcript composition reads it. */
export interface PrReviewTranscriptBatch {
	batchId: string;
	lanes: ReadonlyArray<PrReviewTranscriptLane>;
	validatedAt: string;
}

/** Declared lane shape, as the transcript composition reads it. */
export interface PrReviewTranscriptLane {
	laneId: string;
	workflowLane: string;
	reviewItemIds?: string[];
}

/**
 * Per-batch coherence keys for item-keyed reviewer/critic composition, as the
 * adapter reads them (structural slice of the gate's record).
 */
export interface PrReviewTranscriptBatchCoherence {
	/**
	 * The exact candidate/critic inventory this batch's ownership was validated
	 * against at record time.
	 */
	validatedInventory: string[];
	/** Critic batches only: per-item sha256 of the authoritative `[REVIEWED]` row. */
	reviewerItemBindings?: Record<string, string>;
	/** Key encoding for reviewerItemBindings; absent means legacy raw item IDs. */
	reviewerItemBindingKeyEncoding?: 'prefixed-v1';
}

/** Settled PR_FEEDBACK verification batch, as the adapter reads it. */
export interface PrReviewTranscriptFeedbackVerification {
	batchId: string;
	ownership: ReadonlyArray<{ laneId: string }>;
}

/**
 * The PR-review slice of the owning gate's `PrWorkflowGateState`: exactly the
 * fields the moved conversion/composition machinery reads directly. The gate's
 * full state type satisfies this structurally.
 */
export interface PrReviewTranscriptState {
	sessionID: string;
	prReviewBatchCoherence?: Record<string, PrReviewTranscriptBatchCoherence>;
	prFeedbackVerifications?: PrReviewTranscriptFeedbackVerification[];
}

/** The gate-context surface the transcript composition consumes (full ctx is gate-owned). */
export interface PrReviewTranscriptContext {
	readonly revisionDigest: string;
	reviewer?: PrReviewPhaseComposition;
	critic?: PrReviewPhaseComposition;
}

/** A batch-integrity-qualified record, as the transcript composition consumes it. */
export interface PrReviewTranscriptQualifiedBatchRecord {
	record: BackgroundDelegationRecord;
	expectedLane: PrReviewTranscriptLane;
	expectedWorkflowLane: string;
}

/**
 * Gate-owned composition/settlement helpers, bound by the owning gate at
 * module init so this boundary never imports the gate back. Declared with
 * method syntax on purpose: the gate's implementations accept/return its FULL
 * state and context types, which are structural supersets of the slices
 * above, and interface method parameters are checked bivariantly.
 */
export interface PrReviewTranscriptGateHelpers {
	derivePrReviewCandidateInventory(
		directory: string,
		state: PrReviewTranscriptState,
		ctx: PrReviewTranscriptContext,
	): string[];
	derivePrReviewCriticInventory(
		directory: string,
		state: PrReviewTranscriptState,
		ctx: PrReviewTranscriptContext,
	): string[];
	authoritativeReviewerClaims(
		directory: string,
		state: PrReviewTranscriptState,
		ctx: PrReviewTranscriptContext,
	): ReadonlyMap<string, PrReviewItemClaim>;
	reviewerSubagentSessionIds(
		directory: string,
		state: PrReviewTranscriptState,
	): Set<string>;
	prReviewPhaseWindow(
		state: PrReviewTranscriptState,
		phase: PrReviewComposablePhase,
	): PrReviewTranscriptBatch[];
	batchMayContributeClaims(
		directory: string,
		state: PrReviewTranscriptState,
		batch: PrReviewTranscriptBatch,
		phase: PrReviewComposablePhase,
		requiredInventory: readonly string[],
		forbiddenSubagentSessionIds: ReadonlySet<string>,
		reviewerClaims: ReadonlyMap<string, PrReviewItemClaim> | undefined,
		ctx: PrReviewTranscriptContext,
	): boolean;
	recordsPassingBatchIntegrity(
		directory: string,
		state: PrReviewTranscriptState,
		batchId: string,
		expectedLanes: ReadonlyArray<PrReviewTranscriptLane>,
		expectedMode: string,
		validatedAt: string,
		checkWorkflowLane?: boolean,
		forbiddenSubagentSessionIds?: ReadonlySet<string>,
		diagnostics?: string[],
	): PrReviewTranscriptQualifiedBatchRecord[];
	loadArtifactPassingLaneIntegrity(
		directory: string,
		state: PrReviewTranscriptState,
		record: BackgroundDelegationRecord,
		expectedMode: string,
		expectedWorkflowLane: string,
		expectedRevisionDigest: string,
		diagnostics?: string[],
	): LaneOutputArtifact | null;
}

let gateHelpers: PrReviewTranscriptGateHelpers | undefined;

export function bindPrReviewTranscriptAdapterHelpers(
	helpers: PrReviewTranscriptGateHelpers,
): void {
	gateHelpers = helpers;
}

function requireBoundHelpers(): PrReviewTranscriptGateHelpers {
	if (!gateHelpers) {
		throw new Error(
			'BLOCKED: legacy transcript adapter helpers are not bound (the PR workflow gate must bind them at module init)',
		);
	}
	return gateHelpers;
}

// Call-time dispatchers over the binding, so the moved function bodies below
// read exactly as they did in the gate.

function derivePrReviewCandidateInventory(
	directory: string,
	state: PrReviewTranscriptState,
	ctx: PrReviewTranscriptContext,
): string[] {
	return requireBoundHelpers().derivePrReviewCandidateInventory(
		directory,
		state,
		ctx,
	);
}

function derivePrReviewCriticInventory(
	directory: string,
	state: PrReviewTranscriptState,
	ctx: PrReviewTranscriptContext,
): string[] {
	return requireBoundHelpers().derivePrReviewCriticInventory(
		directory,
		state,
		ctx,
	);
}

function authoritativeReviewerClaims(
	directory: string,
	state: PrReviewTranscriptState,
	ctx: PrReviewTranscriptContext,
): ReadonlyMap<string, PrReviewItemClaim> {
	return requireBoundHelpers().authoritativeReviewerClaims(
		directory,
		state,
		ctx,
	);
}

function reviewerSubagentSessionIds(
	directory: string,
	state: PrReviewTranscriptState,
): Set<string> {
	return requireBoundHelpers().reviewerSubagentSessionIds(directory, state);
}

function prReviewPhaseWindow(
	state: PrReviewTranscriptState,
	phase: PrReviewComposablePhase,
): PrReviewTranscriptBatch[] {
	return requireBoundHelpers().prReviewPhaseWindow(state, phase);
}

function batchMayContributeClaims(
	directory: string,
	state: PrReviewTranscriptState,
	batch: PrReviewTranscriptBatch,
	phase: PrReviewComposablePhase,
	requiredInventory: readonly string[],
	forbiddenSubagentSessionIds: ReadonlySet<string>,
	reviewerClaims: ReadonlyMap<string, PrReviewItemClaim> | undefined,
	ctx: PrReviewTranscriptContext,
): boolean {
	return requireBoundHelpers().batchMayContributeClaims(
		directory,
		state,
		batch,
		phase,
		requiredInventory,
		forbiddenSubagentSessionIds,
		reviewerClaims,
		ctx,
	);
}

function recordsPassingBatchIntegrity(
	directory: string,
	state: PrReviewTranscriptState,
	batchId: string,
	expectedLanes: ReadonlyArray<PrReviewTranscriptLane>,
	expectedMode: string,
	validatedAt: string,
	checkWorkflowLane?: boolean,
	forbiddenSubagentSessionIds?: ReadonlySet<string>,
	diagnostics?: string[],
): PrReviewTranscriptQualifiedBatchRecord[] {
	return requireBoundHelpers().recordsPassingBatchIntegrity(
		directory,
		state,
		batchId,
		expectedLanes,
		expectedMode,
		validatedAt,
		checkWorkflowLane,
		forbiddenSubagentSessionIds,
		diagnostics,
	);
}

function loadArtifactPassingLaneIntegrity(
	directory: string,
	state: PrReviewTranscriptState,
	record: BackgroundDelegationRecord,
	expectedMode: string,
	expectedWorkflowLane: string,
	expectedRevisionDigest: string,
	diagnostics?: string[],
): LaneOutputArtifact | null {
	return requireBoundHelpers().loadArtifactPassingLaneIntegrity(
		directory,
		state,
		record,
		expectedMode,
		expectedWorkflowLane,
		expectedRevisionDigest,
		diagnostics,
	);
}

// ---------------------------------------------------------------------------
// Conversion vocabulary (moved from the gate; this module owns it)
// ---------------------------------------------------------------------------

const REVIEW_SEVERITY_RANK = new Map([
	['NONE', 0],
	['INFO', 1],
	['LOW', 2],
	['MEDIUM', 3],
	['HIGH', 4],
	['CRITICAL', 5],
]);
const FEEDBACK_CLASSIFICATIONS = new Set([
	'CONFIRMED',
	'PARTIAL',
	'DISPROVED',
	'PRE_EXISTING',
	'NEEDS_MORE_EVIDENCE',
	'NEEDS_USER_DECISION',
]);

const MAX_COMPOSITION_DIAGNOSTICS = 16;
/**
 * Same per-diagnostic character cap as the gate's private
 * `MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS` (issue #2385: the adapter cannot import
 * the gate, and the cap stays a move-time constant twin).
 */
const MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS = 1_000;

function appendCompositionDiagnostic(
	diagnostics: string[],
	message: string,
): void {
	if (diagnostics.length >= MAX_COMPOSITION_DIAGNOSTICS) return;
	diagnostics.push(message.slice(0, MAX_BASE_COVERAGE_DIAGNOSTIC_CHARS));
}

const REVIEWER_ITEM_BINDING_KEY_PREFIX = 'item:';

/**
 * Prefix item IDs before using them as persisted object keys. In particular,
 * assigning a raw `__proto__` key to an ordinary object invokes JavaScript's
 * prototype setter instead of creating an own property.
 */
export function reviewerItemBindingKey(itemId: string): string {
	return `${REVIEWER_ITEM_BINDING_KEY_PREFIX}${itemId}`;
}

/**
 * A critic claim survives only while the reviewer row it challenged is
 * byte-identical.
 *
 * What this guarantees: the critic verdict was produced against reviewer row
 * *content* identical to the content authoritative now. A reviewer verdict keeps
 * only 2 of the 12 required row fields, so a classification/severity tuple would
 * still match after the evidence and root cause changed entirely; the full-row
 * digest does not. That also closes the `DOWNGRADED` hole in
 * `parseCriticVerdict`, where a reviewer severity *increase* leaves a stale
 * DOWNGRADED row still parseable.
 *
 * What this does NOT guarantee (issue #1968 FIX 8; the fix plan's claim that it
 * "closes the leave-and-return readmission path" is retracted as false):
 * `reviewerVerdictRowDigest` hashes the twelve parsed `[REVIEWED]` fields and
 * nothing else — no lane, session, or batch identity. (Legacy ten-field rows
 * are normalized to twelve with UNKNOWN / no tags at the parse boundary, so
 * both the critic-batch binder and claim admission hash a uniform view.) So a byte-identical row
 * emitted by a *different* lane or session re-admits the bound critic claim, and
 * an item that leaves the critic inventory and later returns with an identical
 * row re-admits the original critic verdict rather than requiring a fresh one.
 * Both are content-equivalent by construction, and the artifact behind the claim
 * is still pinned to the current revision digest and to its own lane identity by
 * `loadArtifactPassingLaneIntegrity`, so neither admits a verdict about
 * different content — but neither is prevented, and the binding is not the thing
 * that prevents them.
 */
function criticClaimIsBoundToCurrentReviewerRow(
	coherence: PrReviewTranscriptBatchCoherence,
	itemId: string,
	reviewerClaims: ReadonlyMap<string, PrReviewItemClaim> | undefined,
): boolean {
	// A coherent critic batch always carries bindings; absent bindings on a
	// coherent entry means out-of-band mutation, so fail closed.
	const bindings = coherence.reviewerItemBindings;
	const bindingKey =
		coherence.reviewerItemBindingKeyEncoding === 'prefixed-v1'
			? reviewerItemBindingKey(itemId)
			: itemId;
	const bound =
		bindings && Object.hasOwn(bindings, bindingKey)
			? bindings[bindingKey]
			: undefined;
	const current = reviewerClaims?.get(itemId)?.rowDigest;
	return Boolean(bound && current && bound === current);
}

/**
 * The single item-keyed computation behind reviewer/critic settlement AND every
 * reviewer/critic verdict derivation.
 *
 * Settlement *is* `unclaimed.length === 0` over this map, so settlement can never
 * pass while derivation returns nothing — the failure mode that would let
 * CONFIRMED CRITICAL/HIGH findings ship without critic coverage.
 *
 * Scanning the window reverse-chronologically and claiming only *unclaimed*
 * items makes first-write-wins equal "most recent successful lane per item wins",
 * which is the explicit conflict rule for the case where two batches both carry a
 * parseable verdict for one item. Memoized per gate context so two passes never
 * hold two different verdict maps.
 *
 * The scan stops as soon as every required item is claimed (issue #1968 FIX 5).
 * `readLaneOutput` is a synchronous `readFileSync` per lane per batch, and the
 * window can hold up to `MAX_WORKFLOW_BATCHES` batches, so scanning past a
 * complete claim set is unbounded blocking I/O for no verdict change — first
 * write wins, and every required item has already been written.
 *
 * `exhaustive` turns the exit off for the batch GC, which prunes a reviewer
 * batch on "it contributed no claim". Being precise about what that buys: with
 * *this* exit condition the two scans yield the same `contributingBatchIds`,
 * because the exit fires only when every required item is claimed and a batch
 * reached after that point could never have claimed anything anyway. The flag is
 * therefore not fixing a live divergence — it decouples a durable-state decision
 * from a performance heuristic, so that weakening the exit condition later
 * cannot silently turn "not examined" into "proven inert". It also keeps the
 * whole-window abandoned-lane diagnostics intact for the GC's scan.
 */
export function composePrReviewPhaseVerdicts(
	directory: string,
	state: PrReviewTranscriptState,
	phase: PrReviewComposablePhase,
	ctx: PrReviewTranscriptContext,
	exhaustive = false,
): PrReviewPhaseComposition {
	const memoized = phase === 'reviewer' ? ctx.reviewer : ctx.critic;
	if (memoized && !exhaustive) return memoized;

	const requiredInventory =
		phase === 'reviewer'
			? derivePrReviewCandidateInventory(directory, state, ctx)
			: derivePrReviewCriticInventory(directory, state, ctx);
	const reviewerClaims =
		phase === 'critic'
			? authoritativeReviewerClaims(directory, state, ctx)
			: undefined;
	const forbiddenSubagentSessionIds =
		phase === 'critic'
			? reviewerSubagentSessionIds(directory, state)
			: new Set<string>();
	const expectedMode = `swarm-pr-review:${phase}`;
	const window = prReviewPhaseWindow(state, phase);
	const requiredSet = new Set(requiredInventory);
	const claims = new Map<string, PrReviewItemClaim>();
	const contributingBatchIds: string[] = [];
	const diagnostics: string[] = [];
	const satisfiedObligations = new Set<string>();
	const scannedBatches: PrReviewTranscriptBatch[] = [];

	for (const batch of [...window].reverse()) {
		scannedBatches.push(batch);
		if (
			!batchMayContributeClaims(
				directory,
				state,
				batch,
				phase,
				requiredInventory,
				forbiddenSubagentSessionIds,
				reviewerClaims,
				ctx,
			)
		) {
			appendCompositionDiagnostic(
				diagnostics,
				`${phase} batch "${batch.batchId}" was validated against a different inventory or is not wholly successful legacy state; it contributes no claims`,
			);
			continue;
		}
		const coherence = state.prReviewBatchCoherence?.[batch.batchId];
		let contributed = false;
		for (const qualified of recordsPassingBatchIntegrity(
			directory,
			state,
			batch.batchId,
			batch.lanes,
			expectedMode,
			batch.validatedAt,
			true,
			forbiddenSubagentSessionIds,
		)) {
			const artifact = loadArtifactPassingLaneIntegrity(
				directory,
				state,
				qualified.record,
				expectedMode,
				qualified.expectedWorkflowLane,
				ctx.revisionDigest,
			);
			if (!artifact) continue;
			const declaredItems = qualified.expectedLane.reviewItemIds ?? [];
			const { markerRows, parsed } = parsePrReviewVerdictRows(
				artifact.text,
				declaredItems,
				phase,
				reviewerClaims,
			);
			if (!verdictRowsContainOnlyAssignedIds(markerRows, declaredItems)) {
				appendCompositionDiagnostic(
					diagnostics,
					`${phase} lane "${qualified.expectedLane.laneId}" contains an unassigned verdict row; it contributes no claims`,
				);
				continue;
			}
			if (declaredItems.length > 0 && parsed.size === declaredItems.length) {
				satisfiedObligations.add(qualified.expectedWorkflowLane);
			}
			for (const [itemId, verdict] of parsed) {
				if (!requiredSet.has(itemId) || claims.has(itemId)) continue;
				// Defense in depth: the persisted inventory this batch was
				// validated against must still list the item. Declaration time
				// already makes the lane item set equal to it, so a mismatch here
				// means the persisted state was mutated out of band.
				if (coherence && !coherence.validatedInventory.includes(itemId)) {
					continue;
				}
				if (
					phase === 'critic' &&
					coherence &&
					!criticClaimIsBoundToCurrentReviewerRow(
						coherence,
						itemId,
						reviewerClaims,
					)
				) {
					continue;
				}
				claims.set(itemId, {
					batchId: batch.batchId,
					laneId: qualified.expectedLane.laneId,
					workflowLane: qualified.expectedWorkflowLane,
					...verdict,
				});
				contributed = true;
			}
		}
		if (contributed) contributingBatchIds.push(batch.batchId);
		if (!exhaustive && claims.size === requiredSet.size) break;
	}

	// The lane-level "every declared obligation across every batch in the window
	// must be settled" requirement was deliberately dropped: it is part of the
	// all-or-nothing accounting that forces a full re-run for one failed lane,
	// and it re-blocks exactly the composed-retry case. Item completeness
	// (`unclaimed.length === 0`) is the stronger property for what actually
	// ships — verdicts are per item; lane ids are bookkeeping. An abandoned
	// declared lane is now a named diagnostic, not a block.
	//
	// Scoped to the batches actually scanned: an unscanned batch's lanes were
	// never examined, so reporting them as "produced no successful exact
	// artifact" would be an unevidenced claim. Nothing is lost — the early exit
	// only fires once every required item is claimed, and the diagnostic exists
	// to explain a settlement that succeeded despite abandoned lanes.
	for (const obligation of new Set(
		scannedBatches.flatMap((batch) =>
			batch.lanes.map((lane) => lane.workflowLane),
		),
	)) {
		if (satisfiedObligations.has(obligation)) continue;
		appendCompositionDiagnostic(
			diagnostics,
			`declared ${phase} lane "${obligation}" produced no successful exact artifact`,
		);
	}

	const composition: PrReviewPhaseComposition = {
		claims,
		requiredInventory,
		unclaimed: requiredInventory.filter((itemId) => !claims.has(itemId)),
		contributingBatchIds,
		diagnostics,
	};
	// An exhaustive pass is a superset of the memoizable one, but it is computed
	// for a different question (which batches are inert) and its diagnostics
	// cover a wider window; never let it become the map the gates read.
	if (!exhaustive) {
		if (phase === 'reviewer') ctx.reviewer = composition;
		else ctx.critic = composition;
	}
	return composition;
}

// ---------------------------------------------------------------------------
// Transcript/artifact-text → canonical conversion cluster (moved verbatim)
// ---------------------------------------------------------------------------

export interface IndexedVerdictRows {
	markerRows: string[][];
	rowsByItemId: Map<string, string[][]>;
	recoveries: Array<{
		marker: '[REVIEWED]' | '[CRITIC]';
		itemId: string;
		recovery: 'legacy-fidelity-safe' | 'legacy-lossy';
	}>;
}

export function indexVerdictRows(
	text: string,
	marker: '[REVIEWED]' | '[CRITIC]',
): IndexedVerdictRows {
	const markerRows: string[][] = [];
	const rowsByItemId = new Map<string, string[][]>();
	const recoveries: IndexedVerdictRows['recoveries'] = [];
	for (const line of text.split(/\r?\n/)) {
		const row = parsePrReviewVerdictRow(
			line,
			marker === '[REVIEWED]' ? 'reviewer' : 'critic',
		);
		if (!row) continue;
		const fields = row.fields;
		if (row.recoveredOverflow) {
			const recovery = row.overflowClass as
				| 'legacy-fidelity-safe'
				| 'legacy-lossy';
			const itemId = fields[1] ?? '(missing)';
			recoveries.push({ marker, itemId, recovery });
			warn(
				'PR_REVIEW recovered a legacy verdict row with unescaped pipe overflow',
				{
					marker,
					itemId,
					recovery,
				},
			);
		}
		markerRows.push(fields);
		const itemId = fields[1] ?? '';
		const rows = rowsByItemId.get(itemId);
		if (rows) rows.push(fields);
		else rowsByItemId.set(itemId, [fields]);
	}
	return { markerRows, rowsByItemId, recoveries };
}

export function validateReviewerVerdictFields(
	fields: string[],
): string[] | null {
	const parsed = PrReviewReviewerVerdictFieldsSchema.safeParse(fields);
	return parsed.success ? [...parsed.data] : null;
}

/**
 * Digest of the FULL canonical reviewer row, not the classification/severity
 * pair a reviewer verdict projects to. Only 2 of the 12 required fields survive
 * that projection, so a tuple binding would still match a row whose evidence,
 * file:line and root cause all changed. Fields are joined on NUL, which
 * `pipeFields` can never produce, so no field boundary is forgeable.
 */
export function reviewerVerdictRowDigest(fields: readonly string[]): string {
	return createHash('sha256').update(fields.join('\0')).digest('hex');
}

/**
 * Per-item verdicts an artifact actually carries, as a map rather than a
 * boolean. This is the granularity the composition needs: one unparseable item
 * must not discard its healthy siblings in the same lane.
 */
export function parseLaneItemVerdicts(
	text: string,
	itemIds: readonly string[],
	phase: PrReviewComposablePhase,
	reviewerClaims?: ReadonlyMap<string, PrReviewItemClaim>,
): Map<
	string,
	{
		classification: string;
		severity: string;
		riskImpact?: PrReviewRiskImpact;
		riskTags?: PrReviewRiskTag[];
		rowDigest?: string;
	}
> {
	return parsePrReviewVerdictRows(text, itemIds, phase, reviewerClaims).parsed;
}

export function parsePrReviewVerdictRows(
	text: string,
	itemIds: readonly string[],
	phase: PrReviewComposablePhase,
	reviewerClaims?: ReadonlyMap<string, PrReviewItemClaim>,
): {
	markerRows: string[][];
	parsed: Map<
		string,
		{
			classification: string;
			severity: string;
			riskImpact?: PrReviewRiskImpact;
			riskTags?: PrReviewRiskTag[];
			rowDigest?: string;
		}
	>;
	recoveries: IndexedVerdictRows['recoveries'];
} {
	const parsed = new Map<
		string,
		{
			classification: string;
			severity: string;
			riskImpact?: PrReviewRiskImpact;
			riskTags?: PrReviewRiskTag[];
			rowDigest?: string;
		}
	>();
	const marker = phase === 'reviewer' ? '[REVIEWED]' : '[CRITIC]';
	const { markerRows, rowsByItemId, recoveries } = indexVerdictRows(
		text,
		marker,
	);
	for (const itemId of itemIds) {
		if (itemId === PR_REVIEW_DISCARDED_EXAMPLE_ITEM_ID) continue;
		if (phase === 'reviewer') {
			const rows = rowsByItemId.get(itemId);
			const fields =
				rows?.length === 1 ? validateReviewerVerdictFields(rows[0]) : null;
			if (!fields) continue;
			parsed.set(itemId, {
				classification: fields[2],
				severity: fields[4],
				// Fields 10/11 are the typed risk metadata (issue #2383); the
				// parse boundary guarantees they exist (legacy ten-field rows
				// were normalized to UNKNOWN / no tags there).
				riskImpact: fields[10] as PrReviewRiskImpact,
				riskTags: parsePrReviewRiskTagsField(fields[11] ?? ''),
				rowDigest: reviewerVerdictRowDigest(fields),
			});
			continue;
		}
		const rows = rowsByItemId.get(itemId);
		const verdict =
			rows?.length === 1
				? validateCriticVerdictFields(
						rows[0],
						reviewerClaims?.get(itemId)?.severity,
					)
				: null;
		if (!verdict) continue;
		parsed.set(itemId, {
			classification: verdict.status,
			severity: verdict.severity,
		});
	}
	return { markerRows, parsed, recoveries };
}

/** Exact assigned-row contract used by both normal and recovered collection. */
export function analyzePrReviewVerdictRowContract(
	text: string,
	itemIds: readonly string[],
	phase: PrReviewComposablePhase,
	reviewerClaims?: ReadonlyMap<string, PrReviewItemClaim>,
): {
	ok: boolean;
	expected: string;
	actual: string;
	recoveries: IndexedVerdictRows['recoveries'];
} {
	const marker = phase === 'reviewer' ? '[REVIEWED]' : '[CRITIC]';
	const assigned = new Set(itemIds);
	const { markerRows, parsed, recoveries } = parsePrReviewVerdictRows(
		text,
		itemIds,
		phase,
		reviewerClaims,
	);
	const observedIds = markerRows.map((fields) => fields[1] || '(missing)');
	const unexpectedIds = [
		...new Set(observedIds.filter((itemId) => !assigned.has(itemId))),
	];
	const invalidOrMissingIds = itemIds.filter((itemId) => !parsed.has(itemId));
	return {
		ok:
			verdictRowIdsMatchExactly(markerRows, itemIds) &&
			invalidOrMissingIds.length === 0,
		expected: `exactly one parseable ${marker} row for assigned IDs ${JSON.stringify(itemIds)} and no other ${marker} IDs`,
		actual: JSON.stringify({
			rowCount: markerRows.length,
			observedIds,
			invalidOrMissingIds,
			unexpectedIds,
		}),
		recoveries,
	};
}

/** Exact one-row-per-assigned-ID identity check, independent of row semantics. */
function verdictRowIdsMatchExactly(
	markerRows: readonly string[][],
	itemIds: readonly string[],
): boolean {
	if (itemIds.length === 0 || markerRows.length !== itemIds.length)
		return false;
	const assigned = new Set(itemIds);
	if (assigned.size !== itemIds.length) return false;
	const observed = new Set<string>();
	for (const fields of markerRows) {
		const itemId = fields[1] ?? '';
		if (!assigned.has(itemId) || observed.has(itemId)) return false;
		observed.add(itemId);
	}
	return observed.size === assigned.size;
}

/**
 * Settlement composes valid assigned siblings item-by-item, but an invented ID
 * invalidates the entire artifact because no declared ownership can authorize
 * that row. Missing or duplicate assigned rows remain per-item parse failures.
 */
function verdictRowsContainOnlyAssignedIds(
	markerRows: readonly string[][],
	itemIds: readonly string[],
): boolean {
	if (itemIds.length === 0) return false;
	const assigned = new Set(itemIds);
	return markerRows.every((fields) => assigned.has(fields[1] ?? ''));
}

export function parseCriticVerdict(
	text: string,
	itemId: string,
	reviewerSeverity?: string,
): { status: string; severity: string } | null {
	const rows = indexVerdictRows(text, '[CRITIC]').rowsByItemId.get(itemId);
	if (!rows || rows.length !== 1) return null;
	return validateCriticVerdictFields(rows[0], reviewerSeverity);
}

export function validateCriticVerdictFields(
	fields: string[],
	reviewerSeverity?: string,
): { status: string; severity: string } | null {
	const parsed = PrReviewCriticVerdictFieldsSchema.safeParse(fields);
	if (!parsed.success) return null;
	const verdict = parsed.data;
	if (reviewerSeverity) {
		const reviewerRank = REVIEW_SEVERITY_RANK.get(reviewerSeverity);
		const criticRank = REVIEW_SEVERITY_RANK.get(verdict[3]);
		if (reviewerRank === undefined || criticRank === undefined) return null;
		if (verdict[2] === 'UPHELD' && criticRank !== reviewerRank) return null;
		if (verdict[2] === 'DOWNGRADED' && criticRank >= reviewerRank) return null;
	}
	return { status: verdict[2], severity: verdict[3] };
}

export function artifactHasExactPositiveVerdictRow(
	text: string,
	marker: string,
	itemId: string,
	positiveVerdict: string,
): boolean {
	// Same trailing-field pipe tolerance as feedbackArtifactCoversItems: the
	// fourth field is free-text and may legitimately contain literal pipes.
	const rows = text
		.split(/\r?\n/)
		.map((line) => pipeFieldsCapped(line, 4))
		.filter((fields) => fields[0] === marker && fields[1] === itemId);
	return (
		rows.length === 1 &&
		rows[0].length >= 4 &&
		rows[0][2] === positiveVerdict &&
		rows[0].slice(1, 4).every(Boolean)
	);
}

export function pipeFields(line: string): string[] {
	if (!line.includes('|')) return [];
	return line.split('|').map((field) => field.trim());
}

/**
 * `pipeFields` capped at the row's canonical field count: separators beyond the
 * expected count merge back into the trailing (free-text) field. Verdict rows
 * ([REVIEWED], [CRITIC], [FEEDBACK-VERIFIED]) carry prose evidence in their
 * last field, and prose containing literal pipes (regex text, `,;|`, shell
 * snippets) otherwise splits the row past its strict field-count check and the
 * whole verdict becomes unparseable. Deterministic: the enumerated leading
 * fields are never merged.
 */
export function pipeFieldsCapped(
	line: string,
	expectedFieldCount: number,
): string[] {
	const fields = pipeFields(line);
	if (fields.length <= expectedFieldCount) return fields;
	const capped = [
		...fields.slice(0, expectedFieldCount - 1),
		fields.slice(expectedFieldCount - 1).join('|'),
	];
	// The enumerated leading fields are untouched, so machine-checked positions
	// (classification, severity, file:line) stay correct. But the pipe may have
	// originated in a NON-trailing prose field, in which case the trailing prose
	// fields are re-arranged rather than preserved. Fidelity-safe only for
	// trailing-field pipes; this warn (debug-gated) is the only trace.
	warn(
		`[pr-workflow-gate] verdict row pipe tail-merge applied (expected ${expectedFieldCount} fields, received ${fields.length}); leading machine fields preserved, trailing prose fields merged: ${line.slice(0, 120)}`,
	);
	return capped;
}

export function feedbackArtifactCoversItems(
	directory: string,
	state: PrReviewTranscriptState,
	batchId: string,
	laneId: string,
	itemIds: readonly string[],
): boolean {
	const record = findByBatchId(directory, batchId, {
		parentSessionId: state.sessionID,
	}).find((candidate) => candidate.laneId === laneId);
	const ref =
		record?.result?.outputRef?.trim() ??
		record?.terminalResult?.result.outputRef?.trim();
	const loaded = ref ? readLaneOutput(directory, ref) : null;
	if (!loaded) return false;
	const rows = loaded.artifact.text
		.split(/\r?\n/)
		.map((line) => pipeFieldsCapped(line, 4))
		.filter((fields) => fields[0] === '[FEEDBACK-VERIFIED]');
	if (rows.length !== itemIds.length) return false;
	return itemIds.every((itemId) => {
		const matches = rows.filter((fields) => fields[1] === itemId);
		return (
			matches.length === 1 &&
			matches[0].length === 4 &&
			matches[0].slice(1, 4).every(Boolean) &&
			FEEDBACK_CLASSIFICATIONS.has(matches[0][2])
		);
	});
}

export function feedbackArtifactTextCoversItems(
	text: string,
	itemIds: readonly string[],
): boolean {
	const rows = text
		.split(/\r?\n/)
		.map((line) => pipeFieldsCapped(line, 4))
		.filter((fields) => fields[0] === '[FEEDBACK-VERIFIED]');
	if (rows.length !== itemIds.length) return false;
	return itemIds.every((itemId) => {
		const matches = rows.filter((fields) => fields[1] === itemId);
		return (
			matches.length === 1 &&
			matches[0].length === 4 &&
			matches[0].slice(1, 4).every(Boolean) &&
			FEEDBACK_CLASSIFICATIONS.has(matches[0][2])
		);
	});
}

/**
 * Read the settled verification classification of every inventory item from the
 * settled verification batches' lane outputs (issue #2131 criterion C1). An
 * item missing from the map has no settled verified classification.
 */
export function readSettledFeedbackClassifications(
	directory: string,
	state: PrReviewTranscriptState,
): Map<string, string> {
	const classifications = new Map<string, string>();
	for (const record of state.prFeedbackVerifications ?? []) {
		for (const ownership of record.ownership) {
			const delegation = findByBatchId(directory, record.batchId, {
				parentSessionId: state.sessionID,
			}).find((candidate) => candidate.laneId === ownership.laneId);
			const ref =
				delegation?.result?.outputRef?.trim() ??
				delegation?.terminalResult?.result.outputRef?.trim();
			const loaded = ref ? readLaneOutput(directory, ref) : null;
			if (!loaded) continue;
			for (const line of loaded.artifact.text.split(/\r?\n/)) {
				// Same trailing-field pipe tolerance as feedbackArtifactCoversItems:
				// the fourth field is free-text and may legitimately contain literal
				// pipes. Parsing it raw here let coverage accept a row the settled
				// read then skipped, blocking a verified no-change item (PR #2182
				// review finding UIB-002).
				const fields = pipeFieldsCapped(line, 4);
				if (
					fields[0] !== '[FEEDBACK-VERIFIED]' ||
					fields.length !== 4 ||
					!fields.slice(1, 4).every(Boolean) ||
					!FEEDBACK_CLASSIFICATIONS.has(fields[2])
				) {
					continue;
				}
				// A duplicate conflicting classification for one item is a
				// contract violation; keep the first occurrence deterministic.
				if (!classifications.has(fields[1])) {
					classifications.set(fields[1], fields[2]);
				}
			}
		}
	}
	return classifications;
}

// ---------------------------------------------------------------------------
// Guardrail-consumable aliases + test surface
// ---------------------------------------------------------------------------

/**
 * Issue #2385 guardrail aliases: the transcript-conversion identifiers may
 * appear only in this module (`scanTranscriptParsingOutsideAdapter` in
 * `src/pr-review/guardrails.ts`), so the owning gate imports these aliases
 * instead of the canonical names.
 */
export const analyzeLegacyVerdictRowContract =
	analyzePrReviewVerdictRowContract;
export const legacyArtifactHasExactPositiveVerdictRow =
	artifactHasExactPositiveVerdictRow;
export const legacyFeedbackArtifactCoversItems = feedbackArtifactCoversItems;
export const legacyFeedbackArtifactTextCoversItems =
	feedbackArtifactTextCoversItems;
export const readLegacySettledFeedbackClassifications =
	readSettledFeedbackClassifications;

/**
 * The gate's historical `_test_exports` surface for this cluster: spread onto
 * the gate's `_test_exports` at module init so the existing suites keep seeing
 * the same property names without the gate naming the conversion identifiers.
 */
export const legacyTranscriptAdapterTestSurface = {
	pipeFieldsCapped,
	indexVerdictRows,
	reviewerVerdictRowDigest,
	analyzePrReviewVerdictRowContract,
	parseLaneItemVerdicts,
};
