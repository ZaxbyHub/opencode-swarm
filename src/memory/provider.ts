import type { MemoryOutcomeEvent } from './outcome-events';
import type { RecallScoringDiagnostics } from './scoring';
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

export interface MemoryRecallResult {
	items: RecallResultItem[];
	diagnostics?: RecallScoringDiagnostics;
}

export interface MemoryRecallUsageEvent {
	bundleId: string;
	query: string;
	scopes: RecallRequest['scopes'];
	kinds?: RecallRequest['kinds'];
	memoryIds: string[];
	scores: number[];
	tokenEstimate: number;
	agentRole?: string;
	runId?: string;
	/**
	 * Task/phase unit-of-work identity (ADDITIVE — recorded alongside `runId`).
	 * Undefined when unresolvable at recording time (graceful degrade to
	 * session-scoped `runId`).
	 */
	unitId?: string;
	timestamp: string;
}

export interface MemoryRecallUsageFilter {
	limit?: number;
	runId?: string;
	/**
	 * Restrict to rows whose `unit_id` matches. Combined with `runId` the two
	 * predicates AND. Attribution prefers this filter and falls back to `runId`.
	 */
	unitId?: string;
	/**
	 * Restrict recall events to those with `timestamp >= since` (ISO 8601).
	 * Used by buildRetrievalRecency to bound iteration over recent events only.
	 */
	since?: string;
}

export interface MemoryRewardEvent {
	id: string;
	memoryId: string;
	runId?: string;
	unitId?: string;
	verdict: string; // 'APPROVE' | 'CONCERNS' | 'REJECT' — string to keep provider leaf-level (no council import)
	reward: number;
	qBefore?: number;
	qAfter?: number;
	verdictSynthesisJson?: string;
	timestamp: string; // ISO 8601, caller-supplied
}

export interface MemoryRewardEventFilter {
	memoryId?: string;
	limit?: number;
}

export interface MemoryCompactOptions {
	dryRun?: boolean;
	now?: string;
}

export interface MemoryCompactResult {
	dryRun: boolean;
	removedDeleted: number;
	removedSuperseded: number;
	removedExpiredScratch: number;
	remaining: number;
}

/**
 * Lightweight transaction marker. Concrete transaction semantics are
 * backend-specific (SQLite serialised, local-jsonl no-op).
 */
export type MemoryTransaction = object;

export interface MemoryProvider {
	readonly name: string;
	initialize?(): Promise<void>;
	close?(): Promise<void> | void;
	upsert(record: MemoryRecord): Promise<MemoryRecord>;
	appendOutcome?(
		memoryId: string,
		event: { id: string; outcome: MemoryOutcome },
		anchors?: MemoryAnchor[],
	): Promise<MemoryRecord>;
	listOutcomeEvents?(): Promise<MemoryOutcomeEvent[]>;
	get(id: string): Promise<MemoryRecord | null>;
	delete(id: string, reason?: string): Promise<void>;
	recall(request: RecallRequest): Promise<RecallResultItem[]>;
	recallWithDiagnostics?(request: RecallRequest): Promise<MemoryRecallResult>;
	recordRecallUsage?(event: MemoryRecallUsageEvent): Promise<void>;
	listRecallUsage?(
		filter?: MemoryRecallUsageFilter,
	): Promise<MemoryRecallUsageEvent[]>;
	appendRewardEvent?(event: Omit<MemoryRewardEvent, 'id'>): Promise<void>;
	listRewardEvents?(
		filter?: MemoryRewardEventFilter,
	): Promise<MemoryRewardEvent[]>;
	/**
	 * #1466: append a gateway-emitted audit event to the provider's event log
	 * (`memory_events`, hash-chained on the SQLite provider). Narrowly typed to
	 * the PII-rejection operation — provider-internal operations stay internal.
	 * Optional: the local-jsonl provider has no event log and simply omits it.
	 */
	recordEvent?(
		operation: 'pii_rejected',
		targetId: string,
		reason?: string,
	): Promise<void>;
	compactMaintenance?(
		options?: MemoryCompactOptions,
	): Promise<MemoryCompactResult>;
	list(filter: MemoryListFilter): Promise<MemoryRecord[]>;
	/**
	 * Run `fn` atomically within a transaction. When the provider does not
	 * support transactions (e.g. local-jsonl), this is a no-op that calls
	 * `fn` directly. The applyCouncilReward loop uses this to avoid a
	 * read-then-update race between concurrent council verdicts on the same
	 * memory id.
	 */
	withTransaction?<T>(
		fn: (tx: MemoryTransaction) => Promise<T> | T,
	): Promise<T>;
}

export interface MemoryProposalStore {
	createProposal(proposal: MemoryProposal): Promise<MemoryProposal>;
	listProposals(filter?: {
		status?: MemoryProposal['status'];
		limit?: number;
	}): Promise<MemoryProposal[]>;
	applyCuratorDecision?(
		decision: ResolvedCuratorMemoryDecision,
	): Promise<AppliedMemoryChange>;
}
