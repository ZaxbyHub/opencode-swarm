import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	DEFAULT_MEMORY_CONFIG,
	type MemoryConfig,
	resolveMemoryConfig,
} from './config';
import { MemoryDisabledError, MemoryValidationError } from './errors';
import { LocalJsonlMemoryProvider } from './local-jsonl-provider';
import { toRecallBundle } from './prompt-block';
import type { MemoryProposalStore, MemoryProvider } from './provider';
import { redactSecrets } from './redaction';
import {
	computeMemoryContentHash,
	createBundleId,
	createMemoryId,
	createProposalId,
	normalizeMemoryText,
	validateMemoryRecordRules,
} from './schema';
import type {
	MemoryContext,
	MemoryKind,
	MemoryProposal,
	MemoryRecord,
	MemoryScopeRef,
	MemorySource,
	RecallBundle,
	RecallRequest,
} from './types';

export interface MemoryGatewayOptions {
	config?: Partial<MemoryConfig>;
	provider?: MemoryProvider & Partial<MemoryProposalStore>;
	now?: () => Date;
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
	scopes?: MemoryScopeRef[];
	kinds?: MemoryKind[];
	maxItems?: number;
	tokenBudget?: number;
	minScore?: number;
	includeExpired?: boolean;
}

export class MemoryGateway {
	private readonly config: MemoryConfig;
	private readonly provider: MemoryProvider & Partial<MemoryProposalStore>;
	private readonly now: () => Date;

	constructor(
		private readonly context: MemoryContext,
		options: MemoryGatewayOptions = {},
	) {
		this.config = resolveMemoryConfig(options.config ?? DEFAULT_MEMORY_CONFIG);
		this.provider =
			options.provider ??
			new LocalJsonlMemoryProvider(context.directory, this.config);
		this.now = options.now ?? (() => new Date());
	}

	isEnabled(): boolean {
		return this.config.enabled;
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
			scopes,
			kinds: input.kinds,
			maxItems,
			tokenBudget,
			minScore: input.minScore ?? this.config.recall.minScore,
			includeExpired: input.includeExpired,
		};
		const results = await this.provider.recall(request);
		const bundle = toRecallBundle({
			id: createBundleId(query, generatedAt),
			query,
			generatedAt,
			items: results,
			tokenBudget,
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
			proposedRecord = this.createRecord({
				kind: input.kind,
				text: redactedText,
				evidenceRefs,
				source: sourceFromEvidence(evidenceRefs, this.context),
			});
			validateMemoryRecordRules(proposedRecord, {
				rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
			});
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
			metadata: {},
		};
		return this.provider.createProposal(proposal);
	}

	async upsertCurated(record: MemoryRecord): Promise<MemoryRecord> {
		this.assertEnabled();
		const parsed = validateMemoryRecordRules(record, {
			rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
		});
		return this.provider.upsert(parsed);
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
	}): MemoryRecord {
		const now = this.now().toISOString();
		const text = normalizeMemoryText(input.text);
		const scope = input.scope ?? this.deriveAllowedScopes()[1];
		const kind = input.kind;
		const stability =
			input.stability ?? (kind === 'scratch' ? 'ephemeral' : 'durable');
		const expiresAt =
			kind === 'scratch'
				? new Date(this.now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
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
		};
		return record;
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
): MemoryScopeRef[] {
	if (requested.length === 0) {
		throw new MemoryValidationError('recall scopes must not be empty');
	}
	const allowedKeys = new Set(allowed.map(scopeKey));
	for (const scope of requested) {
		if (!allowedKeys.has(scopeKey(scope))) {
			throw new MemoryValidationError(
				'recall scope is not allowed for this context',
			);
		}
	}
	return requested;
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
