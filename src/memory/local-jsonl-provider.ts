import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config';
import {
	applyPatchToMemory,
	buildCuratorDecisionEvent,
	curatorDecisionReason,
	markProposalReviewed,
	validateCuratorPromotableMemory,
	validateDecisionMatchesProposal,
} from './curator-decision-helpers';
import { MemoryValidationError } from './errors';
import { shouldCompactMemory } from './maintenance';
import type {
	MemoryCompactOptions,
	MemoryCompactResult,
	MemoryProposalStore,
	MemoryProvider,
	MemoryRecallUsageEvent,
	MemoryRecallUsageFilter,
} from './provider';
import { validateMemoryProposal, validateMemoryRecordRules } from './schema';
import type { RecallScoringDiagnostics } from './scoring';
import { scopeAllowed, scoreMemoryRecordsWithDiagnostics } from './scoring';
import type {
	AppliedMemoryChange,
	MemoryListFilter,
	MemoryProposal,
	MemoryRecord,
	RecallRequest,
	RecallResultItem,
	ResolvedCuratorMemoryDecision,
} from './types';

type AuditOperation =
	| 'upsert'
	| 'delete'
	| 'proposal'
	| 'recall'
	| 'curator_decision'
	| 'compact'
	| 'invalid_load';

interface AuditEvent {
	id: string;
	operation: AuditOperation;
	targetId: string;
	reason?: string;
	eventJson?: unknown;
	timestamp: string;
}

export class LocalJsonlMemoryProvider
	implements MemoryProvider, MemoryProposalStore
{
	readonly name = 'local-jsonl';
	private readonly rootDirectory: string;
	private readonly config: MemoryConfig;
	private initialized = false;
	private memories = new Map<string, MemoryRecord>();
	private proposals = new Map<string, MemoryProposal>();

	constructor(rootDirectory: string, config: Partial<MemoryConfig> = {}) {
		this.rootDirectory = rootDirectory;
		this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
	}

	private pathFor(file: 'memories' | 'proposals' | 'audit'): string {
		const storageDir = this.config.storageDir.replace(/^\.swarm[/\\]?/, '');
		const filename =
			file === 'memories'
				? 'memories.jsonl'
				: file === 'proposals'
					? 'proposals.jsonl'
					: 'audit.jsonl';
		return validateSwarmPath(
			this.rootDirectory,
			path.join(storageDir, filename),
		);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		const memoryPath = this.pathFor('memories');
		const proposalPath = this.pathFor('proposals');
		const memoryLoad = validateLoadedMemories(
			await readJsonl(memoryPath),
			this.config,
		);
		const proposalLoad = validateLoadedProposals(
			await readJsonl(proposalPath),
			this.config,
		);
		this.memories = new Map(
			memoryLoad.records.map((record) => [record.id, record]),
		);
		this.proposals = new Map(
			proposalLoad.records.map((proposal) => [proposal.id, proposal]),
		);
		this.initialized = true;
		if (memoryLoad.invalidCount > 0) {
			await this.audit(
				'invalid_load',
				'memories',
				`${memoryLoad.invalidCount} invalid memory JSONL row(s) skipped`,
			);
		}
		if (proposalLoad.invalidCount > 0) {
			await this.audit(
				'invalid_load',
				'proposals',
				`${proposalLoad.invalidCount} invalid proposal JSONL row(s) skipped`,
			);
		}
	}

	async upsert(record: MemoryRecord): Promise<MemoryRecord> {
		await this.initialize();
		const existing = this.memories.get(record.id);
		if (existing?.metadata.deleted === true) {
			throw new MemoryValidationError(
				'memory is tombstoned and cannot be upserted',
			);
		}
		const next = validateMemoryRecordRules(
			{
				...record,
				createdAt: existing?.createdAt ?? record.createdAt,
			},
			{ rejectDurableSecrets: this.config.redaction.rejectDurableSecrets },
		);
		this.memories.set(next.id, next);
		await appendJsonl(this.pathFor('memories'), next);
		await this.audit('upsert', next.id);
		return next;
	}

	async get(id: string): Promise<MemoryRecord | null> {
		await this.initialize();
		return this.memories.get(id) ?? null;
	}

	async delete(id: string, reason?: string): Promise<void> {
		await this.initialize();
		const existing = this.memories.get(id);
		if (!existing) return;
		if (this.config.hardDelete) {
			this.memories.delete(id);
			await this.compact();
		} else {
			const tombstone: MemoryRecord = {
				...existing,
				updatedAt: new Date().toISOString(),
				metadata: { ...existing.metadata, deleted: true, deleteReason: reason },
			};
			this.memories.set(id, tombstone);
			await appendJsonl(this.pathFor('memories'), tombstone);
		}
		await this.audit('delete', id, reason);
	}

	async recall(request: RecallRequest): Promise<RecallResultItem[]> {
		return (await this.recallWithDiagnostics(request)).items;
	}

	async recallWithDiagnostics(request: RecallRequest): Promise<{
		items: RecallResultItem[];
		diagnostics: RecallScoringDiagnostics;
	}> {
		await this.initialize();
		const records = await this.list({
			scopes: request.scopes,
			kinds: request.kinds,
			includeExpired: request.includeExpired,
		});
		const result = scoreMemoryRecordsWithDiagnostics(records, request);
		return {
			items: result.items.slice(0, request.maxItems),
			diagnostics: {
				...result.diagnostics,
				returnedCount: Math.min(
					result.diagnostics.returnedCount,
					request.maxItems,
				),
			},
		};
	}

	async recordRecallUsage(event: MemoryRecallUsageEvent): Promise<void> {
		await this.initialize();
		await this.audit('recall', event.bundleId, undefined, event);
	}

	async listRecallUsage(
		filter: MemoryRecallUsageFilter = {},
	): Promise<MemoryRecallUsageEvent[]> {
		await this.initialize();
		const events = await readAuditEvents(this.pathFor('audit'));
		const usage: MemoryRecallUsageEvent[] = [];
		for (const event of events) {
			if (event.operation !== 'recall') continue;
			const parsed = parseRecallUsageEvent(event);
			if (parsed) usage.push(parsed);
		}
		usage.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		return usage.slice(0, filter.limit ?? usage.length);
	}

	async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
		await this.initialize();
		let records = Array.from(this.memories.values());
		if (filter.scopes && filter.scopes.length > 0) {
			records = records.filter((record) =>
				scopeAllowed(record.scope, filter.scopes ?? []),
			);
		}
		if (filter.kinds && filter.kinds.length > 0) {
			records = records.filter((record) => filter.kinds?.includes(record.kind));
		}
		if (!filter.includeExpired) {
			const now = Date.now();
			records = records.filter((record) => {
				if (!record.expiresAt) return true;
				const expires = Date.parse(record.expiresAt);
				return !Number.isFinite(expires) || expires > now;
			});
		}
		if (!filter.includeInactive) {
			records = records.filter(
				(record) => !record.supersededBy && record.metadata.deleted !== true,
			);
		}
		records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return records.slice(0, filter.limit ?? records.length);
	}

	async createProposal(proposal: MemoryProposal): Promise<MemoryProposal> {
		await this.initialize();
		const next = validateMemoryProposal(proposal);
		this.proposals.set(next.id, next);
		await appendJsonl(this.pathFor('proposals'), next);
		await this.audit('proposal', next.id);
		return next;
	}

	async listProposals(
		filter: { status?: MemoryProposal['status']; limit?: number } = {},
	): Promise<MemoryProposal[]> {
		await this.initialize();
		let proposals = Array.from(this.proposals.values());
		if (filter.status) {
			proposals = proposals.filter(
				(proposal) => proposal.status === filter.status,
			);
		}
		proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return proposals.slice(0, filter.limit ?? proposals.length);
	}

	async applyCuratorDecision(
		decision: ResolvedCuratorMemoryDecision,
	): Promise<AppliedMemoryChange> {
		await this.initialize();
		const appliedAt = new Date().toISOString();
		const proposal = this.proposals.get(decision.proposalId);
		if (!proposal) {
			throw new MemoryValidationError('memory proposal was not found');
		}
		if (proposal.status !== 'pending') {
			throw new MemoryValidationError('memory proposal is not pending');
		}
		validateDecisionMatchesProposal(decision, proposal);

		let memoryId: string | undefined;
		let targetMemoryId: string | undefined;
		let oldMemoryId: string | undefined;
		let replacementMemoryId: string | undefined;

		if (decision.action === 'add') {
			const memory = this.validateDecisionMemory({
				...decision.memory,
				updatedAt: appliedAt,
			});
			validateCuratorPromotableMemory(memory);
			this.memories.set(memory.id, memory);
			await appendJsonl(this.pathFor('memories'), memory);
			memoryId = memory.id;
		} else if (decision.action === 'update') {
			const existing = this.activeMemory(decision.targetMemoryId);
			const updated = this.validateDecisionMemory(
				applyPatchToMemory(existing, decision.patch, appliedAt),
			);
			validateCuratorPromotableMemory(updated);
			if (updated.id !== existing.id) {
				// Update replacements are linked through updateReplacementId; the
				// supersedes graph is reserved for explicit supersede decisions.
				const tombstone = this.validateDecisionMemory({
					...existing,
					updatedAt: appliedAt,
					metadata: {
						...existing.metadata,
						deleted: true,
						deleteReason: decision.reason,
						updateReplacementId: updated.id,
					},
				});
				this.memories.set(tombstone.id, tombstone);
				await appendJsonl(this.pathFor('memories'), tombstone);
			}
			this.memories.set(updated.id, updated);
			await appendJsonl(this.pathFor('memories'), updated);
			memoryId = updated.id;
			targetMemoryId = existing.id;
		} else if (decision.action === 'supersede') {
			const oldMemory = this.activeMemory(decision.oldMemoryId);
			const replacement = this.validateDecisionMemory({
				...decision.replacement,
				updatedAt: appliedAt,
				supersedes: Array.from(
					new Set([...(decision.replacement.supersedes ?? []), oldMemory.id]),
				),
			});
			validateCuratorPromotableMemory(replacement);
			const superseded = this.validateDecisionMemory({
				...oldMemory,
				updatedAt: appliedAt,
				supersededBy: replacement.id,
				metadata: {
					...oldMemory.metadata,
					supersedeReason: decision.reason,
				},
			});
			this.memories.set(superseded.id, superseded);
			this.memories.set(replacement.id, replacement);
			await appendJsonl(this.pathFor('memories'), superseded);
			await appendJsonl(this.pathFor('memories'), replacement);
			oldMemoryId = oldMemory.id;
			replacementMemoryId = replacement.id;
			memoryId = replacement.id;
		}

		const proposalStatus =
			decision.action === 'reject' ? 'rejected' : 'applied';
		const reviewedProposal = markProposalReviewed(
			proposal,
			decision,
			proposalStatus,
			appliedAt,
			{ memoryId, targetMemoryId, oldMemoryId, replacementMemoryId },
		);
		this.proposals.set(reviewedProposal.id, reviewedProposal);
		await appendJsonl(this.pathFor('proposals'), reviewedProposal);
		const change: AppliedMemoryChange = {
			action: decision.action,
			proposalId: decision.proposalId,
			proposalStatus,
			appliedAt,
			memoryId,
			targetMemoryId,
			oldMemoryId,
			replacementMemoryId,
			reason: curatorDecisionReason(decision),
		};
		await this.audit(
			'curator_decision',
			decision.proposalId,
			change.reason,
			buildCuratorDecisionEvent(change, proposal),
		);
		return change;
	}

	async compact(): Promise<void> {
		await this.initialize();
		await writeJsonlAtomic(
			this.pathFor('memories'),
			Array.from(this.memories.values()),
		);
		await this.audit('compact', 'memories');
	}

	async compactMaintenance(
		options: MemoryCompactOptions = {},
	): Promise<MemoryCompactResult> {
		await this.initialize();
		const now = options.now ? new Date(options.now) : new Date();
		const kept: MemoryRecord[] = [];
		const result: MemoryCompactResult = {
			dryRun: options.dryRun !== false,
			removedDeleted: 0,
			removedSuperseded: 0,
			removedExpiredScratch: 0,
			remaining: 0,
		};
		for (const memory of this.memories.values()) {
			const compactReason = shouldCompactMemory(memory, now);
			if (compactReason === 'deleted') {
				result.removedDeleted++;
				continue;
			}
			if (compactReason === 'superseded') {
				result.removedSuperseded++;
				continue;
			}
			if (compactReason === 'expired_scratch') {
				result.removedExpiredScratch++;
				continue;
			}
			kept.push(memory);
		}
		result.remaining = kept.length;
		if (result.dryRun) return result;
		this.memories = new Map(kept.map((memory) => [memory.id, memory]));
		await writeJsonlAtomic(this.pathFor('memories'), kept);
		await this.audit(
			'compact',
			'memories',
			'removed deleted, superseded, and expired scratch memories',
			result,
		);
		return result;
	}

	private async audit(
		operation: AuditOperation,
		targetId: string,
		reason?: string,
		eventJson?: unknown,
	): Promise<void> {
		const event: AuditEvent = {
			id: randomUUID(),
			operation,
			targetId,
			reason,
			eventJson,
			timestamp: new Date().toISOString(),
		};
		await appendJsonl(this.pathFor('audit'), event);
	}

	private activeMemory(memoryId: string): MemoryRecord {
		const memory = this.memories.get(memoryId);
		if (!memory) {
			throw new MemoryValidationError('target memory was not found');
		}
		if (memory.metadata.deleted === true) {
			throw new MemoryValidationError('target memory is deleted');
		}
		if (memory.supersededBy) {
			throw new MemoryValidationError('target memory is superseded');
		}
		return memory;
	}

	private validateDecisionMemory(record: MemoryRecord): MemoryRecord {
		return validateMemoryRecordRules(record, {
			rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
		});
	}
}

function validateLoadedMemories(
	values: unknown[],
	config: MemoryConfig,
): { records: MemoryRecord[]; invalidCount: number } {
	const records: MemoryRecord[] = [];
	let invalidCount = 0;
	for (const value of values) {
		try {
			records.push(
				validateMemoryRecordRules(value as MemoryRecord, {
					rejectDurableSecrets: config.redaction.rejectDurableSecrets,
				}),
			);
		} catch {
			invalidCount++;
		}
	}
	return { records, invalidCount };
}

function validateLoadedProposals(
	values: unknown[],
	config: MemoryConfig,
): {
	records: MemoryProposal[];
	invalidCount: number;
} {
	const records: MemoryProposal[] = [];
	let invalidCount = 0;
	for (const value of values) {
		try {
			const proposal = validateMemoryProposal(value as MemoryProposal);
			if (proposal.proposedRecord) {
				validateMemoryRecordRules(proposal.proposedRecord, {
					rejectDurableSecrets: config.redaction.rejectDurableSecrets,
				});
			}
			records.push(proposal);
		} catch {
			invalidCount++;
		}
	}
	return { records, invalidCount };
}

async function readJsonl(filePath: string): Promise<unknown[]> {
	if (!existsSync(filePath)) return [];
	const content = await readFile(filePath, 'utf-8');
	const records: unknown[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed));
		} catch {
			// Ignore corrupt JSONL lines. The audit log remains append-only.
		}
	}
	return records;
}

async function readAuditEvents(filePath: string): Promise<AuditEvent[]> {
	const values = await readJsonl(filePath);
	const events: AuditEvent[] = [];
	for (const value of values) {
		if (!value || typeof value !== 'object') continue;
		const candidate = value as Partial<AuditEvent>;
		if (
			typeof candidate.id !== 'string' ||
			typeof candidate.operation !== 'string' ||
			typeof candidate.targetId !== 'string' ||
			typeof candidate.timestamp !== 'string'
		) {
			continue;
		}
		events.push(candidate as AuditEvent);
	}
	return events;
}

function parseRecallUsageEvent(
	event: AuditEvent,
): MemoryRecallUsageEvent | null {
	const raw = event.eventJson ?? event.reason;
	if (typeof raw !== 'string' && (!raw || typeof raw !== 'object')) {
		return null;
	}
	try {
		const parsed = (
			typeof raw === 'string' ? JSON.parse(raw) : raw
		) as Partial<MemoryRecallUsageEvent>;
		if (!Array.isArray(parsed.memoryIds) || typeof parsed.query !== 'string') {
			return null;
		}
		return {
			bundleId:
				typeof parsed.bundleId === 'string' ? parsed.bundleId : event.targetId,
			query: parsed.query,
			scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
			kinds: Array.isArray(parsed.kinds) ? parsed.kinds : undefined,
			memoryIds: parsed.memoryIds.filter(
				(memoryId): memoryId is string => typeof memoryId === 'string',
			),
			scores: Array.isArray(parsed.scores)
				? parsed.scores.filter(
						(score): score is number =>
							typeof score === 'number' && Number.isFinite(score),
					)
				: [],
			tokenEstimate:
				typeof parsed.tokenEstimate === 'number' ? parsed.tokenEstimate : 0,
			agentRole:
				typeof parsed.agentRole === 'string' ? parsed.agentRole : undefined,
			runId: typeof parsed.runId === 'string' ? parsed.runId : undefined,
			timestamp:
				typeof parsed.timestamp === 'string'
					? parsed.timestamp
					: event.timestamp,
		};
	} catch {
		return null;
	}
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

async function writeJsonlAtomic(
	filePath: string,
	values: unknown[],
): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp.${randomUUID()}`;
	const content =
		values.map((value) => JSON.stringify(value)).join('\n') +
		(values.length > 0 ? '\n' : '');
	await writeFile(tmp, content, 'utf-8');
	await rename(tmp, filePath);
}
