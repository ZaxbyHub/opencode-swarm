/**
 * Shared V2 receipt validator and atomic terminal committer (issue #2031).
 *
 * Both the knowledge_receipt tool and delegate/reviewer collectors use this
 * adapter. Correctness is fail-closed: membership validation, idempotency and
 * terminal commit occur under the dedicated receipt-ledger lock before any
 * diagnostic or promotion projection is written.
 */

import type { KnowledgeEvent, RetrievedEvent } from './knowledge-events.js';
import {
	commitEmptyRetrieval,
	queryLiveMemberships,
	RECEIPT_TERMINAL_OUTCOMES,
	type ReceiptOutcome,
	validateAndCommitTerminalBatch,
} from './knowledge-receipt-ledger.js';

/**
 * Canonical terminal outcome — single declaration lives in the authoritative
 * ledger (issue #2032). Re-exported here for existing import sites; do NOT
 * redeclare. The trace-level `no_relevant` tombstone is NOT a terminal
 * outcome and never appears on a `ReceiptItem`.
 */
export type { ReceiptOutcome };

export interface ReceiptItem {
	id: string;
	outcome: ReceiptOutcome;
	reason?: string;
}

export interface ReceiptValidationContext {
	directory: string;
	trace_id: string;
	session_id: string;
	task_id?: string;
	phase?: string;
	agent: string;
	/**
	 * Provenance class for the committed terminals (issue #2032): who is
	 * reporting, e.g. 'delegate' for the delegate-ack collector or the
	 * agent-class value for the knowledge_receipt tool. This is deliberately
	 * NOT derived from `agent` — agent identity and source are different
	 * facts, and conflating them is how delegate terminals lost their
	 * provenance. Type-required, but fail-open at runtime: a falsy value
	 * stamps the honest 'unknown' class rather than rejecting the receipt.
	 */
	source: string;
	cohort_id?: string;
	source_link_id?: string;
	grace_days?: number;
	items: ReceiptItem[];
	no_relevant_knowledge: boolean;
}

export type ReceiptRejectReason =
	| 'trace_not_found'
	| 'id_not_in_trace'
	| 'wrong_session'
	| 'wrong_phase'
	| 'wrong_task'
	| 'expired'
	| 'duplicate_conflicting_terminal'
	| 'invalid_outcome'
	| 'empty_receipt'
	| 'lock_timeout'
	| 'store_unavailable'
	| 'store_corrupt'
	| 'legacy_unverifiable';

export type ReceiptValidationResult =
	| {
			ok: true;
			accepted: ReceiptItem[];
			idempotent_skips: ReceiptItem[];
			trace: RetrievedEvent | null;
			closes_no_relevant: boolean;
			authoritative_event_ids: Record<string, string>;
			no_relevant_event_id?: string;
			rejected_items?: Array<{
				item: ReceiptItem;
				reason: ReceiptRejectReason;
			}>;
	  }
	| {
			ok: false;
			rejected: true;
			reason: ReceiptRejectReason;
			detail: string;
			rejected_items?: Array<{
				item: ReceiptItem;
				reason: ReceiptRejectReason;
			}>;
	  };

export const NO_TRACE_SENTINEL = 'none';
const VALID_OUTCOMES: ReadonlySet<string> = RECEIPT_TERMINAL_OUTCOMES;

function reject(
	reason: ReceiptRejectReason,
	detail: string,
	rejected_items?: Array<{ item: ReceiptItem; reason: ReceiptRejectReason }>,
): ReceiptValidationResult {
	return { ok: false, rejected: true, reason, detail, rejected_items };
}

export async function validateReceipt(
	ctx: ReceiptValidationContext,
): Promise<ReceiptValidationResult> {
	const { items, no_relevant_knowledge: noRelevant } = ctx;
	if (items.length === 0 && !noRelevant) {
		return reject(
			'empty_receipt',
			'no items and no_relevant_knowledge is false',
		);
	}
	if (noRelevant && items.length > 0) {
		return reject(
			'invalid_outcome',
			'no_relevant_knowledge cannot be combined with items',
		);
	}
	for (const item of items) {
		if (!VALID_OUTCOMES.has(item.outcome)) {
			return reject(
				'invalid_outcome',
				`item ${item.id}: outcome ${item.outcome}`,
			);
		}
	}

	const traceId = ctx.trace_id || NO_TRACE_SENTINEL;
	if (traceId === NO_TRACE_SENTINEL) {
		if (items.length > 0) {
			return reject(
				'trace_not_found',
				'items filed against the none sentinel trace',
			);
		}
		const empty = await commitEmptyRetrieval(ctx.directory, {
			trace_id: traceId,
			session_id: ctx.session_id,
			phase: ctx.phase,
			task_id: ctx.task_id,
			agent: ctx.agent,
			grace_days: ctx.grace_days,
		});
		if (!empty.ok) {
			return reject(empty.code as ReceiptRejectReason, empty.detail);
		}
		return {
			ok: true,
			accepted: [],
			idempotent_skips: [],
			trace: null,
			closes_no_relevant: true,
			authoritative_event_ids: {},
			no_relevant_event_id: empty.terminal_event_id,
		};
	}

	const committed = await validateAndCommitTerminalBatch(ctx.directory, {
		trace_id: traceId,
		session_id: ctx.session_id,
		phase: ctx.phase,
		task_id: ctx.task_id,
		agent: ctx.agent,
		cohort_id: ctx.cohort_id,
		source_link_id: ctx.source_link_id,
		grace_days: ctx.grace_days,
		items: items.map((item) => ({
			entry_id: item.id,
			outcome: item.outcome,
			reason: item.reason,
			// Trim before the fail-open fallback (#2032 review PRR-004): a
			// whitespace-only source must stamp the honest 'unknown' class,
			// never persist an unbounded-code string the telemetry layer would
			// then silently drop (ledger/telemetry divergence).
			source: ctx.source.trim() || 'unknown',
		})),
		no_relevant_knowledge: noRelevant,
	});
	if (!committed.ok) {
		return reject(committed.code as ReceiptRejectReason, committed.detail);
	}

	const remainingItems = [...items];
	const takeItem = (
		id: string,
		outcome?: ReceiptItem['outcome'],
	): ReceiptItem | undefined => {
		const index = remainingItems.findIndex(
			(item) =>
				item.id === id && (outcome === undefined || item.outcome === outcome),
		);
		if (index < 0) return undefined;
		return remainingItems.splice(index, 1)[0];
	};
	const accepted = committed.accepted
		.map((item) => takeItem(item.entry_id, item.outcome))
		.filter((item): item is ReceiptItem => item !== undefined);
	const idempotent_skips = committed.idempotent
		.map((id) => takeItem(id))
		.filter((item): item is ReceiptItem => item !== undefined);
	const rejected_items = committed.rejected.map((item) => ({
		item: takeItem(item.entry_id) ?? {
			id: item.entry_id,
			outcome: 'ignored' as const,
		},
		reason: item.reason as ReceiptRejectReason,
	}));
	if (
		rejected_items.length &&
		accepted.length === 0 &&
		idempotent_skips.length === 0
	) {
		return reject(
			rejected_items[0].reason,
			`${rejected_items[0].reason} for id ${rejected_items[0].item.id}`,
			rejected_items,
		);
	}

	const queried = await queryLiveMemberships(ctx.directory, {
		session_id: ctx.session_id,
		include_terminal: true,
		grace_days: ctx.grace_days,
	});
	const memberships = queried.ok
		? queried.memberships.filter(
				(membership) => membership.trace_id === traceId,
			)
		: [];
	const trace: RetrievedEvent | null = memberships.length
		? {
				type: 'retrieved',
				event_id: memberships[0].membership_event_id,
				trace_id: traceId,
				timestamp: memberships[0].committed_at,
				session_id: ctx.session_id,
				phase: memberships[0].phase,
				task_id: memberships[0].task_id,
				agent: memberships[0].agent ?? ctx.agent,
				query: '',
				retrieval_mode: 'manual',
				result_ids: memberships.map((membership) => membership.entry_id),
				ranks: Object.fromEntries(
					memberships.map((membership, index) => [
						membership.entry_id,
						membership.rank ?? index + 1,
					]),
				),
				scores: Object.fromEntries(
					memberships.map((membership) => [
						membership.entry_id,
						membership.score ?? 0,
					]),
				),
			}
		: null;

	return {
		ok: true,
		accepted,
		idempotent_skips,
		trace,
		closes_no_relevant: committed.closes_no_relevant,
		authoritative_event_ids: Object.fromEntries(
			committed.accepted.map((item) => [item.entry_id, item.event_id] as const),
		),
		...(committed.terminal_event_id
			? { no_relevant_event_id: committed.terminal_event_id }
			: {}),
		...(rejected_items.length ? { rejected_items } : {}),
	};
}

function findTrace(
	events: KnowledgeEvent[],
	traceId: string,
): RetrievedEvent | null {
	return (
		events.find(
			(event): event is RetrievedEvent =>
				event.type === 'retrieved' && event.trace_id === traceId,
		) ?? null
	);
}

function isTerminalReceipt(event: KnowledgeEvent): boolean {
	return (RECEIPT_TERMINAL_OUTCOMES as ReadonlySet<string>).has(event.type);
}

export const _internals = { findTrace, isTerminalReceipt, VALID_OUTCOMES };
