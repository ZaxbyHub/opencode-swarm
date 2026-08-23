import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { warn } from '../utils/logger';
import {
	DEFAULT_MEMORY_CONFIG,
	type MemoryConfig,
	resolveMemoryConfig,
} from './config';
import { applyPatchToMemory } from './curator-decision-helpers';
import { MemoryDisabledError, MemoryValidationError } from './errors';
import { LocalJsonlMemoryProvider } from './local-jsonl-provider';
import { canonicalOutcomePayload } from './outcome-events';
import {
	computePiiScore,
	createPiiDetector,
	type PiiDetector,
	type PiiFinding,
	summarizePiiFindings,
} from './pii';
import { toRecallBundle } from './prompt-block';
import type {
	MemoryProposalStore,
	MemoryProvider,
	MemoryRecallUsageEvent,
	MemoryRecallUsageFilter,
} from './provider';
import { getOrCreateProviderForRoot } from './provider-pool';
import { computeRedactionPolicyVersion, redactSecrets } from './redaction';
import {
	computeMemoryContentHash,
	createBundleId,
	createMemoryId,
	createProposalId,
	MAX_OUTCOME_QUESTION_LENGTH,
	MEMORY_OUTCOME_QUESTION_PREFIX,
	normalizeMemoryText,
	validateCuratorMemoryDecision,
	validateMemoryRecordRules,
} from './schema';
import type { RecallScoringDiagnostics } from './scoring';
import { MEMORY_RECALL_SENTINEL } from './sentinel';
import {
	isCohortRoot,
	resolveVettedMemoryRoot,
	type VettedMemoryRoot,
} from './storage-root';
import type {
	AppliedMemoryChange,
	CuratorMemoryDecision,
	MemoryAnchor,
	MemoryContext,
	MemoryKind,
	MemoryListFilter,
	MemoryOutcome,
	MemoryPatch,
	MemoryProposal,
	MemoryRecord,
	MemoryScopeRef,
	MemorySource,
	NewMemoryRecord,
	RecallBundle,
	RecallInjectionSkipReason,
	RecallMode,
	RecallRequest,
} from './types';

export interface MemoryGatewayOptions {
	config?: Partial<MemoryConfig>;
	provider?: MemoryProvider & Partial<MemoryProposalStore>;
	now?: () => Date;
}

export interface RecordMemoryOutcomeInput {
	memoryId?: string;
	question?: string;
	outcome: MemoryOutcome['outcome'];
	anchors?: MemoryAnchor[];
	correction?: string;
	eventId?: string;
}

export interface ProposeMemoryInput {
	operation: MemoryProposal['operation'];
	kind?: MemoryKind;
	text?: string;
	targetMemoryId?: string;
	relatedMemoryIds?: string[];
	rationale: string;
	evidenceRefs?: string[];
}

export interface RecallMemoryInput {
	query: string;
	task?: string;
	mode?: RecallMode;
	scopes?: MemoryScopeRef[];
	kinds?: MemoryKind[];
	maxItems?: number;
	tokenBudget?: number;
	minScore?: number;
	requireQuerySignal?: boolean;
	includeExpired?: boolean;
}

/**
 * PR #2310 feedback FB-L3: audit target for pii_rejected events. Deliberately
 * NOT the record id (a content hash of the rejected raw text — writing a
 * derivative of rejected content into the permanent audit chain defeats the
 * minimization goal; nothing consumes this field).
 */
const PII_REJECTION_EVENT_TARGET = 'pii_rejection';

export class MemoryGateway {
	private readonly config: MemoryConfig;
	private readonly provider: MemoryProvider & Partial<MemoryProposalStore>;
	/**
	 * #1850: the resolved vetted memory root. Used by `deriveAllowedScopes` to
	 * emit a cohort scope when cohort sharing is active, and by `propose` to
	 * stamp provenance. Resolved once at construction (sync pointer read).
	 */
	private readonly vettedRoot: VettedMemoryRoot;
	private readonly now: () => Date;
	private disposed = false;
	/** #1466: cached PII detector instance (NER keeps its loaded pipeline here). */
	private piiDetector: PiiDetector | undefined;

	constructor(
		private readonly context: MemoryContext,
		options: MemoryGatewayOptions = {},
	) {
		this.config = resolveMemoryConfig(options.config ?? DEFAULT_MEMORY_CONFIG);
		this.vettedRoot = resolveVettedMemoryRoot(context.directory, this.config);
		this.provider =
			options.provider ??
			createConfiguredMemoryProviderForRoot(this.vettedRoot, this.config);
		this.now = options.now ?? (() => new Date());
	}

	isEnabled(): boolean {
		return this.config.enabled;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.provider.close?.();
	}

	deriveAllowedScopes(): MemoryScopeRef[] {
		const resolvedRoot = path.resolve(this.context.directory);
		const repoId = createStableId(
			readGitRemoteUrl(resolvedRoot) ?? path.basename(resolvedRoot),
		);
		const workspaceId = createStableId(path.dirname(resolvedRoot));
		const scopes: MemoryScopeRef[] = [
			{ type: 'workspace', workspaceId },
			{
				type: 'repository',
				repoId,
				repoRoot: resolvedRoot,
			},
		];
		// #1850: when cohort sharing is active, emit a cohort scope. The
		// cohortId is the canonical #1846 id shared by all sibling worktrees,
		// so a record written by worktree A is visible to worktree B's recall
		// (the scope key matches). Per-session/per-run scopes below remain
		// worktree-local (acceptance #9).
		if (isCohortRoot(this.vettedRoot)) {
			scopes.push({
				type: 'cohort',
				cohortId: this.vettedRoot.cohortId,
			});
		}
		if (this.context.runId || this.context.sessionID) {
			scopes.push({
				type: 'run',
				runId: this.context.runId ?? this.context.sessionID,
			});
		}
		if (this.context.agentId || this.context.agentRole) {
			scopes.push({
				type: 'agent',
				agentId: this.context.agentId ?? this.context.agentRole,
				runId: this.context.runId ?? this.context.sessionID,
			});
		}
		return scopes;
	}

	async recall(input: RecallMemoryInput): Promise<RecallBundle> {
		this.assertEnabled();
		const query = normalizeMemoryText(input.query);
		if (query.length < 3) {
			throw new MemoryValidationError('query must be at least 3 characters');
		}
		const maxItems = clampInt(
			input.maxItems ?? this.config.recall.defaultMaxItems,
			1,
			20,
		);
		const tokenBudget = clampInt(
			input.tokenBudget ?? this.config.recall.defaultTokenBudget,
			100,
			5000,
		);
		const generatedAt = this.now().toISOString();
		const allowedScopes = this.deriveAllowedScopes();
		const scopes = input.scopes
			? validateRequestedScopes(input.scopes, allowedScopes)
			: allowedScopes;
		const request: RecallRequest = {
			query,
			task: input.task,
			agentRole: this.context.agentRole,
			mode: input.mode ?? 'manual',
			scopes,
			kinds: input.kinds,
			maxItems,
			tokenBudget,
			minScore: input.minScore ?? this.config.recall.minScore,
			requireQuerySignal: input.requireQuerySignal,
			includeExpired: input.includeExpired,
		};
		const recallResult = this.provider.recallWithDiagnostics
			? await this.provider.recallWithDiagnostics(request)
			: { items: await this.provider.recall(request) };
		const bundle = toRecallBundle({
			id: createBundleId(query, generatedAt),
			query,
			generatedAt,
			items: recallResult.items,
			tokenBudget,
			diagnostics: recallResult.diagnostics
				? {
						injectionSkipReason:
							input.mode === 'injection'
								? resolveInjectionSkipReason(recallResult.diagnostics)
								: undefined,
						candidateCount: recallResult.diagnostics.candidateCount,
						preScoredFilteredCount:
							recallResult.diagnostics.preScoredFilteredCount,
						noSignalCount: recallResult.diagnostics.noSignalCount,
						belowThresholdCount: recallResult.diagnostics.belowThresholdCount,
					}
				: undefined,
		});
		await this.provider.recordRecallUsage?.({
			bundleId: bundle.id,
			query,
			scopes,
			kinds: input.kinds,
			memoryIds: bundle.items.map((item) => item.record.id),
			scores: bundle.items.map((item) => item.score),
			tokenEstimate: bundle.tokenEstimate,
			agentRole: this.context.agentRole,
			runId: this.context.runId ?? this.context.sessionID,
			// ADDITIVE join key. Intentionally NOT defaulted to sessionID: an
			// unresolvable unit id must persist as NULL so attribution degrades to
			// session-scoped `runId` rather than re-deriving the session value.
			unitId: this.context.unitId,
			timestamp: generatedAt,
		});
		return bundle;
	}

	async propose(input: ProposeMemoryInput): Promise<MemoryProposal> {
		this.assertEnabled();
		if (!this.provider.createProposal) {
			throw new MemoryValidationError(
				'memory provider does not support proposals',
			);
		}
		const redactedFields = new Set<string>();
		const redactProposalField = (field: string, value: string): string => {
			const redacted = redactSecrets(value);
			if (redacted !== value) {
				redactedFields.add(field);
			}
			return redacted;
		};

		const rationale = redactProposalField(
			'rationale',
			normalizeMemoryText(input.rationale),
		);
		if (!rationale) {
			throw new MemoryValidationError('rationale is required');
		}
		const evidenceRefs = (input.evidenceRefs ?? [])
			.map((ref) => normalizeMemoryText(ref))
			.filter(Boolean)
			.map((ref) => redactProposalField('evidenceRefs', ref))
			.slice(0, 20);
		const needsRecord =
			input.operation === 'add' ||
			input.operation === 'update' ||
			input.operation === 'supersede';
		let proposedRecord: MemoryRecord | undefined;
		let status: MemoryProposal['status'] = 'pending';
		let reviewer: MemoryProposal['reviewer'] | undefined;
		let reviewedAt: string | undefined;
		let rejectionReason: string | undefined;
		const targetMemoryId =
			input.targetMemoryId === undefined
				? undefined
				: redactProposalField(
						'targetMemoryId',
						normalizeMemoryText(input.targetMemoryId),
					);
		const relatedMemoryIds = input.relatedMemoryIds?.map((id) =>
			redactProposalField('relatedMemoryIds', normalizeMemoryText(id)),
		);
		let proposalText = `${input.operation}:${targetMemoryId ?? ''}`;
		// #1466: detect-only PII summary attached to proposal metadata (never
		// matched text) when memory.redaction.detectPii is enabled.
		let piiSummary:
			| { score: number; countsByType: Record<string, number> }
			| undefined;

		if (needsRecord) {
			if (!input.kind) {
				throw new MemoryValidationError('kind is required for this operation');
			}
			if (!input.text) {
				throw new MemoryValidationError('text is required for this operation');
			}
			proposalText = input.text;
			const normalizedText = normalizeMemoryText(input.text);
			const redactedText = redactProposalField('text', normalizedText);
			const extractedPaths = extractFilePaths(evidenceRefs);
			const extractedSymbols = extractSymbols(evidenceRefs);
			const recordMetadata: Record<string, unknown> = {};
			if (extractedPaths.length > 0) {
				recordMetadata.files = extractedPaths;
			}
			if (extractedSymbols.length > 0) {
				recordMetadata.symbols = extractedSymbols;
			}
			proposedRecord = this.createRecord({
				kind: input.kind,
				text: redactedText,
				evidenceRefs,
				source: sourceFromEvidence(evidenceRefs, this.context),
				metadata: recordMetadata,
			});
			// #1466: single funnel call — the helper runs the FULL rule set
			// (evidence/secret/sentinel + PII threshold when findings are
			// supplied) exactly once per record.
			({ piiSummary } = await this.validateRecordWithPiiPolicy(proposedRecord));
		}

		if (redactedFields.size > 0) {
			status = 'rejected';
			reviewer = 'auto_policy';
			reviewedAt = this.now().toISOString();
			rejectionReason = `proposal field(s) contained a likely secret and were redacted: ${Array.from(redactedFields).join(', ')}`;
		}

		if (
			(input.operation === 'update' ||
				input.operation === 'delete' ||
				input.operation === 'supersede') &&
			!targetMemoryId
		) {
			throw new MemoryValidationError(
				`${input.operation} proposals require targetMemoryId`,
			);
		}
		if (input.operation === 'merge' && (relatedMemoryIds ?? []).length < 2) {
			throw new MemoryValidationError(
				'merge proposals require relatedMemoryIds',
			);
		}

		const createdAt = this.now().toISOString();
		const proposer =
			this.context.agentId ??
			this.context.agentRole ??
			this.context.sessionID ??
			'unknown';
		const proposal: MemoryProposal = {
			id: createProposalId({ createdAt, proposer, text: proposalText }),
			operation: input.operation,
			proposedRecord,
			targetMemoryId,
			relatedMemoryIds,
			proposedBy: {
				agentRole: this.context.agentRole,
				agentId: this.context.agentId,
				runId: this.context.runId ?? this.context.sessionID,
			},
			rationale,
			evidenceRefs,
			status,
			reviewer,
			reviewedAt,
			rejectionReason,
			createdAt,
			metadata: piiSummary ? { pii: piiSummary } : {},
		};
		return this.provider.createProposal(proposal);
	}

	/**
	 * Read-only passthroughs used by the consolidation engine. They assert the
	 * feature is enabled and that the underlying provider supports the
	 * capability (mirroring the `createProposal` guard), so the engine can
	 * depend on a stable gateway surface rather than the `Partial` provider.
	 */
	async listMemories(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
		this.assertEnabled();
		return this.provider.list(filter);
	}

	async listProposals(filter?: {
		status?: MemoryProposal['status'];
		limit?: number;
	}): Promise<MemoryProposal[]> {
		this.assertEnabled();
		if (!this.provider.listProposals) {
			throw new MemoryValidationError(
				'memory provider does not support proposals',
			);
		}
		return this.provider.listProposals(filter);
	}

	async listRecallUsage(
		filter?: MemoryRecallUsageFilter,
	): Promise<MemoryRecallUsageEvent[]> {
		this.assertEnabled();
		if (!this.provider.listRecallUsage) return [];
		return this.provider.listRecallUsage(filter);
	}

	async upsertCurated(record: MemoryRecord): Promise<MemoryRecord> {
		this.assertEnabled();
		// #1466: single validation funnel — full rule set plus PII policy
		// when enabled (see validateRecordWithPiiPolicy).
		const { parsed } = await this.validateRecordWithPiiPolicy(record);
		return this.provider.upsert(parsed);
	}

	async recordOutcome(input: RecordMemoryOutcomeInput): Promise<MemoryRecord> {
		this.assertEnabled();
		if (!this.provider.appendOutcome) {
			throw new MemoryValidationError(
				'memory provider does not support outcome capture',
			);
		}
		const hasId =
			typeof input.memoryId === 'string' && input.memoryId.length > 0;
		const question = input.question ? normalizeMemoryText(input.question) : '';
		if (hasId === question.length > 0) {
			throw new MemoryValidationError(
				'exactly one of memoryId or question is required',
			);
		}
		if (question.length > MAX_OUTCOME_QUESTION_LENGTH) {
			throw new MemoryValidationError(
				`question must be at most ${MAX_OUTCOME_QUESTION_LENGTH} characters`,
			);
		}
		if (input.outcome === 'corrected' && !input.correction?.trim()) {
			throw new MemoryValidationError(
				'corrected outcomes require correction text',
			);
		}
		// PR #2310 feedback FB-3: correction text is free text that lands in
		// durable outcome storage and is re-injected into prompts via the
		// reflection path — run it through the same write-boundary checks as
		// record bodies (sentinel/bundle bans + configured PII policy).
		if (input.correction) {
			await this.enforcePiiTextPolicy(normalizeMemoryText(input.correction));
		}
		let targetId = input.memoryId;
		if (!targetId) {
			const candidate = this.createRecord({
				kind: 'evidence',
				text: `${MEMORY_OUTCOME_QUESTION_PREFIX}${question}`,
				confidence: 0.5,
				stability: 'durable',
				tags: ['outcome-result'],
				source: { type: 'tool', ref: 'swarm_memory_outcome' },
				metadata: { outcomeQuestion: question },
			});
			const existing = await this.provider.get(candidate.id);
			if (!existing) {
				// #1466: the outcome-evidence record embeds the (user-supplied)
				// question text — run PII enforcement on it like any other
				// durable write.
				await this.validateRecordWithPiiPolicy(candidate);
				await this.provider.upsert(candidate);
			}
			targetId = candidate.id;
		}
		// A write-through publication failure may cause the exact tool invocation
		// to retry after its outcome event has already committed. Reuse the stored
		// timestamp for that stable event id so provider identity checks see the
		// byte-equivalent payload; any changed outcome/anchors/correction still
		// reaches the provider and fails closed as an id collision.
		const priorEvent =
			input.eventId && this.provider.listOutcomeEvents
				? (await this.provider.listOutcomeEvents()).find(
						(event) => event.id === input.eventId,
					)
				: undefined;
		if (priorEvent) {
			const requestedOutcome: MemoryOutcome = {
				outcome: input.outcome,
				at: priorEvent.outcome.at,
				...(this.context.unitId ? { taskId: this.context.unitId } : {}),
				...(input.correction
					? { correction: normalizeMemoryText(input.correction) }
					: {}),
			};
			const requestedPayload = canonicalOutcomePayload(
				requestedOutcome,
				input.anchors ?? [],
			);
			if (
				priorEvent.memoryId !== targetId ||
				requestedPayload !==
					canonicalOutcomePayload(priorEvent.outcome, priorEvent.anchors)
			) {
				throw new MemoryValidationError(
					'outcome event id already exists with a different payload',
				);
			}
			return this.provider.appendOutcome(
				priorEvent.memoryId,
				{ id: priorEvent.id, outcome: priorEvent.outcome },
				priorEvent.anchors,
			);
		}
		return this.provider.appendOutcome(
			targetId,
			{
				id: input.eventId ?? randomUUID(),
				outcome: {
					outcome: input.outcome,
					at: this.now().toISOString(),
					taskId: this.context.unitId,
					correction: input.correction
						? normalizeMemoryText(input.correction)
						: undefined,
				},
			},
			input.anchors,
		);
	}

	async applyCuratorDecision(
		decision: CuratorMemoryDecision,
	): Promise<AppliedMemoryChange> {
		this.assertEnabled();
		if (!this.provider.applyCuratorDecision) {
			throw new MemoryValidationError(
				'memory provider does not support curator decisions',
			);
		}
		const parsed = validateCuratorMemoryDecision(decision);
		const resolved = this.resolveCuratorDecision(parsed);
		// #1466: PII enforcement on curator-materialized durable records
		// (add / supersede replacement). The records were already rule-validated
		// by createRecordFromNew; re-validation with findings is idempotent.
		if (resolved.action === 'add' && resolved.memory) {
			await this.validateRecordWithPiiPolicy(resolved.memory);
		} else if (resolved.action === 'supersede' && resolved.replacement) {
			await this.validateRecordWithPiiPolicy(resolved.replacement);
		} else if (
			resolved.action === 'update' &&
			resolved.patch?.text !== undefined
		) {
			// #1466 (final-critic item 1): the provider merges the patch inside
			// its own transaction, where the PII detector cannot run — so the
			// gateway pre-merges patch text against the current record and runs
			// the SAME validation funnel on the merged result before applying.
			// Patch-less text edits (no new text) are covered by the original
			// record's validation.
			const existing = await this.provider.get(resolved.targetMemoryId);
			if (existing) {
				const merged = applyPatchToMemory(
					existing,
					resolved.patch,
					this.now().toISOString(),
				);
				await this.validateRecordWithPiiPolicy(merged);
			}
			// Absent target: the provider fails the decision with its own
			// typed error — nothing to validate.
		}
		return this.provider.applyCuratorDecision(resolved);
	}

	/**
	 * #1466: single write-boundary validation for every durable-record-
	 * materializing path (propose, upsertCurated, recordOutcome-created
	 * records, applyCuratorDecision).
	 *
	 * ALWAYS runs the full `validateMemoryRecordRules` rule set exactly ONCE
	 * per record (evidence/secret/sentinel rules — including when PII policy
	 * is off, the default). When `detectPii`/`rejectDurablePii` is on, the
	 * configured detector runs first and its findings ride the same single
	 * validation call (threshold logic lives only in the schema funnel). On a
	 * PII rejection the `pii_rejected` audit event is logged (types/score
	 * only, never matched text) before rethrowing; the rejected record is NOT
	 * persisted — storing rejected PII text would defeat the control.
	 *
	 * Returns the parsed record plus a matched-text-free PII summary for
	 * metadata annotation (undefined when nothing was found or detection is
	 * off). A detector that cannot run (opt-in NER without the peer
	 * dependency) fails closed with a typed error — never a silent skip.
	 */
	private async validateRecordWithPiiPolicy(record: MemoryRecord): Promise<{
		parsed: MemoryRecord;
		piiSummary?: { score: number; countsByType: Record<string, number> };
	}> {
		const { detectPii, rejectDurablePii } = this.config.redaction;
		let findings: PiiFinding[] | undefined;
		if (detectPii || rejectDurablePii) {
			if (!this.piiDetector) {
				this.piiDetector = createPiiDetector(this.config.redaction.piiDetector);
			}
			findings = await this.piiDetector.detect(record.text);
		}
		try {
			const parsed = validateMemoryRecordRules(record, {
				rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
				piiFindings: findings,
				rejectDurablePii,
				piiThreshold: this.config.redaction.piiThreshold,
			});
			return {
				parsed,
				...(findings && findings.length > 0
					? {
							piiSummary: {
								score: computePiiScore(findings),
								countsByType: findings.reduce<Record<string, number>>(
									(acc, f) => {
										acc[f.type] = (acc[f.type] ?? 0) + 1;
										return acc;
									},
									{},
								),
							},
						}
					: {}),
			};
		} catch (err) {
			if (
				err instanceof MemoryValidationError &&
				err.code === 'memory_pii_rejected'
			) {
				// PR #2310 feedback PRR-003/FB-L3: an audit-write failure must
				// never REPLACE the typed privacy-rejection error, and the
				// event target must not be the content-derived record id (a
				// hash of the rejected raw text).
				try {
					await this.provider.recordEvent?.(
						'pii_rejected',
						PII_REJECTION_EVENT_TARGET,
						err.message,
					);
				} catch (auditErr) {
					warn(
						'[memory] failed to persist pii_rejected audit event (the PII rejection itself still applies)',
						{
							reason:
								auditErr instanceof Error ? auditErr.message : String(auditErr),
						},
					);
				}
			}
			throw err;
		}
	}

	/**
	 * PR #2310 feedback FB-3: free-text that becomes durable memory state
	 * WITHOUT being a MemoryRecord body (outcome `correction` text — up to
	 * 4000 chars, agent-callable, and re-injected into prompts via the
	 * reflection path) must pass the same write-boundary checks: the DD-14
	 * sentinel/bundle bans and, when configured, the PII threshold.
	 */
	private async enforcePiiTextPolicy(text: string): Promise<void> {
		if (text.includes(MEMORY_RECALL_SENTINEL)) {
			throw new MemoryValidationError(
				'correction text cannot contain the recall sentinel header',
			);
		}
		if (text.includes('bundle_')) {
			throw new MemoryValidationError(
				'correction text cannot contain the recall bundle marker prefix',
			);
		}
		const { detectPii, rejectDurablePii } = this.config.redaction;
		if (!detectPii && !rejectDurablePii) return;
		if (!this.piiDetector) {
			this.piiDetector = createPiiDetector(this.config.redaction.piiDetector);
		}
		const findings = await this.piiDetector.detect(text);
		const score = computePiiScore(findings);
		if (rejectDurablePii && score > this.config.redaction.piiThreshold) {
			const summary = summarizePiiFindings(findings);
			const message = `durable memory correction exceeds the PII threshold: score ${score.toFixed(2)} (types: ${
				Object.entries(summary.countsByType)
					.map(([t, n]) => `${t}x${n}`)
					.join(', ') || 'none'
			}) exceeded threshold ${this.config.redaction.piiThreshold.toFixed(2)}`;
			try {
				await this.provider.recordEvent?.(
					'pii_rejected',
					PII_REJECTION_EVENT_TARGET,
					message,
				);
			} catch (auditErr) {
				warn(
					'[memory] failed to persist pii_rejected audit event (the PII rejection itself still applies)',
					{
						reason:
							auditErr instanceof Error ? auditErr.message : String(auditErr),
					},
				);
			}
			throw new MemoryValidationError(message, 'memory_pii_rejected');
		}
	}

	createRecord(input: {
		kind: MemoryKind;
		text: string;
		evidenceRefs?: string[];
		source?: MemorySource;
		scope?: MemoryScopeRef;
		confidence?: number;
		stability?: MemoryRecord['stability'];
		tags?: string[];
		metadata?: Record<string, unknown>;
		anchors?: MemoryAnchor[];
		outcomes?: MemoryOutcome[];
		/** #1466: audit reason stamped when this record supersedes another. */
		supersedesReason?: string;
	}): MemoryRecord {
		// PR #2310 feedback FB-3: ONE clock read for createdAt and expiresAt.
		// Two separate this.now() reads straddling a millisecond made the
		// scratch 7-day expiry check compute (now2 - now1) + 7d > 7d and
		// spuriously reject legitimate scratch proposals (and flaked the
		// write-boundary test at the same rate).
		const nowDate = this.now();
		const now = nowDate.toISOString();
		const text = normalizeMemoryText(input.text);
		const kind = input.kind;
		const stability =
			input.stability ?? (kind === 'scratch' ? 'ephemeral' : 'durable');
		// #1850 (H-002 fix): pass stability to resolveRecordScope so
		// ephemeral/session records default to a worktree-local scope (run/agent)
		// instead of the cohort scope. Only durable records default to cohort
		// when linked; scratch and session-scoped records stay worktree-local.
		const scope = this.resolveRecordScope(input.scope, stability);
		const expiresAt =
			kind === 'scratch'
				? new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
				: undefined;
		const recordBase = { scope, kind, text };
		const record: MemoryRecord = {
			id: createMemoryId(recordBase),
			scope,
			kind,
			text,
			tags: normalizeTags(input.tags ?? inferTags(text)),
			confidence: clamp(input.confidence ?? 0.5, 0, 1),
			stability,
			source:
				input.source ??
				sourceFromEvidence(input.evidenceRefs ?? [], this.context),
			createdAt: now,
			updatedAt: now,
			expiresAt,
			contentHash: computeMemoryContentHash(recordBase),
			metadata: input.metadata ?? {},
			anchors: input.anchors,
			outcomes: input.outcomes,
			// #1850: provenance (acceptance #13). Stamped on every record so
			// cohort members can attribute and verify redaction policy.
			cohortId: isCohortRoot(this.vettedRoot)
				? this.vettedRoot.cohortId
				: undefined,
			producerSessionId: this.context.sessionID,
			producerAgentRole: this.context.agentRole,
			redactionPolicyVersion: computeRedactionPolicyVersion({
				rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
				detectPii: this.config.redaction.detectPii,
				rejectDurablePii: this.config.redaction.rejectDurablePii,
				piiDetector: this.config.redaction.piiDetector,
			}),
			providerVersion: this.provider.name,
			// #1466 Phase 6 provenance. sourceTaskId comes from the unit-of-work
			// identity and is never defaulted to sessionID (MemoryContext.unitId
			// contract). validFrom records when this memory became authoritative.
			sourceTaskId: this.context.unitId,
			validFrom: now,
			supersedesReason: input.supersedesReason,
		};
		return record;
	}

	private resolveCuratorDecision(decision: CuratorMemoryDecision) {
		switch (decision.action) {
			case 'add':
				return {
					action: 'add' as const,
					proposalId: decision.proposalId,
					memory: this.createRecordFromNew(decision.memory),
				};
			case 'supersede':
				return {
					action: 'supersede' as const,
					proposalId: decision.proposalId,
					oldMemoryId: decision.oldMemoryId,
					replacement: this.createRecordFromNew(decision.replacement),
					reason: normalizeMemoryText(decision.reason),
				};
			case 'update': {
				const patch = normalizeMemoryPatch(decision.patch);
				if (patch.scope) {
					patch.scope = this.resolveRecordScope(patch.scope);
				}
				return {
					action: 'update' as const,
					proposalId: decision.proposalId,
					targetMemoryId: decision.targetMemoryId,
					patch,
					reason: normalizeMemoryText(decision.reason),
				};
			}
			case 'reject':
			case 'noop':
				return {
					action: decision.action,
					proposalId: decision.proposalId,
					reason: normalizeMemoryText(decision.reason),
				};
		}
	}

	private createRecordFromNew(input: NewMemoryRecord): MemoryRecord {
		const record = this.createRecord({
			kind: input.kind,
			text: input.text,
			scope: input.scope,
			tags: input.tags,
			confidence: input.confidence,
			stability: input.stability,
			source: input.source,
			metadata: input.metadata,
			anchors: input.anchors,
			outcomes: input.outcomes,
		});
		const next = input.expiresAt
			? { ...record, expiresAt: input.expiresAt }
			: record;
		return validateMemoryRecordRules(next, {
			rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
		});
	}

	private resolveRecordScope(
		scope?: MemoryScopeRef,
		stability?: MemoryRecord['stability'],
	): MemoryScopeRef {
		const allowedScopes = this.deriveAllowedScopes();
		if (!scope) {
			// #1850 (H-002 fix): when cohort sharing is active, default DURABLE
			// records to the cohort scope so they are shared across sibling
			// worktrees (acceptance #8). Ephemeral and session-stability
			// records stay worktree-local — they must NOT leak across the
			// cohort boundary. When not cohort-linked, fall back to the
			// repository scope (today's behavior).
			const wantsCohort = stability !== 'ephemeral' && stability !== 'session';
			const cohortScope = allowedScopes.find((s) => s.type === 'cohort');
			const defaultScope = wantsCohort
				? (cohortScope ?? allowedScopes[1] ?? allowedScopes[0])
				: (allowedScopes[1] ?? allowedScopes[0]);
			if (!defaultScope) {
				throw new MemoryValidationError(
					'memory scope is not available for this context',
				);
			}
			return defaultScope;
		}
		validateRequestedScopes(
			[scope],
			allowedScopes,
			'memory scope is not allowed for this context',
		);
		return scope;
	}

	private assertEnabled(): void {
		if (!this.config.enabled) throw new MemoryDisabledError();
	}
}

export function createMemoryGateway(
	context: MemoryContext,
	options: MemoryGatewayOptions = {},
): MemoryGateway {
	return new MemoryGateway(context, options);
}

export function createConfiguredMemoryProvider(
	directory: string,
	config: MemoryConfig,
): MemoryProvider & MemoryProposalStore {
	// #1850: resolve the vetted root so cohort sharing is honored. Callers
	// that pass a raw directory get today's behavior unless a memory-link
	// pointer is active AND config.link.enabled is true.
	const root = resolveVettedMemoryRoot(directory, config);
	return createConfiguredMemoryProviderForRoot(root, config);
}

/**
 * #1850: cohort-aware provider factory. Takes a resolved `VettedMemoryRoot` so
 * callers that have already resolved (e.g. the finalize-reward sweep) skip the
 * redundant pointer read. Both overloads converge here.
 */
export function createConfiguredMemoryProviderForRoot(
	root: VettedMemoryRoot,
	config: MemoryConfig,
): MemoryProvider & MemoryProposalStore {
	if (config.provider === 'sqlite') {
		return getOrCreateProviderForRoot(root, config);
	}
	const cohortRoot = root.kind === 'cohort' ? root.cohortRoot : null;
	return new LocalJsonlMemoryProvider(root.directory, config, cohortRoot);
}

function sourceFromEvidence(
	evidenceRefs: string[],
	context: MemoryContext,
): MemorySource {
	const first = evidenceRefs[0];
	if (!first) {
		return { type: 'agent', createdBy: context.agentId ?? context.agentRole };
	}
	if (/^https?:\/\//i.test(first)) return { type: 'web', url: first };
	if (/^[a-f0-9]{40}$/i.test(first))
		return { type: 'commit', commitSha: first };
	const filePaths = extractFilePaths(evidenceRefs);
	const filePath = filePaths[0] ?? first;
	if (
		filePath !== first &&
		(filePath.includes('/') ||
			filePath.includes('\\') ||
			filePath.includes('.'))
	) {
		return { type: 'file', filePath };
	}
	if (first.includes('/') || first.includes('\\') || first.includes('.')) {
		return { type: 'file', filePath: first };
	}
	return { type: 'manual', ref: first };
}

function createStableId(value: string): string {
	return createHash('sha256')
		.update(value.toLowerCase())
		.digest('hex')
		.slice(0, 16);
}

const gitRemoteUrlCache = new Map<string, string | undefined>();

function readGitRemoteUrl(directory: string): string | undefined {
	if (gitRemoteUrlCache.has(directory)) return gitRemoteUrlCache.get(directory);
	const gitConfigPath = path.join(directory, '.git', 'config');
	if (!existsSync(gitConfigPath)) {
		gitRemoteUrlCache.set(directory, undefined);
		return undefined;
	}
	try {
		const content = readFileSync(gitConfigPath, 'utf-8');
		const match = content.match(
			/\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)/,
		);
		const remoteUrl = match?.[1]?.trim();
		gitRemoteUrlCache.set(directory, remoteUrl);
		return remoteUrl;
	} catch {
		gitRemoteUrlCache.set(directory, undefined);
		return undefined;
	}
}

function validateRequestedScopes(
	requested: MemoryScopeRef[],
	allowed: MemoryScopeRef[],
	disallowedMessage = 'recall scope is not allowed for this context',
): MemoryScopeRef[] {
	if (requested.length === 0) {
		throw new MemoryValidationError('recall scopes must not be empty');
	}
	const allowedKeys = new Set(allowed.map(scopeKey));
	for (const scope of requested) {
		if (!allowedKeys.has(scopeKey(scope))) {
			throw new MemoryValidationError(disallowedMessage);
		}
	}
	return requested;
}

function resolveInjectionSkipReason(
	diagnostics: RecallScoringDiagnostics,
): RecallInjectionSkipReason | undefined {
	if (diagnostics.returnedCount > 0) return undefined;
	if (diagnostics.candidateCount === 0) return 'no_results';
	// Subtract suppressed-low-Q records: A.6 excludes them BEFORE the signal
	// check (they never reach `noSignalCount`) yet they remain in
	// `candidateCount`. Without this, `signalEligibleCount` is inflated and the
	// `no_signal` reason is under-reported for mixed suppressed+no-signal recalls.
	const signalEligibleCount =
		diagnostics.candidateCount -
		diagnostics.preScoredFilteredCount -
		diagnostics.suppressedLowQCount;
	if (
		signalEligibleCount > 0 &&
		diagnostics.noSignalCount > 0 &&
		diagnostics.noSignalCount >= signalEligibleCount
	) {
		return 'no_signal';
	}
	if (diagnostics.belowThresholdCount > 0) return 'below_threshold';
	return 'no_results';
}

function scopeKey(scope: MemoryScopeRef): string {
	return JSON.stringify({
		type: scope.type,
		userId: scope.userId,
		workspaceId: scope.workspaceId,
		projectId: scope.projectId,
		repoId: scope.repoId,
		repoRoot: scope.repoRoot ? path.resolve(scope.repoRoot) : undefined,
		runId: scope.runId,
		agentId: scope.agentId,
		// #1850 (H-001 fix): cohortId MUST be part of the scope-validation key,
		// otherwise validateRequestedScopes would accept a cross-cohort scope
		// (both stringify to {"type":"cohort"} and pass the gate). This must
		// stay in sync with the cohortId branch in stableScopeKey (schema.ts).
		cohortId: scope.cohortId,
	});
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
	return Math.trunc(clamp(value, min, max));
}

function normalizeTags(tags: string[]): string[] {
	return Array.from(
		new Set(
			tags
				.map((tag) =>
					tag
						.toLowerCase()
						.replace(/[^\w-]/g, '-')
						.replace(/-+/g, '-')
						.replace(/^-|-$/g, ''),
				)
				.filter(Boolean),
		),
	).slice(0, 32);
}

function normalizeMemoryPatch(patch: MemoryPatch): MemoryPatch {
	return {
		...patch,
		text:
			patch.text === undefined ? undefined : normalizeMemoryText(patch.text),
		tags: patch.tags === undefined ? undefined : normalizeTags(patch.tags),
	};
}

function inferTags(text: string): string[] {
	const lower = text.toLowerCase();
	const tags: string[] = [];
	for (const [tag, pattern] of [
		['testing', /\b(test|spec|bun|jest|vitest)\b/],
		['tooling', /\b(pnpm|npm|yarn|bun|biome|eslint|typescript)\b/],
		['security', /\b(security|auth|token|secret|password|csp)\b/],
		['api', /\b(api|endpoint|graphql|rest|sdk)\b/],
		['architecture', /\b(architecture|decision|adr|pattern)\b/],
		['failure', /\b(fail|failure|regression|flaky|timeout)\b/],
	] as const) {
		if (pattern.test(lower)) tags.push(tag);
	}
	return tags;
}

const FILE_PATH_REGEX =
	/\b(?:src|tests|test|docs|scripts|packages|lib|config|examples|internal|cmd|pkg|bin|tools|cli|api|server|client|app|core|utils|hooks|services|commands|agents|memory)\/[A-Za-z0-9._/@+-]+/g;

const RESERVED_IDENTIFIERS = new Set([
	'const',
	'let',
	'var',
	'function',
	'class',
	'interface',
	'type',
	'async',
	'await',
	'return',
	'if',
	'else',
	'for',
	'while',
	'do',
	'switch',
	'case',
	'break',
	'continue',
	'new',
	'this',
	'super',
	'extends',
	'implements',
	'import',
	'export',
	'from',
	'default',
	'try',
	'catch',
	'finally',
	'throw',
	'typeof',
	'instanceof',
	'in',
	'of',
	'as',
	'yield',
	'static',
	'get',
	'set',
	'readonly',
	'public',
	'private',
	'protected',
]);

/**
 * Extract file paths from evidence refs using the same directory-prefix
 * regex as injector.ts:extractTouchedFiles, deduped and capped at 20.
 */
function extractFilePaths(refs: string[]): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const ref of refs) {
		// Re-invoke the regex with the global flag reset per ref
		FILE_PATH_REGEX.lastIndex = 0;
		const matches = ref.match(FILE_PATH_REGEX);
		if (!matches) continue;
		for (const m of matches) {
			if (!seen.has(m)) {
				seen.add(m);
				paths.push(m);
				if (paths.length >= 20) return paths;
			}
		}
	}
	return paths;
}

/**
 * Extract identifier-like tokens from evidence refs using a camelCase/dotted
 * heuristic, filtering reserved words. Tokens are broadly matched — any
 * valid identifier of 3+ characters — to maximize recall signal coverage.
 * False positives (variable names, common words) are acceptable given the
 * low scoring weight (0.08) and dedup/cap at 20 entries.
 */
function extractSymbols(refs: string[]): string[] {
	const seen = new Set<string>();
	const symbols: string[] = [];
	const identRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*\b/g;
	for (const ref of refs) {
		identRegex.lastIndex = 0;
		const matches = ref.match(identRegex);
		if (!matches) continue;
		for (const m of matches) {
			if (m.length >= 3 && !seen.has(m) && !RESERVED_IDENTIFIERS.has(m)) {
				seen.add(m);
				symbols.push(m);
				if (symbols.length >= 20) return symbols;
			}
		}
	}
	return symbols;
}
