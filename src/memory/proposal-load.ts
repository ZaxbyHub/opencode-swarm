import { MemoryValidationError } from './errors';
import { validateMemoryProposal, validateMemoryRecordRules } from './schema';
import type { MemoryProposal } from './types';

export interface ProposalLoadIssue {
	proposalId: string;
	reason: string;
}

export const INVALID_PROPOSAL_LOAD_SAMPLE_LIMIT = 5;

const UNKNOWN_PROPOSAL_ID = '<unknown>';
const MAX_PROPOSAL_LOAD_REASON_LENGTH = 200;

export function parseLoadedProposal(
	value: unknown,
	rejectDurableSecrets: boolean,
): MemoryProposal {
	const proposal = validateMemoryProposal(value as MemoryProposal);
	if (proposal.proposedRecord) {
		validateMemoryRecordRules(proposal.proposedRecord, {
			rejectDurableSecrets,
		});
	}
	return proposal;
}

export function proposalLoadIssueFromValue(
	value: unknown,
	error: unknown,
): ProposalLoadIssue {
	return {
		proposalId: extractProposalId(value) ?? UNKNOWN_PROPOSAL_ID,
		reason: normalizeProposalLoadReason(error),
	};
}

export function proposalLoadIssueFromId(
	proposalId: string,
	error: unknown,
): ProposalLoadIssue {
	return {
		proposalId: proposalId || UNKNOWN_PROPOSAL_ID,
		reason: normalizeProposalLoadReason(error),
	};
}

export function buildProposalLoadDiagnostics(
	issues: readonly ProposalLoadIssue[],
): {
	invalidCount: number;
	samples: ProposalLoadIssue[];
} {
	return {
		invalidCount: issues.length,
		samples: issues.slice(0, INVALID_PROPOSAL_LOAD_SAMPLE_LIMIT),
	};
}

export function asStoredProposalValidationError(
	proposalId: string,
	error: unknown,
): MemoryValidationError {
	if (error instanceof MemoryValidationError) return error;
	return new MemoryValidationError(
		`stored memory proposal is malformed: ${proposalId} (${normalizeProposalLoadReason(error)})`,
		'stored_memory_proposal_invalid',
	);
}

function extractProposalId(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const candidate = (value as { id?: unknown }).id;
	return typeof candidate === 'string' && candidate.length > 0
		? candidate
		: undefined;
}

function normalizeProposalLoadReason(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const trimmed = raw.replace(/\s+/g, ' ').trim();
	if (trimmed.length <= MAX_PROPOSAL_LOAD_REASON_LENGTH) return trimmed;
	return `${trimmed.slice(0, MAX_PROPOSAL_LOAD_REASON_LENGTH - 1)}…`;
}
