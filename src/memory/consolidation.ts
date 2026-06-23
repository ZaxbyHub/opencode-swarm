import { z } from 'zod';
import {
	DURABLE_MEMORY_KINDS,
	EVIDENCE_REQUIRED_KINDS,
	type MemoryConfig,
} from './config';
import type { ConsolidationLogRecord } from './consolidation-log';
import { CURATOR_PROMOTED_MEMORY_MAX_TEXT_LENGTH } from './curator-decision-helpers';
import { computeDecayExpiry } from './decay';
import type { ProposeMemoryInput } from './gateway';
import type { MemoryRunLogEvent } from './run-log';
import { clusterByJaccard, jaccard, tokenize } from './scoring';
import { MEMORY_RECALL_SENTINEL } from './sentinel';
import type {
	AppliedMemoryChange,
	CuratorMemoryDecision,
	MemoryListFilter,
	MemoryProposal,
	MemoryRecord,
	MemorySource,
	NewMemoryRecord,
} from './types';

/** Agent role stamped on consolidation-emitted proposals (used to exclude them
 * from the engine's own episodic input — see reviewer finding #3). The
 * fire-and-forget wrapper sets this as the gateway context's agentRole. */
export const CONSOLIDATION_AGENT_ROLE = 'curator_consolidation';

/** Narrow gateway surface the engine depends on (MemoryGateway satisfies it). */
export interface ConsolidationGateway {
	isEnabled(): boolean;
	listProposals(filter?: {
		status?: MemoryProposal['status'];
		limit?: number;
	}): Promise<MemoryProposal[]>;
	listMemories(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
	propose(input: ProposeMemoryInput): Promise<MemoryProposal>;
	applyCuratorDecision(
		decision: CuratorMemoryDecision,
	): Promise<AppliedMemoryChange>;
	upsertCurated(record: MemoryRecord): Promise<MemoryRecord>;
}

export type DistillLLMDelegate = (
	systemPrompt: string,
	userInput: string,
	signal?: AbortSignal,
) => Promise<string>;

export interface ConsolidationDeps {
	gateway: ConsolidationGateway;
	llmDelegate?: DistillLLMDelegate;
	now: () => Date;
	logEvent: (event: MemoryRunLogEvent) => Promise<void>;
	readLog: () => Promise<ConsolidationLogRecord[]>;
	appendLog: (record: ConsolidationLogRecord) => Promise<void>;
	signal?: AbortSignal;
}

export interface ConsolidationInput {
	directory: string;
	phaseNumber: number;
	runId?: string;
	config: MemoryConfig;
}

export interface ConsolidationResult {
	skipped: boolean;
	skipReason?:
		| 'disabled'
		| 'already_consolidated'
		| 'no_llm_delegate_decay_only'
		| 'aborted';
	phaseNumber: number;
	clusterCount: number;
	clustersDeferred: number;
	decisionsEmitted: number;
	added: number;
	superseded: number;
	contradictionsDetected: number;
	deduped: number;
	proposed: number;
	memoriesDecayed: number;
	errored: number;
}

const DistilledFactSchema = z.object({
	text: z.string().min(1).max(2000),
	kind: z.enum([
		'user_preference',
		'project_fact',
		'architecture_decision',
		'repo_convention',
		'api_finding',
		'code_pattern',
		'test_pattern',
		'failure_pattern',
		'security_note',
		'evidence',
		'todo',
		'scratch',
	]),
	confidence: z.number().min(0).max(1),
	contradictsMemoryId: z
		.string()
		.regex(/^mem_[a-f0-9]{16}$/)
		.optional(),
});

const DistillationOutputSchema = z.object({
	facts: z.array(DistilledFactSchema).max(50),
});

export type DistilledFact = z.infer<typeof DistilledFactSchema>;

/**
 * Parse the curator LLM's distillation output. Tolerant of ```json fences and
 * surrounding prose. Returns [] on any parse/validation failure (caller counts
 * the cluster as skipped rather than aborting the pass).
 */
export function parseDistillationOutput(raw: string): DistilledFact[] {
	const candidates: string[] = [];
	const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
	const firstBrace = raw.indexOf('{');
	const lastBrace = raw.lastIndexOf('}');
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		candidates.push(raw.slice(firstBrace, lastBrace + 1));
	}
	candidates.push(raw.trim());
	for (const candidate of candidates) {
		try {
			const parsed = DistillationOutputSchema.parse(JSON.parse(candidate));
			return parsed.facts;
		} catch {
			// try next candidate
		}
	}
	return [];
}

export type DecisionPlan =
	| { type: 'add'; fact: DistilledFact }
	| { type: 'supersede'; fact: DistilledFact; oldMemoryId: string }
	| { type: 'proposal'; fact: DistilledFact; reason: string }
	| { type: 'dedup'; fact: DistilledFact; duplicateOf: string }
	| { type: 'skip'; fact: DistilledFact; reason: string };

/**
 * Pure decision derivation for a single distilled fact against existing items.
 * Encapsulates the auto-apply eligibility rules so they are unit-testable
 * without a gateway:
 *  - sentinel-bearing text is skipped (defense in depth; the write guard also
 *    rejects it);
 *  - `scratch` is never promoted to semantic memory;
 *  - only DURABLE_MEMORY_KINDS, ≤500-char, ≥autoApplyMinConfidence facts are
 *    auto-applied; everything else is filed as a pending proposal;
 *  - a contradiction (explicit `contradictsMemoryId` that resolves to an
 *    existing active memory) becomes a supersede;
 *  - a near-duplicate (Jaccard ≥ threshold) becomes a no-op dedup.
 */
export function deriveDecision(
	fact: DistilledFact,
	existing: MemoryRecord[],
	options: { autoApplyMinConfidence: number; jaccardThreshold: number },
): DecisionPlan {
	if (fact.text.includes(MEMORY_RECALL_SENTINEL)) {
		return { type: 'skip', fact, reason: 'contains recall sentinel' };
	}
	if (fact.kind === 'scratch') {
		return {
			type: 'skip',
			fact,
			reason: 'scratch is not promoted to semantic memory',
		};
	}
	const eligible =
		DURABLE_MEMORY_KINDS.has(fact.kind) &&
		fact.text.length <= CURATOR_PROMOTED_MEMORY_MAX_TEXT_LENGTH &&
		fact.confidence >= options.autoApplyMinConfidence;

	if (fact.contradictsMemoryId) {
		const target = existing.find((m) => m.id === fact.contradictsMemoryId);
		if (target && eligible) {
			return { type: 'supersede', fact, oldMemoryId: target.id };
		}
		// Contradiction flagged but not auto-appliable → leave for human review.
		return {
			type: 'proposal',
			fact,
			reason: target
				? 'contradiction not auto-appliable (kind/length/confidence)'
				: 'contradiction target not found',
		};
	}

	const factTokens = tokenize(fact.text);
	for (const memory of existing) {
		if (
			jaccard(factTokens, tokenize(memory.text)) >= options.jaccardThreshold
		) {
			return { type: 'dedup', fact, duplicateOf: memory.id };
		}
	}

	if (!eligible) {
		const reason = !DURABLE_MEMORY_KINDS.has(fact.kind)
			? `kind ${fact.kind} is not auto-promotable`
			: fact.text.length > CURATOR_PROMOTED_MEMORY_MAX_TEXT_LENGTH
				? 'text exceeds promotable length'
				: 'confidence below auto-apply threshold';
		return { type: 'proposal', fact, reason };
	}
	return { type: 'add', fact };
}

/** True when at least one evidence ref is a real file/url/commit, as opposed to
 * only the synthetic `consolidation:phase-N` provenance marker (reviewer #4). */
function hasRealEvidence(evidenceRefs: string[]): boolean {
	return evidenceRefs.some(
		(r) =>
			/^https?:\/\//i.test(r) ||
			/^[a-f0-9]{40}$/i.test(r) ||
			r.includes('/') ||
			r.includes('\\'),
	);
}

function sourceForDistilled(
	evidenceRefs: string[],
	phaseNumber: number,
): MemorySource {
	const url = evidenceRefs.find((r) => /^https?:\/\//i.test(r));
	if (url) return { type: 'web', url, createdBy: 'curator_consolidation' };
	const file = evidenceRefs.find((r) => r.includes('/') || r.includes('\\'));
	if (file)
		return { type: 'file', filePath: file, createdBy: 'curator_consolidation' };
	return {
		type: 'agent',
		ref: `consolidation:phase-${phaseNumber}`,
		createdBy: 'curator_consolidation',
	};
}

function buildDistillationPrompt(
	cluster: MemoryProposal[],
	relatedExisting: MemoryRecord[],
): string {
	const episodic = cluster
		.map((p, i) => {
			const text = p.proposedRecord?.text ?? p.rationale;
			return `[E${i + 1}] kind=${p.proposedRecord?.kind ?? 'n/a'} | ${text}`;
		})
		.join('\n');
	const existing = relatedExisting
		.slice(0, 20)
		.map((m) => `[${m.id}] kind=${m.kind} | ${m.text}`)
		.join('\n');
	return [
		'You are consolidating raw episodic memory into durable semantic facts.',
		'',
		'Episodic events (verbatim):',
		episodic,
		'',
		'Existing durable memories (for dedup/contradiction):',
		existing || '(none)',
		'',
		'Emit STRICT JSON only: {"facts":[{"text":..,"kind":..,"confidence":0-1,"contradictsMemoryId"?:"mem_..."}]}',
		'Rules: only emit facts directly supported by the cited episodic evidence.',
		'If uncertain, omit the fact (emit fewer facts or an empty array).',
		`Use durable kinds (${Array.from(DURABLE_MEMORY_KINDS).join(', ')}); keep each fact under ${CURATOR_PROMOTED_MEMORY_MAX_TEXT_LENGTH} characters.`,
		'Set contradictsMemoryId only when a fact directly conflicts with an existing memory above.',
		'Never include the literal text "## Retrieved Swarm Memory".',
	].join('\n');
}

function aggregateEvidence(
	cluster: MemoryProposal[],
	phaseNumber: number,
): string[] {
	const refs = new Set<string>();
	for (const p of cluster) {
		for (const ref of p.evidenceRefs) refs.add(ref);
	}
	const list = Array.from(refs).slice(0, 19);
	list.push(`consolidation:phase-${phaseNumber}`);
	return list;
}

/**
 * Run one episodic→semantic consolidation pass for a completed phase.
 * Idempotent per `phaseNumber` (a completed log record short-circuits a rerun).
 * All IO is injected via {@link ConsolidationDeps} so the orchestration is
 * deterministically testable with a fake gateway and fake LLM delegate.
 */
export async function runConsolidationPass(
	input: ConsolidationInput,
	deps: ConsolidationDeps,
): Promise<ConsolidationResult> {
	const { phaseNumber, runId, config } = input;
	const consolidation = config.consolidation;
	const base: ConsolidationResult = {
		skipped: true,
		phaseNumber,
		clusterCount: 0,
		clustersDeferred: 0,
		decisionsEmitted: 0,
		added: 0,
		superseded: 0,
		contradictionsDetected: 0,
		deduped: 0,
		proposed: 0,
		memoriesDecayed: 0,
		errored: 0,
	};

	if (!config.enabled || !consolidation.enabled || !deps.gateway.isEnabled()) {
		return { ...base, skipReason: 'disabled' };
	}

	const priorLog = await deps.readLog();
	if (priorLog.some((r) => r.phaseNumber === phaseNumber)) {
		return { ...base, skipReason: 'already_consolidated' };
	}
	// Already-distilled source proposals (across prior phases) must not be
	// reprocessed (reviewer #2: processedProposalIds is now functional).
	const processedBefore = new Set<string>(
		priorLog.flatMap((r) => r.processedProposalIds),
	);

	const startedAt = deps.now().toISOString();
	const logKey = runId ?? 'unknown';
	await deps.logEvent({
		event: 'consolidation_started',
		runId: logKey,
		phaseNumber,
		timestamp: startedAt,
	});

	const allPending = await deps.gateway.listProposals({ status: 'pending' });
	// Exclude (a) proposals this consolidation loop itself emitted — otherwise
	// they are re-clustered as fresh episodic input every phase (reviewer #3) —
	// and (b) source proposals already distilled in a prior pass (reviewer #2).
	const pendingProposals = allPending.filter(
		(p) =>
			p.proposedBy?.agentRole !== CONSOLIDATION_AGENT_ROLE &&
			!processedBefore.has(p.id),
	);
	const existingMemories = await deps.gateway.listMemories({});

	const clusters = clusterByJaccard(
		pendingProposals,
		(p) => p.proposedRecord?.text ?? p.rationale,
		consolidation.jaccardThreshold,
	);
	const processable = clusters.slice(0, consolidation.maxClustersPerPass);
	const clustersDeferred = Math.max(0, clusters.length - processable.length);

	await deps.logEvent({
		event: 'cluster_count',
		runId: logKey,
		phaseNumber,
		clusterCount: clusters.length,
	});

	const result: ConsolidationResult = {
		...base,
		skipped: false,
		clusterCount: clusters.length,
		clustersDeferred,
	};
	const processedProposalIds = new Set<string>();

	if (!deps.llmDelegate) {
		// No model available: run decay-only and record the pass (still idempotent).
		result.memoriesDecayed = await applyDecay(existingMemories, input, deps);
		// applyDecay breaks early on abort with a partial count; do NOT finalize a
		// partially-decayed pass, or the phase is recorded complete and the
		// remaining memories permanently miss their decay on rerun.
		if (deps.signal?.aborted) {
			return { ...result, skipped: true, skipReason: 'aborted' };
		}
		await finalize(input, deps, result, startedAt, processedProposalIds);
		return { ...result, skipReason: 'no_llm_delegate_decay_only' };
	}

	// In-pass dedup of identical distilled fact texts (reviewer #5): avoids
	// double-applying / over-counting when the model emits the same fact twice.
	const seenFactTexts = new Set<string>();

	for (const cluster of processable) {
		// Cooperative abort (reviewer #1): the fire-and-forget wrapper aborts this
		// signal on timeout; stop before further writes and DO NOT finalize, so the
		// phase is retried rather than recorded as complete on partial work.
		if (deps.signal?.aborted) {
			return { ...result, skipped: true, skipReason: 'aborted' };
		}
		for (const p of cluster) processedProposalIds.add(p.id);
		let raw: string;
		try {
			const prompt = buildDistillationPrompt(cluster, existingMemories);
			raw = await deps.llmDelegate('', prompt, deps.signal);
		} catch {
			result.errored++;
			continue;
		}
		const facts = parseDistillationOutput(raw);
		const evidenceRefs = aggregateEvidence(cluster, phaseNumber);
		for (const fact of facts) {
			const normalized = fact.text.replace(/\s+/g, ' ').trim().toLowerCase();
			if (seenFactTexts.has(normalized)) continue;
			seenFactTexts.add(normalized);
			const plan = deriveDecision(fact, existingMemories, {
				autoApplyMinConfidence: consolidation.autoApplyMinConfidence,
				jaccardThreshold: consolidation.jaccardThreshold,
			});
			try {
				await executePlan(plan, evidenceRefs, input, deps, result);
			} catch {
				result.errored++;
			}
		}
	}

	if (deps.signal?.aborted) {
		return { ...result, skipped: true, skipReason: 'aborted' };
	}
	result.memoriesDecayed = await applyDecay(existingMemories, input, deps);
	// applyDecay breaks early on abort with a partial count; a mid-decay abort
	// must not finalize, otherwise the phase is recorded complete and the
	// un-decayed memories permanently miss their decay (rerun short-circuits as
	// already_consolidated).
	if (deps.signal?.aborted) {
		return { ...result, skipped: true, skipReason: 'aborted' };
	}
	await finalize(input, deps, result, startedAt, processedProposalIds);
	return result;
}

async function executePlan(
	plan: DecisionPlan,
	evidenceRefs: string[],
	input: ConsolidationInput,
	deps: ConsolidationDeps,
	result: ConsolidationResult,
): Promise<void> {
	const { phaseNumber } = input;
	if (plan.type === 'skip') return;
	if (plan.type === 'dedup') {
		result.deduped++;
		return;
	}
	const newRecord: NewMemoryRecord = {
		kind: plan.fact.kind,
		text: plan.fact.text,
		confidence: plan.fact.confidence,
		stability: 'durable',
		source: sourceForDistilled(evidenceRefs, phaseNumber),
		metadata: { consolidatedFromPhase: phaseNumber },
	};
	const rationale = `consolidation phase ${phaseNumber}`;

	// Reviewer #4: never auto-apply an evidence-required kind on the strength of
	// the synthetic `consolidation:phase-N` ref alone. Without real evidence
	// (file/url/commit) downgrade the decision to a pending proposal for review.
	const needsDowngrade =
		(plan.type === 'add' || plan.type === 'supersede') &&
		EVIDENCE_REQUIRED_KINDS.has(plan.fact.kind) &&
		!hasRealEvidence(evidenceRefs);
	const effectiveType = needsDowngrade ? 'proposal' : plan.type;

	if (effectiveType === 'proposal') {
		await deps.gateway.propose({
			operation: 'add',
			kind: plan.fact.kind,
			text: plan.fact.text,
			rationale:
				plan.type === 'proposal'
					? `${rationale}: ${plan.reason}`
					: `${rationale}: evidence-required kind lacks real evidence source`,
			evidenceRefs,
		});
		result.proposed++;
		return;
	}

	if (plan.type === 'supersede') {
		const proposal = await deps.gateway.propose({
			operation: 'supersede',
			kind: plan.fact.kind,
			text: plan.fact.text,
			targetMemoryId: plan.oldMemoryId,
			rationale,
			evidenceRefs,
		});
		if (proposal.status !== 'pending') {
			result.proposed++;
			return;
		}
		await deps.gateway.applyCuratorDecision({
			action: 'supersede',
			proposalId: proposal.id,
			oldMemoryId: plan.oldMemoryId,
			replacement: newRecord,
			reason: `contradiction superseded during phase ${phaseNumber} consolidation`,
		});
		result.superseded++;
		result.contradictionsDetected++;
		result.decisionsEmitted++;
		return;
	}

	// plan.type === 'add'
	const proposal = await deps.gateway.propose({
		operation: 'add',
		kind: plan.fact.kind,
		text: plan.fact.text,
		rationale,
		evidenceRefs,
	});
	if (proposal.status !== 'pending') {
		result.proposed++;
		return;
	}
	await deps.gateway.applyCuratorDecision({
		action: 'add',
		proposalId: proposal.id,
		memory: newRecord,
	});
	result.added++;
	result.decisionsEmitted++;
}

async function applyDecay(
	memories: MemoryRecord[],
	input: ConsolidationInput,
	deps: ConsolidationDeps,
): Promise<number> {
	let decayed = 0;
	const halfLives = input.config.consolidation.decayHalfLifeDays;
	const now = deps.now();
	for (const memory of memories) {
		if (deps.signal?.aborted) break;
		if (memory.metadata.deleted === true || memory.supersededBy) continue;
		const nextExpiry = computeDecayExpiry(memory, halfLives, now);
		if (!nextExpiry) continue;
		try {
			// Patch only expiresAt; preserve id/hash/timestamps.
			await deps.gateway.upsertCurated({ ...memory, expiresAt: nextExpiry });
			decayed++;
		} catch {
			// best-effort decay; skip records that fail validation
		}
	}
	return decayed;
}

async function finalize(
	input: ConsolidationInput,
	deps: ConsolidationDeps,
	result: ConsolidationResult,
	startedAt: string,
	processedProposalIds: Set<string>,
): Promise<void> {
	const { phaseNumber, runId } = input;
	const logKey = runId ?? 'unknown';
	const completedAt = deps.now().toISOString();
	await deps.logEvent({
		event: 'decisions_emitted',
		runId: logKey,
		phaseNumber,
		decisionsEmitted: result.decisionsEmitted,
	});
	await deps.logEvent({
		event: 'contradictions_detected',
		runId: logKey,
		phaseNumber,
		contradictionsDetected: result.contradictionsDetected,
	});
	await deps.logEvent({
		event: 'memories_decayed',
		runId: logKey,
		phaseNumber,
		memoriesDecayed: result.memoriesDecayed,
	});
	await deps.logEvent({
		event: 'consolidation_completed',
		runId: logKey,
		phaseNumber,
		clusterCount: result.clusterCount,
		decisionsEmitted: result.decisionsEmitted,
		contradictionsDetected: result.contradictionsDetected,
		memoriesDecayed: result.memoriesDecayed,
		timestamp: completedAt,
	});
	await deps.appendLog({
		phaseNumber,
		startedAt,
		completedAt,
		clusterCount: result.clusterCount,
		clustersDeferred: result.clustersDeferred,
		decisionsEmitted: result.decisionsEmitted,
		added: result.added,
		superseded: result.superseded,
		contradictionsDetected: result.contradictionsDetected,
		deduped: result.deduped,
		proposed: result.proposed,
		memoriesDecayed: result.memoriesDecayed,
		errored: result.errored,
		processedProposalIds: Array.from(processedProposalIds),
	});
}
