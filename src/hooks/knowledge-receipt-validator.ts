/**
 * Shared receipt validator (issue #1849).
 *
 * One validator that enforces the terminal-receipt contract for BOTH the
 * `knowledge_receipt` tool AND the `delegate-ack-collector`. Reads the
 * authoritative event log and rejects forged / expired / conflicting /
 * non-trace receipts while keeping idempotent retries free of double-counting.
 *
 * Authority contract (per issue #1849 §3):
 *  - trace/result delivery proves shown/retrieved only;
 *  - a validated terminal receipt is the durable audit outcome;
 *  - applied counters derive ONLY from validated `applied` receipts;
 *  - ignored/contradicted/no_relevant remain visible but are not application credit.
 *
 * Uniqueness grain: ONE terminal per (trace_id, knowledge_id). A trace surfaces a
 * set of entries; for each entry at most one terminal outcome is accepted.
 * Idempotent retry of the SAME outcome is accepted (not re-emitted, not
 * double-counted); a DIFFERENT outcome for the same (trace_id, knowledge_id)
 * is a conflicting-terminal rejection. The delegate ack path legitimately
 * emits multiple terminals per trace (one per shown directive) — that is fine
 * because each directive has a distinct knowledge_id.
 */

import { log } from '../utils/logger.js';
import {
	type KnowledgeEvent,
	type RetrievedEvent,
	readKnowledgeEvents,
} from './knowledge-events.js';

/** Terminal outcomes the validator accepts. */
export type ReceiptOutcome =
	| 'applied'
	| 'ignored'
	| 'contradicted'
	| 'violated'
	| 'n_a'
	| 'no_relevant';

/** A single item being filed in a receipt. */
export interface ReceiptItem {
	id: string;
	outcome: Exclude<ReceiptOutcome, 'no_relevant'>;
	reason?: string;
}

export interface ReceiptValidationContext {
	directory: string;
	/** The retrieval trace this receipt accounts for, or `'none'`. */
	trace_id: string;
	session_id: string;
	task_id?: string;
	phase?: string;
	agent: string;
	items: ReceiptItem[];
	/** True when the receipt asserts nothing relevant was surfaced. */
	no_relevant_knowledge: boolean;
}

export type ReceiptRejectReason =
	| 'trace_not_found'
	| 'id_not_in_trace'
	| 'wrong_session'
	| 'expired'
	| 'duplicate_conflicting_terminal'
	| 'invalid_outcome'
	| 'empty_receipt';

export type ReceiptValidationResult =
	| {
			ok: true;
			/** Items that should be freshly emitted (excludes idempotent skips). */
			accepted: ReceiptItem[];
			/** Items already recorded with the same outcome — skip emitting. */
			idempotent_skips: ReceiptItem[];
			/** The matched retrieval trace, or null for the real-empty (`'none'`) path. */
			trace: RetrievedEvent | null;
			/** True when this receipt closes the loop with a `no_relevant` terminal. */
			closes_no_relevant: boolean;
			/**
			 * Per-item rejections when SOME items were accepted but others were not
			 * (id_not_in_trace / conflicting). Present only when non-empty.
			 */
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
			/** Items rejected by per-item checks (id_not_in_trace / conflicting). */
			rejected_items?: Array<{
				item: ReceiptItem;
				reason: ReceiptRejectReason;
			}>;
	  };

/**
 * Receipt validity window. A receipt must be filed within this many
 * milliseconds of the retrieval trace's timestamp. Generous default (30 min)
 * covers slow agents; configurable downstream via the issue's diagnostics.
 */
export const RECEIPT_VALIDITY_MS = 30 * 60 * 1000;

/** The `trace_id` sentinel meaning "no retrieval occurred". */
export const NO_TRACE_SENTINEL = 'none';

const VALID_OUTCOMES: ReadonlySet<string> = new Set([
	'applied',
	'ignored',
	'contradicted',
	'violated',
	'n_a',
]);

/**
 * Validate a receipt against the authoritative event log. Never throws — any
 * internal error fails open by accepting the items (the agent's work must not
 * be blocked by a validator crash). Rejections are AUDITED by the caller via
 * the returned reason; the validator itself does not write audit events to
 * keep it side-effect-free and testable.
 */
export async function validateReceipt(
	ctx: ReceiptValidationContext,
): Promise<ReceiptValidationResult> {
	const { items, no_relevant_knowledge } = ctx;

	// 1. Structural: empty receipt.
	if (items.length === 0 && !no_relevant_knowledge) {
		return reject(
			'empty_receipt',
			'no items and no_relevant_knowledge is false',
		);
	}

	// 2. Validate item outcomes up front.
	for (const item of items) {
		if (!VALID_OUTCOMES.has(item.outcome)) {
			return reject(
				'invalid_outcome',
				`item ${item.id}: outcome ${item.outcome}`,
			);
		}
	}

	// 3. `no_relevant` path: no items allowed (a real-empty trace references no
	//    knowledge id). Items + no_relevant together is contradictory.
	if (no_relevant_knowledge && items.length > 0) {
		return reject(
			'invalid_outcome',
			'no_relevant_knowledge cannot be combined with items',
		);
	}

	// 4. Read the event log ONCE (bounded by MAX_EVENT_LOG_ENTRIES = 5000).
	let events: KnowledgeEvent[];
	try {
		events = await readKnowledgeEvents(ctx.directory);
	} catch (err) {
		// Fail open: a corrupt/unreadable log must not block the agent's work.
		log(
			'[receipt-validator] readKnowledgeEvents failed (fail-open, accepting)',
			{
				trace_id: ctx.trace_id,
				error: err instanceof Error ? err.message : String(err),
			},
		);
		return {
			ok: true,
			accepted: items,
			idempotent_skips: [],
			trace: null,
			closes_no_relevant: no_relevant_knowledge,
		};
	}

	// 5. Real-empty (`'none'`) trace: accept the no_relevant terminal, no trace
	//    lookup. No items allowed (enforced above).
	if (ctx.trace_id === NO_TRACE_SENTINEL || ctx.trace_id === '') {
		if (items.length > 0) {
			return reject(
				'trace_not_found',
				`items filed against the ${NO_TRACE_SENTINEL} sentinel trace`,
			);
		}
		return {
			ok: true,
			accepted: [],
			idempotent_skips: [],
			trace: null,
			closes_no_relevant: no_relevant_knowledge,
		};
	}

	// 6. Find the retrieval trace.
	const trace = findTrace(events, ctx.trace_id);
	if (!trace) {
		return reject(
			'trace_not_found',
			`no retrieved event for trace_id ${ctx.trace_id}`,
		);
	}

	// 7. Session ownership.
	if (trace.session_id !== ctx.session_id) {
		return reject(
			'wrong_session',
			`trace session ${trace.session_id} != receipt session ${ctx.session_id}`,
		);
	}

	// 8. Validity window.
	const ageMs = Date.now() - Date.parse(trace.timestamp);
	if (Number.isFinite(ageMs) && ageMs > RECEIPT_VALIDITY_MS) {
		return reject(
			'expired',
			`trace age ${Math.round(ageMs / 1000)}s exceeds ${RECEIPT_VALIDITY_MS / 1000}s`,
		);
	}

	// 9. Build prior-terminal index: (trace_id, knowledge_id) -> outcome, in a
	//    single pass over the log. Used for both membership-style idempotency
	//    and conflicting-terminal detection.
	const prior = new Map<string, string>();
	for (const e of events) {
		if (
			e.type !== 'applied' &&
			e.type !== 'ignored' &&
			e.type !== 'contradicted' &&
			e.type !== 'violated' &&
			e.type !== 'n_a'
		)
			continue;
		if (e.trace_id !== ctx.trace_id) continue;
		const kid = e.knowledge_id;
		if (!kid) continue;
		// Keep the most recent outcome for the (trace, id) pair. Since events are
		// appended in order, later entries overwrite earlier ones.
		prior.set(kid, e.type);
	}

	const resultSet = new Set(trace.result_ids);
	const accepted: ReceiptItem[] = [];
	const idempotent_skips: ReceiptItem[] = [];
	const rejected_items: Array<{
		item: ReceiptItem;
		reason: ReceiptRejectReason;
	}> = [];

	// 10. Per-item: membership + idempotency/conflict.
	for (const item of items) {
		// Membership: the cited id must have been returned by this trace.
		if (!resultSet.has(item.id)) {
			rejected_items.push({ item, reason: 'id_not_in_trace' });
			continue;
		}
		const prev = prior.get(item.id);
		if (prev === item.outcome) {
			// Idempotent retry of the same outcome — do not re-emit, do not count.
			idempotent_skips.push(item);
			continue;
		}
		if (prev !== undefined && prev !== item.outcome) {
			// Conflicting terminal already recorded for this (trace, id).
			rejected_items.push({
				item,
				reason: 'duplicate_conflicting_terminal',
			});
			continue;
		}
		accepted.push(item);
	}

	if (
		rejected_items.length > 0 &&
		accepted.length === 0 &&
		idempotent_skips.length === 0
	) {
		// Every item was rejected — surface the first reason at the top level for
		// a clear tool response, but include the per-item detail.
		const first = rejected_items[0];
		return {
			ok: false,
			rejected: true,
			reason: first.reason,
			detail: `${first.reason} for id ${first.item.id}`,
			rejected_items,
		};
	}

	return {
		ok: true,
		accepted,
		idempotent_skips,
		trace,
		closes_no_relevant: no_relevant_knowledge,
		...(rejected_items.length > 0 && { rejected_items }),
	};
}

function reject(
	reason: ReceiptRejectReason,
	detail: string,
): ReceiptValidationResult {
	return { ok: false, rejected: true, reason, detail };
}

function findTrace(
	events: KnowledgeEvent[],
	traceId: string,
): RetrievedEvent | null {
	for (const e of events) {
		if (e.type === 'retrieved' && e.trace_id === traceId) return e;
	}
	return null;
}

function isTerminalReceipt(e: KnowledgeEvent): boolean {
	return (
		e.type === 'applied' ||
		e.type === 'ignored' ||
		e.type === 'contradicted' ||
		e.type === 'violated' ||
		e.type === 'n_a'
	);
}

export const _internals = {
	findTrace,
	isTerminalReceipt,
	VALID_OUTCOMES,
};
