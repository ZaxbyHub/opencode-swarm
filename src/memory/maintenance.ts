import type { MemoryProposalStore, MemoryProvider } from './provider';
import { isExpired } from './schema';
import type { MemoryProposal, MemoryRecord } from './types';

export interface MemoryRecallUsageByMemory {
	memoryId: string;
	count: number;
	lastRecalledAt: string;
	agentRoles: Record<string, number>;
	averageScore: number;
}

export interface MemoryRecallUsageByRole {
	agentRole: string;
	count: number;
	memoryIds: Record<string, number>;
}

export interface MemorySupersededChain {
	rootId: string;
	chain: string[];
	reason?: string;
}

export interface MemoryMaintenanceReport {
	generatedAt: string;
	totalMemories: number;
	activeMemories: number;
	deletedMemories: MemoryRecord[];
	expiredScratchMemories: MemoryRecord[];
	supersededMemories: MemoryRecord[];
	supersededChains: MemorySupersededChain[];
	lowUtilityMemories: MemoryRecord[];
	neverRecalledMemories: MemoryRecord[];
	mostRecalledMemories: MemoryRecallUsageByMemory[];
	recallByAgentRole: MemoryRecallUsageByRole[];
	rejectedProposalReasons: MemoryProposal[];
	pendingProposals: MemoryProposal[];
	recallEventCount: number;
}

export interface MemoryMaintenanceReportOptions {
	now?: Date;
	limit?: number;
	lowUtilityMaxConfidence?: number;
	lowUtilityMinAgeDays?: number;
}

type ObservableProvider = MemoryProvider &
	Partial<MemoryProposalStore> & {
		listRecallUsage?: MemoryProvider['listRecallUsage'];
	};

const DEFAULT_LOW_UTILITY_MAX_CONFIDENCE = 0.45;
const DEFAULT_LOW_UTILITY_MIN_AGE_DAYS = 30;

export async function buildMemoryMaintenanceReport(
	provider: ObservableProvider,
	options: MemoryMaintenanceReportOptions = {},
): Promise<MemoryMaintenanceReport> {
	const now = options.now ?? new Date();
	const limit = Math.max(1, Math.trunc(options.limit ?? 20));
	const memories = await provider.list({
		includeExpired: true,
		includeInactive: true,
	});
	const proposals = await loadMaintenanceProposals(provider, limit);
	const recallUsage = provider.listRecallUsage
		? await provider.listRecallUsage()
		: [];
	const usageByMemory = summarizeRecallByMemory(recallUsage);
	const usageByRole = summarizeRecallByRole(recallUsage);
	const activeMemories = memories.filter((memory) =>
		isActiveMemory(memory, now),
	);
	const deletedMemories = memories.filter(
		(memory) => memory.metadata.deleted === true,
	);
	const expiredScratchMemories = memories.filter(
		(memory) => memory.kind === 'scratch' && isExpired(memory, now),
	);
	const supersededMemories = memories.filter((memory) =>
		Boolean(memory.supersededBy),
	);
	const lowUtilityMemories = activeMemories
		.filter((memory) =>
			isLowUtility(memory, usageByMemory, now, {
				maxConfidence:
					options.lowUtilityMaxConfidence ?? DEFAULT_LOW_UTILITY_MAX_CONFIDENCE,
				minAgeDays:
					options.lowUtilityMinAgeDays ?? DEFAULT_LOW_UTILITY_MIN_AGE_DAYS,
			}),
		)
		.sort(memorySort);
	const neverRecalledMemories = activeMemories
		.filter((memory) => !usageByMemory.has(memory.id))
		.sort(memorySort);
	const rejectedProposalReasons = proposals
		.filter((proposal) => proposal.status === 'rejected')
		.sort(proposalSort);
	const pendingProposals = proposals
		.filter((proposal) => proposal.status === 'pending')
		.sort(proposalSort);

	return {
		generatedAt: now.toISOString(),
		totalMemories: memories.length,
		activeMemories: activeMemories.length,
		deletedMemories: deletedMemories.slice(0, limit),
		expiredScratchMemories: expiredScratchMemories.slice(0, limit),
		supersededMemories: supersededMemories.slice(0, limit),
		supersededChains: buildSupersededChains(memories).slice(0, limit),
		lowUtilityMemories: lowUtilityMemories.slice(0, limit),
		neverRecalledMemories: neverRecalledMemories.slice(0, limit),
		mostRecalledMemories: Array.from(usageByMemory.values())
			.sort(
				(a, b) =>
					b.count - a.count ||
					b.lastRecalledAt.localeCompare(a.lastRecalledAt) ||
					a.memoryId.localeCompare(b.memoryId),
			)
			.slice(0, limit),
		recallByAgentRole: Array.from(usageByRole.values())
			.sort(
				(a, b) => b.count - a.count || a.agentRole.localeCompare(b.agentRole),
			)
			.slice(0, limit),
		rejectedProposalReasons: rejectedProposalReasons.slice(0, limit),
		pendingProposals: pendingProposals.slice(0, limit),
		recallEventCount: recallUsage.length,
	};
}

export function shouldCompactMemory(
	memory: MemoryRecord,
	now = new Date(),
): 'deleted' | 'superseded' | 'expired_scratch' | null {
	if (memory.metadata.deleted === true) return 'deleted';
	if (memory.supersededBy) return 'superseded';
	if (memory.kind === 'scratch' && isExpired(memory, now)) {
		return 'expired_scratch';
	}
	return null;
}

function isActiveMemory(memory: MemoryRecord, now: Date): boolean {
	return (
		memory.metadata.deleted !== true &&
		!memory.supersededBy &&
		!isExpired(memory, now)
	);
}

function isLowUtility(
	memory: MemoryRecord,
	usageByMemory: Map<string, MemoryRecallUsageByMemory>,
	now: Date,
	options: { maxConfidence: number; minAgeDays: number },
): boolean {
	if (usageByMemory.has(memory.id)) return false;
	const updated = Date.parse(memory.updatedAt);
	const ageDays = Number.isFinite(updated)
		? (now.getTime() - updated) / (24 * 60 * 60 * 1000)
		: 0;
	return (
		memory.confidence <= options.maxConfidence || ageDays >= options.minAgeDays
	);
}

function summarizeRecallByMemory(
	usageEvents: Awaited<
		ReturnType<NonNullable<MemoryProvider['listRecallUsage']>>
	>,
): Map<string, MemoryRecallUsageByMemory> {
	const byMemory = new Map<
		string,
		MemoryRecallUsageByMemory & { scoreTotal: number; scoreCount: number }
	>();
	for (const event of usageEvents) {
		event.memoryIds.forEach((memoryId, index) => {
			const role = event.agentRole ?? 'unknown';
			const existing =
				byMemory.get(memoryId) ??
				({
					memoryId,
					count: 0,
					lastRecalledAt: event.timestamp,
					agentRoles: {},
					averageScore: 0,
					scoreTotal: 0,
					scoreCount: 0,
				} satisfies MemoryRecallUsageByMemory & {
					scoreTotal: number;
					scoreCount: number;
				});
			existing.count++;
			existing.lastRecalledAt =
				event.timestamp > existing.lastRecalledAt
					? event.timestamp
					: existing.lastRecalledAt;
			existing.agentRoles[role] = (existing.agentRoles[role] ?? 0) + 1;
			const score = event.scores[index];
			if (typeof score === 'number' && Number.isFinite(score)) {
				existing.scoreTotal += score;
				existing.scoreCount++;
				existing.averageScore = existing.scoreTotal / existing.scoreCount;
			}
			byMemory.set(memoryId, existing);
		});
	}
	return new Map(
		Array.from(byMemory, ([memoryId, value]) => [
			memoryId,
			{
				memoryId,
				count: value.count,
				lastRecalledAt: value.lastRecalledAt,
				agentRoles: value.agentRoles,
				averageScore: value.averageScore,
			},
		]),
	);
}

async function loadMaintenanceProposals(
	provider: Partial<MemoryProposalStore>,
	limit: number,
): Promise<MemoryProposal[]> {
	if (!provider.listProposals) return [];
	const [pending, rejected, recent] = await Promise.all([
		provider.listProposals({ status: 'pending', limit }),
		provider.listProposals({ status: 'rejected', limit }),
		provider.listProposals({ limit: Math.max(limit * 4, 100) }),
	]);
	const byId = new Map<string, MemoryProposal>();
	for (const proposal of [...pending, ...rejected, ...recent]) {
		byId.set(proposal.id, proposal);
	}
	return Array.from(byId.values());
}

function summarizeRecallByRole(
	usageEvents: Awaited<
		ReturnType<NonNullable<MemoryProvider['listRecallUsage']>>
	>,
): Map<string, MemoryRecallUsageByRole> {
	const byRole = new Map<string, MemoryRecallUsageByRole>();
	for (const event of usageEvents) {
		const role = event.agentRole ?? 'unknown';
		const existing = byRole.get(role) ?? {
			agentRole: role,
			count: 0,
			memoryIds: {},
		};
		existing.count++;
		for (const memoryId of event.memoryIds) {
			existing.memoryIds[memoryId] = (existing.memoryIds[memoryId] ?? 0) + 1;
		}
		byRole.set(role, existing);
	}
	return byRole;
}

function buildSupersededChains(
	memories: MemoryRecord[],
): MemorySupersededChain[] {
	const byId = new Map(memories.map((memory) => [memory.id, memory]));
	const supersededIds = new Set(
		memories.filter((memory) => memory.supersededBy).map((memory) => memory.id),
	);
	const roots = memories.filter(
		(memory) =>
			memory.supersededBy &&
			!(memory.supersedes ?? []).some((id) => supersededIds.has(id)),
	);
	return roots.map((root) => {
		const chain = [root.id];
		const seen = new Set(chain);
		let cursor: MemoryRecord | undefined = root;
		while (cursor?.supersededBy && !seen.has(cursor.supersededBy)) {
			chain.push(cursor.supersededBy);
			seen.add(cursor.supersededBy);
			cursor = byId.get(cursor.supersededBy);
		}
		return {
			rootId: root.id,
			chain,
			reason:
				typeof root.metadata.supersedeReason === 'string'
					? root.metadata.supersedeReason
					: undefined,
		};
	});
}

function memorySort(a: MemoryRecord, b: MemoryRecord): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function proposalSort(a: MemoryProposal, b: MemoryProposal): number {
	const aTime = a.reviewedAt ?? a.createdAt;
	const bTime = b.reviewedAt ?? b.createdAt;
	return bTime.localeCompare(aTime) || a.id.localeCompare(b.id);
}
