import { MemoryValidationError } from './errors';
import {
	computeMemoryContentHash,
	createMemoryId,
	normalizeMemoryText,
	validateMemoryProposal,
} from './schema';
import type {
	AppliedMemoryChange,
	MemoryPatch,
	MemoryProposal,
	MemoryRecord,
	ResolvedCuratorMemoryDecision,
} from './types';

export function validateDecisionMatchesProposal(
	decision: ResolvedCuratorMemoryDecision,
	proposal: MemoryProposal,
): void {
	if (
		(decision.action === 'add' && proposal.operation !== 'add') ||
		(decision.action === 'update' && proposal.operation !== 'update') ||
		(decision.action === 'supersede' && proposal.operation !== 'supersede')
	) {
		throw new MemoryValidationError(
			`curator ${decision.action} decision does not match ${proposal.operation} proposal`,
		);
	}
	if (
		decision.action === 'update' &&
		proposal.targetMemoryId &&
		proposal.targetMemoryId !== decision.targetMemoryId
	) {
		throw new MemoryValidationError(
			'curator update decision target does not match proposal target',
		);
	}
	if (
		decision.action === 'supersede' &&
		proposal.targetMemoryId &&
		proposal.targetMemoryId !== decision.oldMemoryId
	) {
		throw new MemoryValidationError(
			'curator supersede decision target does not match proposal target',
		);
	}
}

export function applyPatchToMemory(
	existing: MemoryRecord,
	patch: MemoryPatch,
	updatedAt: string,
): MemoryRecord {
	const base = {
		scope: patch.scope ?? existing.scope,
		kind: patch.kind ?? existing.kind,
		text:
			patch.text === undefined
				? existing.text
				: normalizeMemoryText(patch.text),
	};
	const tags =
		patch.tags === undefined ? existing.tags : normalizeTags(patch.tags);
	return {
		...existing,
		...patch,
		...base,
		id: createMemoryId(base),
		tags,
		updatedAt,
		contentHash: computeMemoryContentHash(base),
		metadata:
			patch.metadata === undefined
				? existing.metadata
				: { ...existing.metadata, ...patch.metadata },
	};
}

export function markProposalReviewed(
	proposal: MemoryProposal,
	decision: ResolvedCuratorMemoryDecision,
	status: MemoryProposal['status'],
	reviewedAt: string,
	ids: {
		memoryId?: string;
		targetMemoryId?: string;
		oldMemoryId?: string;
		replacementMemoryId?: string;
	},
): MemoryProposal {
	const reason = curatorDecisionReason(decision);
	return validateMemoryProposal({
		...proposal,
		status,
		reviewer: 'curator_agent',
		reviewedAt,
		rejectionReason: decision.action === 'reject' ? reason : undefined,
		metadata: {
			...proposal.metadata,
			curatorDecision: {
				action: decision.action,
				reason,
				...ids,
				appliedAt: reviewedAt,
			},
		},
	});
}

export function curatorDecisionReason(
	decision: ResolvedCuratorMemoryDecision,
): string | undefined {
	switch (decision.action) {
		case 'add':
			return undefined;
		case 'update':
		case 'supersede':
		case 'reject':
		case 'noop':
			return decision.reason;
	}
}

export function buildCuratorDecisionEvent(
	change: AppliedMemoryChange,
	proposal: MemoryProposal,
): AppliedMemoryChange & { proposalOperation: MemoryProposal['operation'] } {
	return {
		...change,
		proposalOperation: proposal.operation,
	};
}

export function normalizeTags(tags: string[]): string[] {
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
