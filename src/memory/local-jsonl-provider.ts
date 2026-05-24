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
import { MemoryValidationError } from './errors';
import type { MemoryProposalStore, MemoryProvider } from './provider';
import { validateMemoryProposal, validateMemoryRecordRules } from './schema';
import { scopeAllowed, scoreMemoryRecords } from './scoring';
import type {
	MemoryListFilter,
	MemoryProposal,
	MemoryRecord,
	RecallRequest,
	RecallResultItem,
} from './types';

type AuditOperation =
	| 'upsert'
	| 'delete'
	| 'proposal'
	| 'compact'
	| 'invalid_load';

interface AuditEvent {
	id: string;
	operation: AuditOperation;
	targetId: string;
	reason?: string;
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
		await this.initialize();
		const records = await this.list({
			scopes: request.scopes,
			kinds: request.kinds,
			includeExpired: request.includeExpired,
		});
		return scoreMemoryRecords(records, request).slice(0, request.maxItems);
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
		records = records.filter(
			(record) => !record.supersededBy && record.metadata.deleted !== true,
		);
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

	async compact(): Promise<void> {
		await this.initialize();
		await writeJsonlAtomic(
			this.pathFor('memories'),
			Array.from(this.memories.values()),
		);
		await this.audit('compact', 'memories');
	}

	private async audit(
		operation: AuditOperation,
		targetId: string,
		reason?: string,
	): Promise<void> {
		const event: AuditEvent = {
			id: randomUUID(),
			operation,
			targetId,
			reason,
			timestamp: new Date().toISOString(),
		};
		await appendJsonl(this.pathFor('audit'), event);
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
