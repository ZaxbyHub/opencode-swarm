import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	truncate,
	writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import lockfileImport from 'proper-lockfile';
import { validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
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
import {
	assertEventIdentityCompatible,
	ensureOutcomeGeneration,
	importMaterializedOutcomeEvents,
	type MemoryOutcomeEvent,
	materializeOutcomeRecord,
	stripMaterializedOutcomes,
	validateOutcomeEvent,
	validateOutcomeEventForMemory,
} from './outcome-events';
import type {
	MemoryCompactOptions,
	MemoryCompactResult,
	MemoryProposalStore,
	MemoryProvider,
	MemoryRecallUsageEvent,
	MemoryRecallUsageFilter,
	MemoryRewardEvent,
	MemoryRewardEventFilter,
} from './provider';
import {
	buildMemoryCohortFingerprintInput,
	classifyStoredFingerprintAlgorithmVersion,
	computeMemoryCohortFingerprint,
} from './redaction';
import {
	expandRelatedRecallItems,
	projectMemoryRelations,
	stripDerivedRelations,
	validateMergeParticipants,
} from './relations';
import { validateMemoryProposal, validateMemoryRecordRules } from './schema';
import type { RecallScoringDiagnostics } from './scoring';
import {
	scopeAllowed,
	scoreMemoryRecordsWithDiagnostics,
	sliceRecallItemsWithExploration,
} from './scoring';
import type {
	AppliedMemoryChange,
	MemoryAnchor,
	MemoryListFilter,
	MemoryOutcome,
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

const lockfile = lockfileImport as unknown as {
	lock: (
		file: string,
		options: {
			realpath: boolean;
			stale: number;
			retries: { retries: number; minTimeout: number; maxTimeout: number };
		},
	) => Promise<() => Promise<void>>;
};

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
	/**
	 * #1850: when set, the provider serves a cohort-shared store. Cohort roots
	 * bypass `validateSwarmPath` (constructed by the resolver from a sanitized
	 * linkId). `null` for local-root providers (today's behavior).
	 */
	private readonly cohortRoot: string | null;
	private readonly config: MemoryConfig;
	private initialized = false;
	private memories = new Map<string, MemoryRecord>();
	private proposals = new Map<string, MemoryProposal>();

	constructor(
		rootDirectory: string,
		config: Partial<MemoryConfig> = {},
		vettedCohortRoot?: string | null,
	) {
		this.rootDirectory = rootDirectory;
		this.cohortRoot = vettedCohortRoot ?? null;
		this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
	}

	/**
	 * #1850 (critic GAP-5): explicit cohort-root path branch.
	 * - cohort root → `<cohortRoot>/<filename>` (NO validateSwarmPath).
	 * - local root → existing behavior: strip `.swarm/`, validateSwarmPath.
	 */
	private pathFor(
		file:
			| 'memories'
			| 'proposals'
			| 'audit'
			| 'reward-events'
			| 'outcome-events',
	): string {
		const filename =
			file === 'memories'
				? 'memories.jsonl'
				: file === 'proposals'
					? 'proposals.jsonl'
					: file === 'audit'
						? 'audit.jsonl'
						: file === 'reward-events'
							? 'reward-events.jsonl'
							: 'outcome-events.jsonl';
		if (this.cohortRoot) {
			return path.join(this.cohortRoot, filename);
		}
		const storageDir = this.config.storageDir.replace(/^\.swarm[/\\]?/, '');
		return validateSwarmPath(
			this.rootDirectory,
			path.join(storageDir, filename),
		);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		// #1850 (KC-001 fix): enforce the cohort config fingerprint for JSONL
		// providers too, so a cohort member with a mismatched config fails
		// closed (acceptance #10). Mirrors the SQLite provider's check.
		if (this.cohortRoot) {
			this.assertCohortConfigFingerprint();
		}
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
		const outcomeEvents = this.readOutcomeEventsSync();
		const materializedLoad = validateMaterializedMemories(
			memoryLoad.records,
			outcomeEvents,
			this.config,
		);
		this.memories = new Map(
			materializedLoad.records.map((record) => [record.id, record]),
		);
		this.proposals = new Map(
			proposalLoad.records.map((proposal) => [proposal.id, proposal]),
		);
		this.initialized = true;
		const invalidMemoryCount =
			memoryLoad.invalidCount + materializedLoad.invalidCount;
		if (invalidMemoryCount > 0) {
			await this.audit(
				'invalid_load',
				'memories',
				`${invalidMemoryCount} invalid memory JSONL row(s) skipped`,
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
		const next = await this.withOutcomeStoreLock(async () => {
			await this.refreshMemoriesUnlocked();
			const existing = this.memories.get(record.id);
			if (existing?.metadata.deleted === true) {
				throw new MemoryValidationError(
					'memory is tombstoned and cannot be upserted',
				);
			}
			let parsed = validateMemoryRecordRules(
				{
					...stripDerivedRelations(record),
					createdAt: existing?.createdAt ?? record.createdAt,
					metadata: {
						...record.metadata,
						outcomeGeneration:
							existing?.metadata.outcomeGeneration ??
							record.metadata.outcomeGeneration,
					},
				},
				{ rejectDurableSecrets: this.config.redaction.rejectDurableSecrets },
			);
			if (
				(parsed.outcomes?.length ?? 0) > 0 ||
				typeof parsed.metadata.outcomeGeneration === 'string'
			) {
				parsed = ensureOutcomeGeneration(parsed);
			}
			const events = this.readOutcomeEventsSync();
			if (typeof parsed.metadata.outcomeGeneration === 'string') {
				const importedEvents = importMaterializedOutcomeEvents(parsed, events);
				const preflight = [...events];
				for (const imported of importedEvents) {
					validateOutcomeEventForMemory(
						imported,
						parsed,
						this.config.redaction.rejectDurableSecrets,
					);
					const prior = preflight.find(
						(candidate) => candidate.id === imported.id,
					);
					assertEventIdentityCompatible(prior, imported);
					if (!prior) preflight.push(imported);
				}
				if (
					preflight.filter(
						(event) =>
							event.memoryId === parsed.id &&
							event.generation === parsed.metadata.outcomeGeneration,
					).length > 1000
				) {
					throw new MemoryValidationError('memory outcome limit exceeded');
				}
				for (const imported of importedEvents) {
					await this.appendOutcomeEventUnlocked(imported, events);
					if (!events.some((candidate) => candidate.id === imported.id)) {
						events.push(imported);
					}
				}
			}
			const base = stripMaterializedOutcomes(parsed);
			const materialized = this.validateMaterializedRecordUnlocked(
				base,
				events,
			);
			await this.appendMemoryUnlocked(base);
			this.memories.set(materialized.id, materialized);
			return materialized;
		});
		await this.audit('upsert', next.id);
		this.bumpCohortGeneration();
		return next;
	}

	async get(id: string): Promise<MemoryRecord | null> {
		await this.initialize();
		return this.withOutcomeStoreLock(async () => {
			await this.refreshMemoriesUnlocked();
			await this.refreshProposalsUnlocked();
			const record = this.memories.get(id);
			return record
				? projectMemoryRelations([record], this.proposals.values())[0]
				: null;
		});
	}

	async appendOutcome(
		memoryId: string,
		event: { id: string; outcome: MemoryOutcome },
		anchors: MemoryAnchor[] = [],
	): Promise<MemoryRecord> {
		await this.initialize();
		const next = await this.withOutcomeStoreLock(async () => {
			await this.refreshMemoriesUnlocked();
			const persisted = this.memories.get(memoryId);
			if (!persisted) {
				throw new MemoryValidationError('target memory was not found');
			}
			if (persisted.metadata.deleted === true) {
				throw new MemoryValidationError('target memory is deleted');
			}
			const base = ensureOutcomeGeneration(persisted);
			const storedBase = stripMaterializedOutcomes(base);
			const events = this.readOutcomeEventsSync();
			const nextEvent = validateOutcomeEventForMemory(
				{
					...event,
					memoryId,
					generation: storedBase.metadata.outcomeGeneration,
					anchors,
				},
				storedBase,
				this.config.redaction.rejectDurableSecrets,
			);
			assertEventIdentityCompatible(
				events.find((candidate) => candidate.id === nextEvent.id),
				nextEvent,
			);
			if (
				events.filter(
					(candidate) => candidate.generation === nextEvent.generation,
				).length >= 1000 &&
				!events.some((candidate) => candidate.id === nextEvent.id)
			) {
				throw new MemoryValidationError('memory outcome limit exceeded');
			}
			const eventAlreadyCommitted = events.some(
				(candidate) => candidate.id === nextEvent.id,
			);
			const materialized = this.validateMaterializedRecordUnlocked(
				storedBase,
				eventAlreadyCommitted ? events : [...events, nextEvent],
			);
			// Persist the generation-bearing base row once. On retry after a
			// partial two-file failure, the refreshed base already carries the
			// committed generation, so the repair touches only outcome-events.jsonl.
			if (
				persisted.metadata.outcomeGeneration !==
				storedBase.metadata.outcomeGeneration
			) {
				await this.appendMemoryUnlocked(storedBase);
			}
			await this.appendOutcomeEventUnlocked(nextEvent, events);
			if (!eventAlreadyCommitted) {
				events.push(nextEvent);
			}
			this.memories.set(memoryId, materialized);
			return materialized;
		});
		this.bumpCohortGeneration();
		return next;
	}

	async listOutcomeEvents(): Promise<MemoryOutcomeEvent[]> {
		await this.initialize();
		return this.withOutcomeStoreLock(async () => this.readOutcomeEventsSync());
	}

	async delete(id: string, reason?: string): Promise<void> {
		await this.initialize();
		const changed = await this.withOutcomeStoreLock(async () => {
			await this.refreshMemoriesUnlocked();
			const existing = this.memories.get(id);
			if (!existing) return false;
			if (this.config.hardDelete) {
				this.memories.delete(id);
				await this.rewriteMemoryFamilyUnlocked(
					Array.from(this.memories.values()),
				);
			} else {
				const tombstone: MemoryRecord = {
					...existing,
					updatedAt: new Date().toISOString(),
					metadata: {
						...existing.metadata,
						deleted: true,
						deleteReason: reason,
					},
				};
				this.memories.set(id, tombstone);
				await this.appendMemoryUnlocked(tombstone);
			}
			return true;
		});
		if (!changed) return;
		await this.audit('delete', id, reason);
		this.bumpCohortGeneration();
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
		const result = scoreMemoryRecordsWithDiagnostics(
			records,
			request,
			this.config.qLearning,
		);
		// Fix 1 (C.1 reviewer fix): cap normal hits at maxItems, then append the
		// single explored item (if any) beyond the cap so exploration can never
		// evict a legitimate ranked hit. See `sliceRecallItemsWithExploration`.
		const sliced = sliceRecallItemsWithExploration(
			result.items,
			request.maxItems,
		);
		const expanded = expandRelatedRecallItems(
			sliced,
			projectMemoryRelations(
				Array.from(this.memories.values()),
				this.proposals.values(),
			),
			request,
		);
		return {
			items: expanded,
			diagnostics: {
				...result.diagnostics,
				// Fix 3: derive exploredCount from what actually survived
				// slicing, not the pre-slice diagnostics, so the count always
				// matches an item present in the returned bundle.
				exploredCount: expanded.some((item) => item.explored) ? 1 : 0,
				returnedCount: expanded.length,
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
		let usage: MemoryRecallUsageEvent[] = [];
		for (const event of events) {
			if (event.operation !== 'recall') continue;
			const parsed = parseRecallUsageEvent(event);
			if (parsed) usage.push(parsed);
		}
		usage.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		if (typeof filter.runId === 'string' && filter.runId.length > 0) {
			usage = usage.filter((event) => event.runId === filter.runId);
		}
		if (typeof filter.unitId === 'string' && filter.unitId.length > 0) {
			usage = usage.filter((event) => event.unitId === filter.unitId);
		}
		return usage.slice(0, filter.limit ?? usage.length);
	}

	async appendRewardEvent(event: Omit<MemoryRewardEvent, 'id'>): Promise<void> {
		await this.initialize();
		const record: MemoryRewardEvent = { ...event, id: randomUUID() };
		await appendJsonl(this.pathFor('reward-events'), record);
		this.bumpCohortGeneration();
	}

	async listRewardEvents(
		filter: MemoryRewardEventFilter = {},
	): Promise<MemoryRewardEvent[]> {
		await this.initialize();
		const values = await readJsonl(this.pathFor('reward-events'));
		let events: MemoryRewardEvent[] = [];
		for (const value of values) {
			const parsed = parseRewardEvent(value);
			if (parsed) events.push(parsed);
		}
		if (typeof filter.memoryId === 'string' && filter.memoryId.length > 0) {
			events = events.filter((event) => event.memoryId === filter.memoryId);
		}
		events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
		return events.slice(0, filter.limit ?? events.length);
	}

	async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
		await this.initialize();
		await this.withOutcomeStoreLock(async () => {
			await this.refreshMemoriesUnlocked();
			await this.refreshProposalsUnlocked();
		});
		let records = projectMemoryRelations(
			Array.from(this.memories.values()),
			this.proposals.values(),
		);
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
		records.sort(
			(a, b) =>
				compareText(b.updatedAt, a.updatedAt) || compareText(a.id, b.id),
		);
		return records.slice(0, filter.limit ?? records.length);
	}

	async createProposal(proposal: MemoryProposal): Promise<MemoryProposal> {
		await this.initialize();
		const next = validateMemoryProposal(proposal);
		await this.withOutcomeStoreLock(async () => {
			await this.refreshProposalsUnlocked();
			const filePath = this.pathFor('proposals');
			await repairIncompleteJsonlTail(filePath);
			await appendJsonl(filePath, next);
			this.proposals.set(next.id, next);
		});
		await this.audit('proposal', next.id);
		this.bumpCohortGeneration();
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
		const change = await this.withOutcomeStoreLock(async () => {
			await this.refreshMemoriesUnlocked();
			await this.refreshProposalsUnlocked();
			return this.applyCuratorDecisionUnlocked(decision);
		});
		this.bumpCohortGeneration();
		return change;
	}

	private async applyCuratorDecisionUnlocked(
		decision: ResolvedCuratorMemoryDecision,
	): Promise<AppliedMemoryChange> {
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
			await this.appendMemoryUnlocked(memory);
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
				await this.appendMemoryUnlocked(tombstone);
			}
			this.memories.set(updated.id, updated);
			await this.appendMemoryUnlocked(updated);
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
			await this.appendMemoryUnlocked(superseded);
			await this.appendMemoryUnlocked(replacement);
			oldMemoryId = oldMemory.id;
			replacementMemoryId = replacement.id;
			memoryId = replacement.id;
		} else if (decision.action === 'merge') {
			decision = {
				...decision,
				relatedMemoryIds: validateMergeParticipants(
					decision.relatedMemoryIds,
					this.memories.values(),
					this.proposals.values(),
					new Date(appliedAt),
				),
			};
		}

		const proposalStatus =
			decision.action === 'reject' ? 'rejected' : 'applied';
		const reviewedProposal = markProposalReviewed(
			proposal,
			decision,
			proposalStatus,
			appliedAt,
			{
				memoryId,
				targetMemoryId,
				oldMemoryId,
				replacementMemoryId,
				relatedMemoryIds:
					decision.action === 'merge' ? decision.relatedMemoryIds : undefined,
			},
		);
		const proposalsPath = this.pathFor('proposals');
		await repairIncompleteJsonlTail(proposalsPath);
		await appendJsonl(proposalsPath, reviewedProposal);
		this.proposals.set(reviewedProposal.id, reviewedProposal);
		const change: AppliedMemoryChange = {
			action: decision.action,
			proposalId: decision.proposalId,
			proposalStatus,
			appliedAt,
			memoryId,
			targetMemoryId,
			oldMemoryId,
			replacementMemoryId,
			relatedMemoryIds:
				decision.action === 'merge' ? decision.relatedMemoryIds : undefined,
			reason: curatorDecisionReason(decision),
		};
		try {
			await this.audit(
				'curator_decision',
				decision.proposalId,
				change.reason,
				buildCuratorDecisionEvent(change, proposal),
			);
		} catch (error) {
			warn('[memory] failed to persist curator decision audit event', {
				reason: error instanceof Error ? error.message : String(error),
			});
		}
		return change;
	}

	async compact(): Promise<void> {
		await this.initialize();
		await this.withOutcomeStoreLock(async () => {
			await this.refreshMemoriesUnlocked();
			await this.rewriteMemoryFamilyUnlocked(
				Array.from(this.memories.values()),
			);
		});
		await this.audit('compact', 'memories');
		this.bumpCohortGeneration();
	}

	async compactMaintenance(
		options: MemoryCompactOptions = {},
	): Promise<MemoryCompactResult> {
		await this.initialize();
		const result = await this.withOutcomeStoreLock(async () => {
			await this.refreshMemoriesUnlocked();
			const now = options.now ? new Date(options.now) : new Date();
			const kept: MemoryRecord[] = [];
			const current: MemoryCompactResult = {
				dryRun: options.dryRun !== false,
				removedDeleted: 0,
				removedSuperseded: 0,
				removedExpiredScratch: 0,
				remaining: 0,
			};
			for (const memory of this.memories.values()) {
				const compactReason = shouldCompactMemory(memory, now);
				if (compactReason === 'deleted') current.removedDeleted++;
				else if (compactReason === 'superseded') current.removedSuperseded++;
				else if (compactReason === 'expired_scratch')
					current.removedExpiredScratch++;
				else kept.push(memory);
			}
			current.remaining = kept.length;
			if (current.dryRun) return current;
			this.memories = new Map(kept.map((memory) => [memory.id, memory]));
			await this.rewriteMemoryFamilyUnlocked(kept);
			return current;
		});
		if (result.dryRun) return result;
		await this.audit(
			'compact',
			'memories',
			'removed deleted, superseded, and expired scratch memories',
			result,
		);
		this.bumpCohortGeneration();
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

	private async withOutcomeStoreLock<T>(fn: () => Promise<T>): Promise<T> {
		const storageDirectory = path.dirname(this.pathFor('memories'));
		await mkdir(storageDirectory, { recursive: true });
		const release = await lockfile.lock(storageDirectory, {
			realpath: false,
			stale: 10_000,
			retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
		});
		try {
			return await fn();
		} finally {
			await release().catch(() => {});
		}
	}

	private async refreshMemoriesUnlocked(): Promise<void> {
		const loaded = validateLoadedMemories(
			await readJsonl(this.pathFor('memories')),
			this.config,
		);
		const events = this.readOutcomeEventsSync();
		const materialized = validateMaterializedMemories(
			loaded.records,
			events,
			this.config,
		);
		this.memories = new Map(
			materialized.records.map((record) => [record.id, record]),
		);
	}

	private async appendMemoryUnlocked(record: MemoryRecord): Promise<void> {
		const filePath = this.pathFor('memories');
		await repairIncompleteJsonlTail(filePath);
		await appendJsonl(filePath, stripMaterializedOutcomes(record));
	}

	private async refreshProposalsUnlocked(): Promise<void> {
		await repairIncompleteJsonlTail(this.pathFor('proposals'));
		const loaded = validateLoadedProposals(
			await readJsonl(this.pathFor('proposals')),
			this.config,
		);
		this.proposals = new Map(
			loaded.records.map((proposal) => [proposal.id, proposal]),
		);
	}

	private readOutcomeEventsSync(): MemoryOutcomeEvent[] {
		const filePath = this.pathFor('outcome-events');
		if (!existsSync(filePath)) return [];
		const content = readFileSync(filePath, 'utf-8');
		const completeContent = content.endsWith('\n')
			? content
			: content.slice(0, Math.max(0, content.lastIndexOf('\n') + 1));
		const events: MemoryOutcomeEvent[] = [];
		for (const line of completeContent.split('\n')) {
			if (!line.trim()) continue;
			let event: MemoryOutcomeEvent;
			try {
				event = validateOutcomeEvent(JSON.parse(line));
			} catch {
				// Ignore invalid or incomplete rows; the next locked append repairs tail.
				continue;
			}
			const prior = events.find((candidate) => candidate.id === event.id);
			assertEventIdentityCompatible(prior, event);
			if (!prior) events.push(event);
		}
		return events;
	}

	private async appendOutcomeEventUnlocked(
		event: MemoryOutcomeEvent,
		existing: readonly MemoryOutcomeEvent[],
	): Promise<void> {
		const same = existing.find((candidate) => candidate.id === event.id);
		assertEventIdentityCompatible(same, event);
		if (same) return;
		const filePath = this.pathFor('outcome-events');
		await repairIncompleteJsonlTail(filePath);
		await appendJsonl(filePath, event);
	}

	private async rewriteMemoryFamilyUnlocked(
		memories: readonly MemoryRecord[],
	): Promise<void> {
		const liveGenerations = new Set(
			memories.map(
				(memory) =>
					`${memory.id}\0${String(memory.metadata.outcomeGeneration ?? '')}`,
			),
		);
		const events = this.readOutcomeEventsSync().filter((event) =>
			liveGenerations.has(`${event.memoryId}\0${event.generation}`),
		);
		await writeJsonlAtomic(this.pathFor('outcome-events'), events);
		await writeJsonlAtomic(
			this.pathFor('memories'),
			memories.map(stripMaterializedOutcomes),
		);
	}

	private validateMaterializedRecordUnlocked(
		base: MemoryRecord,
		events: readonly MemoryOutcomeEvent[],
	): MemoryRecord {
		return validateMemoryRecordRules(materializeOutcomeRecord(base, events), {
			rejectDurableSecrets: this.config.redaction.rejectDurableSecrets,
		});
	}

	/**
	 * #1850 (critic CONCERN-1): bump the cohort generation marker so sibling
	 * worktrees observe this write on their next revalidation. Called at the
	 * provider layer so ALL write paths invalidate peers. Local writes are
	 * no-ops. Best-effort: a bump failure must never block the write.
	 */
	private bumpCohortGeneration(): void {
		if (!this.cohortRoot) return;
		try {
			const markerPath = path.join(this.cohortRoot, 'memory.gen');
			writeFileSync(markerPath, String(Date.now()), 'utf-8');
		} catch {
			/* best-effort — peer revalidation has TTL + pointer-stat backstops */
		}
	}

	/**
	 * #1850 (KC-001 fix): mirror the SQLite provider's fingerprint check. Reads
	 * `memory-cohort-config.json` and throws on mismatch. Absent/malformed file
	 * is permissive (fail-open never strands memory). #2062 F-012: a file whose
	 * `algorithm_version` is not the current one — or is present but
	 * uninterpretable — is also permissive, because the digests are not
	 * comparable; both warn with a re-link instruction.
	 */
	private assertCohortConfigFingerprint(): void {
		if (!this.cohortRoot) return;
		const configPath = path.join(this.cohortRoot, 'memory-cohort-config.json');
		if (!existsSync(configPath)) return;
		try {
			const stored = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<
				string,
				unknown
			>;
			// #2062 F-012 (R3 fix): mirror the SQLite provider — compare ALGORITHM
			// versions before comparing digests. An ABSENT `algorithm_version` means
			// the file predates the field, i.e. algorithm version 1 — NOT the
			// current version. Defaulting to current would make this gate unfireable
			// for legacy files after the first bump and then byte-compare a v1
			// digest against a v2 expected value.
			const versionCheck = classifyStoredFingerprintAlgorithmVersion(
				stored.algorithm_version,
			);
			if (versionCheck.status === 'unknown') {
				// Present but uninterpretable: skip rather than guess "current".
				warn(
					'[memory-cohort] cohort config has a present but non-numeric `algorithm_version`, so its fingerprint cannot be attributed to a known algorithm and the config-coherence check was skipped. Run `/swarm memory link` to rewrite the cohort fingerprint.',
					{
						cohortRoot: this.cohortRoot,
						storedVersion: stored.algorithm_version,
					},
				);
				return;
			}
			if (versionCheck.status === 'mismatch') {
				// Cross-algorithm digests are not comparable; a byte compare would
				// report a config difference that does not exist. Fail open, but
				// warn (unlike the silent absent/malformed cases) because this one
				// has a concrete user action.
				warn(
					`[memory-cohort] cohort config was fingerprinted with algorithm version ${versionCheck.storedVersion}, but this worktree computes version ${versionCheck.currentVersion}. Digests from different algorithm versions are not comparable, so the config-coherence check was skipped. Run \`/swarm memory link\` to refresh the cohort fingerprint.`,
					{
						cohortRoot: this.cohortRoot,
						storedVersion: versionCheck.storedVersion,
						expectedVersion: versionCheck.currentVersion,
					},
				);
				return;
			}
			const storedFingerprint = stored.fingerprint;
			if (typeof storedFingerprint !== 'string') return;
			const expectedFingerprint = computeMemoryCohortFingerprint(
				buildMemoryCohortFingerprintInput(this.config),
			);
			if (storedFingerprint !== expectedFingerprint) {
				throw new Error(
					`memory cohort config fingerprint mismatch: cohort expects ${storedFingerprint}, this worktree computes ${expectedFingerprint}. ` +
						'Provider/embedding/redaction config differs across cohort members. ' +
						'Run `/swarm memory unlink` to recover local state, or align configs across linked worktrees.',
				);
			}
		} catch (err) {
			if (
				err instanceof Error &&
				err.message.includes('fingerprint mismatch')
			) {
				throw err;
			}
			/* malformed config file — fail-open */
		}
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
	const seenIds = new Set<string>();
	let invalidCount = 0;
	for (let index = values.length - 1; index >= 0; index--) {
		const value = values[index];
		const candidateId =
			value &&
			typeof value === 'object' &&
			typeof (value as { id?: unknown }).id === 'string'
				? (value as { id: string }).id
				: undefined;
		if (candidateId && seenIds.has(candidateId)) continue;
		// A parseable newest row owns its identity even when policy/schema
		// validation fails; never resurrect an older version of that memory.
		if (candidateId) seenIds.add(candidateId);
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
	records.reverse();
	return { records, invalidCount };
}

function validateMaterializedMemories(
	records: readonly MemoryRecord[],
	events: readonly MemoryOutcomeEvent[],
	config: MemoryConfig,
): { records: MemoryRecord[]; invalidCount: number } {
	const valid: MemoryRecord[] = [];
	const seenIds = new Set<string>();
	let invalidCount = 0;
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (!record || seenIds.has(record.id)) continue;
		// JSONL is last-row-wins. Mark the identity before validation so an
		// invalid newest materialization cannot resurrect an older row.
		seenIds.add(record.id);
		try {
			valid.push(
				validateMemoryRecordRules(materializeOutcomeRecord(record, events), {
					rejectDurableSecrets: config.redaction.rejectDurableSecrets,
				}),
			);
		} catch {
			invalidCount++;
		}
	}
	valid.reverse();
	return { records: valid, invalidCount };
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
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
			// Field-by-field rebuild: the whole event is stored as eventJson but
			// reconstructed here, so unitId MUST be carried explicitly or the jsonl
			// round-trip silently drops it (sqlite parses usage_json whole and does
			// not need this — the asymmetry is deliberate to guard against).
			unitId: typeof parsed.unitId === 'string' ? parsed.unitId : undefined,
			timestamp:
				typeof parsed.timestamp === 'string'
					? parsed.timestamp
					: event.timestamp,
		};
	} catch {
		return null;
	}
}

function parseRewardEvent(value: unknown): MemoryRewardEvent | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Partial<MemoryRewardEvent>;
	if (
		typeof candidate.id !== 'string' ||
		typeof candidate.memoryId !== 'string' ||
		typeof candidate.verdict !== 'string' ||
		typeof candidate.reward !== 'number' ||
		typeof candidate.timestamp !== 'string'
	) {
		return null;
	}
	return {
		id: candidate.id,
		memoryId: candidate.memoryId,
		runId: typeof candidate.runId === 'string' ? candidate.runId : undefined,
		unitId: typeof candidate.unitId === 'string' ? candidate.unitId : undefined,
		verdict: candidate.verdict,
		reward: candidate.reward,
		qBefore:
			typeof candidate.qBefore === 'number' ? candidate.qBefore : undefined,
		qAfter: typeof candidate.qAfter === 'number' ? candidate.qAfter : undefined,
		verdictSynthesisJson:
			typeof candidate.verdictSynthesisJson === 'string'
				? candidate.verdictSynthesisJson
				: undefined,
		timestamp: candidate.timestamp,
	};
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

async function repairIncompleteJsonlTail(filePath: string): Promise<void> {
	if (!existsSync(filePath)) return;
	const content = await readFile(filePath, 'utf-8');
	if (content.length === 0 || content.endsWith('\n')) return;
	const lastNewline = content.lastIndexOf('\n');
	await truncate(filePath, lastNewline < 0 ? 0 : lastNewline + 1);
}
