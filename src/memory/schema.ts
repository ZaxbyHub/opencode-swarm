import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DURABLE_MEMORY_KINDS, EVIDENCE_REQUIRED_KINDS } from './config';
import { MemoryValidationError } from './errors';
import { containsSecret } from './redaction';
import type {
	MemoryKind,
	MemoryProposal,
	MemoryRecord,
	MemoryScopeRef,
} from './types';

export const MemoryScopeTypeSchema = z.enum([
	'global_user',
	'workspace',
	'project',
	'repository',
	'run',
	'agent',
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

export const MemoryRecordSchema = z
	.object({
		id: z.string().regex(/^mem_[a-f0-9]{16}$/),
		scope: MemoryScopeRefSchema,
		kind: MemoryKindSchema,
		text: z.string().min(1).max(2000),
		tags: z.array(z.string().min(1).max(64)).max(32),
		confidence: z.number().min(0).max(1),
		stability: z.enum(['ephemeral', 'session', 'durable']),
		source: MemorySourceSchema,
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		lastAccessedAt: z.string().datetime().optional(),
		expiresAt: z.string().datetime().optional(),
		supersedes: z.array(z.string()).optional(),
		supersededBy: z.string().optional(),
		contentHash: z.string().regex(/^[a-f0-9]{64}$/),
		metadata: z.record(z.string(), z.unknown()),
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

export function normalizeMemoryText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

export function stableScopeKey(scope: MemoryScopeRef): string {
	const ordered: Record<string, string> = { type: scope.type };
	const keys =
		scope.type === 'repository'
			? (['repoId'] as const)
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
	options: { rejectDurableSecrets: boolean },
): MemoryRecord {
	const parsed = MemoryRecordSchema.parse(record);
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
		containsSecret(parsed.text)
	) {
		throw new MemoryValidationError('durable memory contains a likely secret');
	}
	return parsed;
}

export function validateMemoryProposal(
	proposal: MemoryProposal,
): MemoryProposal {
	return MemoryProposalSchema.parse(proposal);
}
