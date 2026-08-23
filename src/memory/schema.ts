import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DURABLE_MEMORY_KINDS, EVIDENCE_REQUIRED_KINDS } from './config';
import { MemoryValidationError } from './errors';
import { computePiiScore, type PiiFinding, summarizePiiFindings } from './pii';
import { containsSecret } from './redaction';
import { MEMORY_RECALL_SENTINEL } from './sentinel';
import type {
	CuratorMemoryDecision,
	MemoryAnchor,
	MemoryKind,
	MemoryOutcome,
	MemoryPatch,
	MemoryProposal,
	MemoryRecord,
	MemoryScopeRef,
	NewMemoryRecord,
} from './types';

export const MAX_MEMORY_TEXT_LENGTH = 2000;
export const MAX_MEMORY_ANCHORS = 20;
export const MEMORY_OUTCOME_QUESTION_PREFIX = 'Outcome evidence for question: ';
export const MAX_OUTCOME_QUESTION_LENGTH =
	MAX_MEMORY_TEXT_LENGTH - MEMORY_OUTCOME_QUESTION_PREFIX.length;

export const MemoryScopeTypeSchema = z.enum([
	'global_user',
	'workspace',
	'project',
	'repository',
	'run',
	'agent',
	// #1850: cohort-scoped shared memory.
	'cohort',
]);

export const MemoryScopeRefSchema = z
	.object({
		type: MemoryScopeTypeSchema,
		userId: z.string().optional(),
		workspaceId: z.string().optional(),
		projectId: z.string().optional(),
		repoId: z.string().optional(),
		repoRoot: z.string().optional(),
		runId: z.string().optional(),
		agentId: z.string().optional(),
		// #1850: required to key cohort scopes so different cohorts do not
		// collapse to one stable scope key (critic GAP-1/GAP-2).
		cohortId: z.string().optional(),
	})
	.strict();

export const MemoryKindSchema = z.enum([
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
]);

export const MemorySourceSchema = z
	.object({
		type: z.enum([
			'user',
			'agent',
			'tool',
			'file',
			'repo',
			'commit',
			'test',
			'web',
			'manual',
		]),
		ref: z.string().optional(),
		url: z.string().optional(),
		filePath: z.string().optional(),
		commitSha: z.string().optional(),
		createdBy: z.string().optional(),
	})
	.strict();

const MemoryAnchorFileSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.transform((value, context) => {
		try {
			return normalizeMemoryAnchorFile(value);
		} catch (error) {
			context.addIssue({
				code: 'custom',
				message:
					error instanceof Error ? error.message : 'invalid memory anchor path',
			});
			return z.NEVER;
		}
	});

export const MemoryAnchorSchema: z.ZodType<MemoryAnchor> = z
	.object({
		file: MemoryAnchorFileSchema,
		symbol: z.string().trim().min(1).max(256).optional(),
	})
	.strict();

/** Normalize a repository-relative memory anchor to a portable identity. */
export function normalizeMemoryAnchorFile(value: string): string {
	const trimmed = value.trim();
	if (
		[...trimmed].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127;
		})
	) {
		throw new MemoryValidationError(
			'memory anchor file must not contain control characters',
		);
	}
	if (
		trimmed.startsWith('/') ||
		trimmed.startsWith('\\') ||
		/^[a-zA-Z]:[\\/]/.test(trimmed)
	) {
		throw new MemoryValidationError(
			'memory anchor file must be repository-relative',
		);
	}
	const segments = trimmed.replaceAll('\\', '/').split('/');
	if (segments.some((segment) => segment === '..')) {
		throw new MemoryValidationError(
			'memory anchor file must not traverse outside the repository',
		);
	}
	const normalized = segments
		.filter((segment) => segment.length > 0 && segment !== '.')
		.join('/');
	if (!normalized) {
		throw new MemoryValidationError('memory anchor file must not be empty');
	}
	return normalized;
}

export const MemoryOutcomeSchema: z.ZodType<MemoryOutcome> = z
	.object({
		outcome: z.enum(['useful', 'dead_end', 'corrected']),
		at: z.string().datetime(),
		taskId: z.string().trim().min(1).max(256).optional(),
		correction: z.string().trim().min(1).max(4000).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.outcome === 'corrected' && !value.correction) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['correction'],
				message: 'corrected outcomes require correction text',
			});
		}
		if (value.outcome !== 'corrected' && value.correction !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['correction'],
				message: 'correction text is only valid for corrected outcomes',
			});
		}
	});

export const MemoryRecordSchema = z
	.object({
		id: z.string().regex(/^mem_[a-f0-9]{16}$/),
		scope: MemoryScopeRefSchema,
		kind: MemoryKindSchema,
		text: z.string().min(1).max(MAX_MEMORY_TEXT_LENGTH),
		tags: z.array(z.string().min(1).max(64)).max(32),
		confidence: z.number().min(0).max(1),
		stability: z.enum(['ephemeral', 'session', 'durable']),
		source: MemorySourceSchema,
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		lastAccessedAt: z.string().datetime().optional(),
		expiresAt: z.string().datetime().optional(),
		qValue: z.number().min(0).max(1).optional(),
		supersedes: z.array(z.string()).optional(),
		supersededBy: z.string().optional(),
		contentHash: z.string().regex(/^[a-f0-9]{64}$/),
		metadata: z.record(z.string(), z.unknown()),
		anchors: z.array(MemoryAnchorSchema).max(MAX_MEMORY_ANCHORS).optional(),
		outcomes: z.array(MemoryOutcomeSchema).max(1000).optional(),
		// #1850 cohort-sharing provenance (all optional for back-compat).
		cohortId: z.string().optional(),
		producerSessionId: z.string().optional(),
		producerAgentRole: z.string().optional(),
		redactionPolicyVersion: z.number().int().min(0).optional(),
		schemaVersion: z.number().int().min(0).optional(),
		providerVersion: z.string().optional(),
		sourceRevision: z.string().optional(),
		// #1466 Phase 6 provenance (all optional for back-compat; contentHash
		// derives from {scope,kind,text} only, so these never affect id/hash).
		sourceTaskId: z.string().optional(),
		embeddingModelVersion: z.string().optional(),
		validFrom: z.string().datetime().optional(),
		supersedesReason: z.string().optional(),
	})
	.strict();

export const MemoryProposalSchema = z
	.object({
		id: z.string().regex(/^prop_[a-f0-9]{16}$/),
		operation: z.enum([
			'add',
			'update',
			'delete',
			'ignore',
			'merge',
			'supersede',
		]),
		proposedRecord: MemoryRecordSchema.optional(),
		targetMemoryId: z.string().optional(),
		relatedMemoryIds: z.array(z.string()).optional(),
		proposedBy: z
			.object({
				agentRole: z.string().optional(),
				agentId: z.string().optional(),
				runId: z.string().optional(),
			})
			.strict(),
		rationale: z.string().min(1).max(2000),
		evidenceRefs: z.array(z.string().min(1).max(500)).max(20),
		status: z.enum([
			'pending',
			'approved',
			'rejected',
			'superseded',
			'applied',
		]),
		reviewer: z
			.enum(['user', 'controller', 'curator_agent', 'auto_policy'])
			.optional(),
		reviewedAt: z.string().datetime().optional(),
		rejectionReason: z.string().optional(),
		createdAt: z.string().datetime(),
		metadata: z.record(z.string(), z.unknown()),
	})
	.strict();

export const NewMemoryRecordSchema: z.ZodType<NewMemoryRecord> = z
	.object({
		scope: MemoryScopeRefSchema.optional(),
		kind: MemoryKindSchema,
		text: z.string().min(1).max(MAX_MEMORY_TEXT_LENGTH),
		tags: z.array(z.string().min(1).max(64)).max(32).optional(),
		confidence: z.number().min(0).max(1).optional(),
		stability: z.enum(['ephemeral', 'session', 'durable']).optional(),
		source: MemorySourceSchema.optional(),
		expiresAt: z.string().datetime().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		anchors: z.array(MemoryAnchorSchema).max(MAX_MEMORY_ANCHORS).optional(),
		outcomes: z.array(MemoryOutcomeSchema).max(1000).optional(),
	})
	.strict();

export const MemoryPatchSchema: z.ZodType<MemoryPatch> = z
	.object({
		scope: MemoryScopeRefSchema.optional(),
		kind: MemoryKindSchema.optional(),
		text: z.string().min(1).max(MAX_MEMORY_TEXT_LENGTH).optional(),
		tags: z.array(z.string().min(1).max(64)).max(32).optional(),
		confidence: z.number().min(0).max(1).optional(),
		stability: z.enum(['ephemeral', 'session', 'durable']).optional(),
		source: MemorySourceSchema.optional(),
		expiresAt: z.string().datetime().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		anchors: z.array(MemoryAnchorSchema).max(MAX_MEMORY_ANCHORS).optional(),
		outcomes: z.array(MemoryOutcomeSchema).max(1000).optional(),
	})
	.strict()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: 'memory patch must not be empty',
	});

const ProposalIdSchema = z.string().regex(/^prop_[a-f0-9]{16}$/);
const MemoryIdSchema = z.string().regex(/^mem_[a-f0-9]{16}$/);
const CuratorDecisionReasonSchema = z.string().min(1).max(2000);

export const CuratorMemoryDecisionSchema: z.ZodType<CuratorMemoryDecision> =
	z.discriminatedUnion('action', [
		z
			.object({
				action: z.literal('add'),
				proposalId: ProposalIdSchema,
				memory: NewMemoryRecordSchema,
			})
			.strict(),
		z
			.object({
				action: z.literal('update'),
				proposalId: ProposalIdSchema,
				targetMemoryId: MemoryIdSchema,
				patch: MemoryPatchSchema,
				reason: CuratorDecisionReasonSchema,
			})
			.strict(),
		z
			.object({
				action: z.literal('supersede'),
				proposalId: ProposalIdSchema,
				oldMemoryId: MemoryIdSchema,
				replacement: NewMemoryRecordSchema,
				reason: CuratorDecisionReasonSchema,
			})
			.strict(),
		z
			.object({
				action: z.literal('reject'),
				proposalId: ProposalIdSchema,
				reason: CuratorDecisionReasonSchema,
			})
			.strict(),
		z
			.object({
				action: z.literal('noop'),
				proposalId: ProposalIdSchema,
				reason: CuratorDecisionReasonSchema,
			})
			.strict(),
	]);

export function normalizeMemoryText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

export function stableScopeKey(scope: MemoryScopeRef): string {
	const ordered: Record<string, string> = { type: scope.type };
	// #1850 (critic GAP-1): cohort scopes MUST key on cohortId, otherwise every
	// cohort collapses to `{"type":"cohort"}` and recall returns records from
	// unrelated cohorts. The branch is a single-key extraction like `repository`.
	const keys =
		scope.type === 'repository'
			? (['repoId'] as const)
			: scope.type === 'cohort'
				? (['cohortId'] as const)
				: ([
						'userId',
						'workspaceId',
						'projectId',
						'repoId',
						'repoRoot',
						'runId',
						'agentId',
					] as const);
	for (const key of keys) {
		const value = scope[key];
		if (value) ordered[key] = value;
	}
	return JSON.stringify(ordered);
}

export function computeMemoryContentHash(recordLike: {
	scope: MemoryScopeRef;
	kind: MemoryKind;
	text: string;
}): string {
	const normalized = normalizeMemoryText(recordLike.text).toLowerCase();
	return createHash('sha256')
		.update(
			`${stableScopeKey(recordLike.scope)}\n${recordLike.kind}\n${normalized}`,
		)
		.digest('hex');
}

export function createMemoryId(recordLike: {
	scope: MemoryScopeRef;
	kind: MemoryKind;
	text: string;
}): string {
	return `mem_${computeMemoryContentHash(recordLike).slice(0, 16)}`;
}

export function createProposalId(input: {
	createdAt: string;
	proposer: string;
	text: string;
}): string {
	const hash = createHash('sha256')
		.update(
			`${input.createdAt}\n${input.proposer}\n${normalizeMemoryText(input.text)}`,
		)
		.digest('hex');
	return `prop_${hash.slice(0, 16)}`;
}

export function createBundleId(query: string, generatedAt: string): string {
	const compactTimestamp = generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
	const hash = createHash('sha256')
		.update(`${generatedAt}\n${query}`)
		.digest('hex')
		.slice(0, 8);
	return `bundle_${compactTimestamp}_${hash}`;
}

export function isExpired(record: MemoryRecord, now = new Date()): boolean {
	if (!record.expiresAt) return false;
	const expires = Date.parse(record.expiresAt);
	return Number.isFinite(expires) && expires <= now.getTime();
}

export function hasEvidenceSource(record: MemoryRecord): boolean {
	return Boolean(
		record.source.url ||
			record.source.filePath ||
			record.source.commitSha ||
			record.source.ref,
	);
}

export function validateMemoryRecordRules(
	record: MemoryRecord,
	options: {
		rejectDurableSecrets: boolean;
		/**
		 * #1466: precomputed PII findings for the record text. The DETECTOR is
		 * async (NER), so callers run it and pass results in; this function
		 * owns the threshold decision so it stays the single enforcement point.
		 * Absent findings = no enforcement (JSONL import, maintenance paths).
		 */
		piiFindings?: PiiFinding[];
		rejectDurablePii?: boolean;
		piiThreshold?: number;
	},
): MemoryRecord {
	const parsed = MemoryRecordSchema.parse(record);
	// DD-14: stored memory text must never contain the recall-injection sentinel
	// header. `messagesContainRecall` (injector.ts) trusts that substring to
	// detect an already-injected block; a memory embedding it would, once
	// injected, cause later recall to be silently skipped. Reject at write time
	// — this is the single choke point for every write path (propose, upsert,
	// curator add/supersede all funnel through here).
	if (parsed.text.includes(MEMORY_RECALL_SENTINEL)) {
		throw new MemoryValidationError(
			'memory text cannot contain the recall sentinel header',
		);
	}
	// #1466 DD-14 (bundle anchor): detection also trusts the `bundle_` marker
	// emitted by `createBundleId`, so memory text must never contain the
	// literal prefix — otherwise a stored memory could forge "recall already
	// injected" and suppress its own recall.
	if (parsed.text.includes('bundle_')) {
		throw new MemoryValidationError(
			'memory text cannot contain the recall bundle marker prefix',
		);
	}
	const expectedHash = computeMemoryContentHash(parsed);
	const expectedId = createMemoryId(parsed);
	if (parsed.contentHash !== expectedHash) {
		throw new MemoryValidationError(
			'contentHash does not match memory content',
		);
	}
	if (parsed.id !== expectedId) {
		throw new MemoryValidationError('id does not match memory content');
	}
	if (
		parsed.stability === 'durable' &&
		(parsed.scope.type === 'run' || parsed.scope.type === 'agent')
	) {
		throw new MemoryValidationError(
			'durable memories cannot use run or agent scope',
		);
	}
	if (
		parsed.stability === 'durable' &&
		(DURABLE_MEMORY_KINDS.has(parsed.kind) ||
			parsed.kind === 'api_finding' ||
			parsed.kind === 'evidence') &&
		!hasEvidenceSource(parsed)
	) {
		throw new MemoryValidationError(
			'durable project, repository, API, evidence, and security memories require source evidence',
		);
	}
	if (EVIDENCE_REQUIRED_KINDS.has(parsed.kind) && !hasEvidenceSource(parsed)) {
		throw new MemoryValidationError(
			`${parsed.kind} memories require source evidence`,
		);
	}
	if (
		parsed.kind === 'scratch' &&
		(!parsed.expiresAt ||
			Date.parse(parsed.expiresAt) - Date.parse(parsed.createdAt) >
				7 * 24 * 60 * 60 * 1000)
	) {
		throw new MemoryValidationError(
			'scratch memories must expire within 7 days',
		);
	}
	if (
		options.rejectDurableSecrets &&
		parsed.stability === 'durable' &&
		(containsSecret(parsed.text) ||
			(parsed.outcomes ?? []).some(
				(outcome) =>
					typeof outcome.correction === 'string' &&
					containsSecret(outcome.correction),
			))
	) {
		throw new MemoryValidationError('durable memory contains a likely secret');
	}
	// #1466: PII rejection at the single write funnel. Score = max finding
	// confidence; rejection fires when the score EXCEEDS the threshold.
	if (
		options.rejectDurablePii &&
		parsed.stability === 'durable' &&
		options.piiFindings !== undefined
	) {
		const score = computePiiScore(options.piiFindings);
		if (score > (options.piiThreshold ?? 0.7)) {
			const summary = summarizePiiFindings(options.piiFindings);
			throw new MemoryValidationError(
				`durable memory exceeds the PII threshold: score ${score.toFixed(2)} (types: ${
					Object.entries(summary.countsByType)
						.map(([t, n]) => `${t}x${n}`)
						.join(', ') || 'none'
				}) exceeded threshold ${(options.piiThreshold ?? 0.7).toFixed(2)}`,
				'memory_pii_rejected',
			);
		}
	}
	const eventIds = parsed.metadata.outcomeEventIds;
	if (eventIds !== undefined) {
		if (
			!Array.isArray(eventIds) ||
			eventIds.length !== (parsed.outcomes?.length ?? 0) ||
			eventIds.some(
				(id) => typeof id !== 'string' || id.length < 1 || id.length > 256,
			)
		) {
			throw new MemoryValidationError(
				'metadata.outcomeEventIds must align with outcomes',
			);
		}
	}
	const generation = parsed.metadata.outcomeGeneration;
	if (
		generation !== undefined &&
		(typeof generation !== 'string' ||
			generation.length < 1 ||
			generation.length > 256)
	) {
		throw new MemoryValidationError(
			'metadata.outcomeGeneration must be a bounded string',
		);
	}
	return parsed;
}

export function validateMemoryProposal(
	proposal: MemoryProposal,
): MemoryProposal {
	return MemoryProposalSchema.parse(proposal);
}

export function validateCuratorMemoryDecision(
	decision: unknown,
): CuratorMemoryDecision {
	return CuratorMemoryDecisionSchema.parse(decision);
}
