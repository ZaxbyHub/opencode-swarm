/**
 * Delegate ack collection (Swarm Learning System, Change 1 / Task 1.5).
 *
 * A `tool.execute.after` hook on the `Task` tool. After a delegated subagent
 * returns, this reconciles the directives that were shown to it (recovered by
 * parsing the `<delegate_knowledge_directives>` block out of the delegation
 * prompt) against the ack markers in the subagent's transcript:
 *
 *   - For every ack whose ID was actually shown, emit a receipt event of the
 *     matching type (applied / ignored / violated / n_a). Acks for IDs that were
 *     never shown are DROPPED (anti-spoofing).
 *   - For every CRITICAL directive that was shown but never acknowledged, emit a
 *     `violated` event with reason `unacknowledged` and append an audit line to
 *     `.swarm/unacknowledged-criticals.jsonl`.
 *   - For every NON-CRITICAL directive that was shown but never acknowledged,
 *     emit a neutral, audit-only `unacknowledged` event (reason
 *     `no_ack_marker`). Silence is not a violation for non-criticals — it is a
 *     visibility signal, so it is never escalated, never audited to the
 *     criticals file, and never mutates a counter.
 *
 * Stateless by design: it re-parses the prompt rather than relying on
 * cross-hook mutable state, so it is safe under parallel delegations. Fail-open:
 * never throws, never blocks.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { ensureCohortIdCached } from './cohort-cache.js';
import { parseAcknowledgments } from './knowledge-application.js';
import { escalateViolatedEntries } from './knowledge-escalator.js';
import {
	type KnowledgeEventInput,
	newTraceId,
	recordKnowledgeEvent,
	recordKnowledgeEventsBatch,
} from './knowledge-events.js';
import {
	parseDelegateDirectiveBlock,
	parseDelegateDirectiveTraceId,
} from './knowledge-injector.js';
import { readLinkPointer } from './knowledge-link.js';
import {
	type ReceiptItem,
	validateReceipt,
} from './knowledge-receipt-validator.js';
import type { PromotionEvidenceRecord } from './knowledge-types.js';
import { appendPromotionEvidence } from './promotion-evidence-store.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';
import { validateSwarmPath } from './utils.js';

export interface DelegateAckInput {
	tool: unknown;
	agent?: unknown;
	sessionID?: unknown;
	args?: unknown;
}

export interface DelegateAckOutput {
	output?: unknown;
}

function isTaskTool(tool: unknown): boolean {
	return tool === 'Task' || tool === 'task';
}

/** Best-effort extraction of a task id from a delegation prompt envelope. */
function extractTaskId(prompt: string): string | undefined {
	const m = /\btask[_-]?id\s*[:=]\s*([A-Za-z0-9._-]{1,80})/i.exec(prompt);
	return m ? m[1] : undefined;
}

/**
 * Append an unacknowledged-critical audit line. Path is validated to stay inside
 * `.swarm/`. Best-effort: errors are swallowed by the caller.
 */
async function appendUnacknowledgedCritical(
	directory: string,
	record: Record<string, unknown>,
): Promise<void> {
	const filePath = validateSwarmPath(
		directory,
		'unacknowledged-criticals.jsonl',
	);
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

export interface CollectDelegateAcksResult {
	emitted: Array<{ id: string; type: string }>;
	/**
	 * CRITICAL directives shown to the delegate that it never acknowledged. Each
	 * one is a contract violation: emitted as `violated`/`unacknowledged`, audited
	 * to `.swarm/unacknowledged-criticals.jsonl`, and fed to the repeat-mistake
	 * escalator.
	 */
	unacknowledgedCriticals: string[];
	/**
	 * NON-critical directives shown to the delegate that it never acknowledged.
	 * These are NOT contract violations — the ack contract only obliges the
	 * delegate to answer for criticals. Each is emitted as a neutral,
	 * audit-only `unacknowledged` event so silent non-critical delivery is
	 * visible to the curator post-mortem instead of vanishing. They are never
	 * escalated, never written to the criticals audit file, and never produce
	 * promotion evidence.
	 */
	unacknowledgedNonCritical: string[];
}

/**
 * Core reconciliation used by both the runtime hook and tests. Returns a summary
 * of what was emitted. Never throws.
 */
export async function collectDelegateAcks(params: {
	directory: string;
	prompt: string;
	transcript: string;
	agent: string;
	sessionId?: string;
	taskId?: string;
}): Promise<CollectDelegateAcksResult> {
	const result: CollectDelegateAcksResult = {
		emitted: [],
		unacknowledgedCriticals: [],
		unacknowledgedNonCritical: [],
	};
	try {
		const shown = parseDelegateDirectiveBlock(params.prompt);
		if (shown.length === 0) return result;

		const shownById = new Map(shown.map((d) => [d.id, d]));
		const criticalIds = shown
			.filter((d) => d.priority === 'critical')
			.map((d) => d.id);

		const acks = parseAcknowledgments(params.transcript);
		const ackedIds = new Set<string>();
		const violatedIds = new Set<string>();
		const sessionId = params.sessionId ?? 'unknown';
		const taskId = params.taskId ?? extractTaskId(params.prompt);
		// (#1849 RC-4/R2) Recover the ORIGINAL retrieval trace_id from the
		// directive block instead of minting an untied one. This links ack events
		// back to the delegate retrieval's `retrieved` event, which the shared
		// receipt validator requires (trace-existence + cited-ID membership). Fall
		// back to a fresh trace only for legacy prompts without the trace header.
		const recoveredTraceId = parseDelegateDirectiveTraceId(params.prompt);
		const traceId = recoveredTraceId ?? newTraceId();
		// (#PRR-008) Legacy prompts (no trace_id header) have no matching `retrieved`
		// event, so validateReceipt would ALWAYS return trace_not_found and drop
		// every ack — then the unacknowledged-critical loop would falsely escalate
		// criticals the delegate DID ack. For legacy prompts, skip validation and
		// emit acks directly (the pre-#1849 behavior). Validation only applies when
		// a real directive-block trace_id was recovered.
		const isLegacyPrompt = recoveredTraceId === undefined;

		// (#1849 R2) Build the candidate items (one per acknowledged shown
		// directive) and route them through the SHARED validator so the ack path
		// gets the same trace-existence / session / idempotency / conflict
		// guarantees as the knowledge_receipt tool. Anti-spoofing (only-shown
		// IDs) is preserved by filtering to shownById before validating.
		const ackItems: ReceiptItem[] = [];
		const ackByItemId = new Map<
			string,
			{ id: string; result: string; reason?: string }
		>();
		for (const ack of acks) {
			// Anti-spoofing: only honor acks for directives that were actually shown.
			if (!shownById.has(ack.id)) continue;
			// Only terminal outcomes the validator accepts are routed; others
			// (e.g. 'acknowledged') fall through to direct emit below for compat.
			if (
				ack.result === 'applied' ||
				ack.result === 'ignored' ||
				ack.result === 'violated' ||
				ack.result === 'n_a' ||
				ack.result === 'contradicted'
			) {
				ackItems.push({ id: ack.id, outcome: ack.result, reason: ack.reason });
				ackByItemId.set(ack.id, ack);
			}
		}

		// (#PRR-003) Track emitted event_ids per knowledge_id for the
		// PromotionEvidenceRecord pairing (applied/violated/contradicted only).
		const eventIdByKnowledgeId = new Map<string, string>();

		if (isLegacyPrompt) {
			// (#PRR-008) Legacy path: emit acks directly without validation
			// (no trace to validate against). Anti-spoofing (shownById) still holds.
			for (const ack of acks) {
				if (!shownById.has(ack.id)) continue;
				if (!ackByItemId.has(ack.id)) continue;
				ackedIds.add(ack.id);
				const written = await recordKnowledgeEvent(params.directory, {
					type: ack.result,
					trace_id: traceId,
					knowledge_id: ack.id,
					session_id: sessionId,
					task_id: taskId,
					agent: params.agent,
					reason: ack.reason,
				});
				if (written?.event_id)
					eventIdByKnowledgeId.set(ack.id, written.event_id);
				if (ack.result === 'violated') violatedIds.add(ack.id);
				result.emitted.push({ id: ack.id, type: ack.result });
			}
		} else {
			const validation = await validateReceipt({
				directory: params.directory,
				trace_id: traceId,
				session_id: sessionId,
				task_id: taskId,
				agent: params.agent,
				items: ackItems,
				no_relevant_knowledge: false,
			});

			if (validation.ok) {
				for (const item of validation.accepted) {
					const ack = ackByItemId.get(item.id);
					if (!ack) continue;
					ackedIds.add(item.id);
					const written = await recordKnowledgeEvent(params.directory, {
						type: item.outcome,
						trace_id: traceId,
						knowledge_id: item.id,
						session_id: sessionId,
						task_id: taskId,
						agent: params.agent,
						reason: ack.reason,
					});
					if (written?.event_id)
						eventIdByKnowledgeId.set(item.id, written.event_id);
					if (item.outcome === 'violated') violatedIds.add(item.id);
					result.emitted.push({ id: item.id, type: item.outcome });
				}
				// Idempotent skips: already recorded with the same outcome — do not
				// re-emit or double-count, but mark them acked so the unacknowledged
				// escalation below does not flag them.
				for (const item of validation.idempotent_skips) {
					ackedIds.add(item.id);
				}
				// Partial rejection (ok:true can still carry rejected_items, e.g. a
				// duplicate_conflicting_terminal when the delegate also filed a
				// knowledge_receipt under the same trace): the delegate DID respond
				// for these ids, so they are neither silent (`unacknowledged`) nor
				// an unacknowledged critical. The validator already audited the
				// rejection; we only preserve the acked set.
				for (const rejected of validation.rejected_items ?? []) {
					ackedIds.add(rejected.item.id);
				}
			}
			// (#PRR-008) If validation did NOT succeed (ok:false) on a REAL trace, the
			// ackedItems the delegate DID explicitly acknowledge (ackByItemId) are
			// still treated as acked for the unacknowledged-critical loop below — a
			// transient validation failure must not falsely escalate a critical the
			// delegate explicitly acknowledged. We do not emit terminals (the
			// validator audited the rejection), but we preserve the acked set.
			if (!validation.ok) {
				for (const id of ackByItemId.keys()) {
					ackedIds.add(id);
				}
			}
		}

		// (#PRR-003) Write PromotionEvidenceRecords for the delegate-ack path's
		// accepted applied/violated/contradicted items, mirroring the
		// knowledge_receipt tool so the dominant delegate-application path feeds
		// evaluatePromotionPolicy. Cohort id resolved once-bounded + cached.
		try {
			const cohortId = await ensureCohortIdCached(params.directory, sessionId);
			const linkId = readLinkPointer(params.directory)?.linkId;
			const now = new Date().toISOString();
			const evidenceRecords: PromotionEvidenceRecord[] = [];
			for (const [kid, eid] of eventIdByKnowledgeId) {
				// Find the outcome for this knowledge_id from the emitted acks.
				const ack = ackByItemId.get(kid);
				if (!ack || !cohortId) continue;
				const outcome = ack.result;
				if (
					outcome !== 'applied' &&
					outcome !== 'violated' &&
					outcome !== 'contradicted'
				) {
					continue;
				}
				evidenceRecords.push({
					cohort_id: cohortId,
					source_link_id: linkId,
					entry_id: kid,
					retrieval_trace_id: traceId,
					receipt_outcome: outcome,
					receipt_event_id: eid,
					phase: undefined,
					timestamp: now,
				});
			}
			await appendPromotionEvidence(params.directory, evidenceRecords);
		} catch {
			/* non-blocking — evidence is a derived consumer */
		}

		// Any critical that was shown but never acknowledged is a contract
		// violation: record it as violated/unacknowledged and audit it.
		for (const id of criticalIds) {
			if (ackedIds.has(id)) continue;
			result.unacknowledgedCriticals.push(id);
			await recordKnowledgeEvent(params.directory, {
				type: 'violated',
				trace_id: traceId,
				knowledge_id: id,
				session_id: sessionId,
				task_id: taskId,
				agent: params.agent,
				reason: 'unacknowledged',
			});
			violatedIds.add(id);
			result.emitted.push({ id, type: 'violated' });
			try {
				await appendUnacknowledgedCritical(params.directory, {
					timestamp: new Date().toISOString(),
					knowledge_id: id,
					agent: params.agent,
					session_id: sessionId,
					task_id: taskId,
					reason: 'unacknowledged',
				});
			} catch {
				// audit log is best-effort
			}
		}

		// Every NON-critical directive that was shown but never acknowledged is
		// silence, not a violation: the ack contract only obliges the delegate to
		// answer for criticals. Before this, that silence was completely invisible —
		// a corpus with 1 critical out of 103 entries reported ~4% receipt
		// compliance and no signal explained the other 96%. Emit a neutral,
		// audit-only `unacknowledged` event so the curator post-mortem can say
		// "entry X: shown N times, unacknowledged M times".
		//
		// Deliberately NOT done here (each would turn an observation into a verdict):
		//   - no escalation (`violatedIds` is untouched — see the escalator call below),
		//   - no PromotionEvidenceRecord (that block ran above and only pairs
		//     accepted applied/violated/contradicted terminals),
		//   - no append to `unacknowledged-criticals.jsonl` (criticals-only file).
		//
		// Iterating `shownById` (a Map keyed by id) rather than the `shown` array
		// makes this duplicate-immune if a block ever renders the same id twice.
		// Silence is the dominant case, so the whole batch goes through ONE lock
		// acquisition + cap-trim pass (recordKnowledgeEventsBatch) instead of up
		// to `delegate_max_inject_count` sequential appends on this awaited
		// tool.execute.after path.
		const silentEvents: KnowledgeEventInput[] = [];
		for (const [id, directive] of shownById) {
			if (directive.priority === 'critical') continue;
			if (ackedIds.has(id)) continue;
			result.unacknowledgedNonCritical.push(id);
			silentEvents.push({
				type: 'unacknowledged',
				trace_id: traceId,
				knowledge_id: id,
				session_id: sessionId,
				task_id: taskId,
				agent: params.agent,
				source: 'delegate',
				reason: 'no_ack_marker',
			});
			result.emitted.push({ id, type: 'unacknowledged' });
		}
		if (silentEvents.length > 0) {
			await recordKnowledgeEventsBatch(params.directory, silentEvents);
		}

		// Repeat-mistake escalation (Change 3): after all violated events are
		// persisted, escalate any directive that crossed the repeat threshold.
		if (violatedIds.size > 0) {
			await escalateViolatedEntries(params.directory, [...violatedIds]);
		}
	} catch {
		// fail-open
	}
	return result;
}

/**
 * `tool.execute.after` adapter. Reconciles delegate acks for a completed Task.
 */
export async function collectDelegateAcksAfter(
	directory: string,
	input: DelegateAckInput,
	output: DelegateAckOutput,
): Promise<void> {
	if (!isTaskTool(input.tool)) return;
	const argsRecord =
		input.args && typeof input.args === 'object'
			? (input.args as Record<string, unknown>)
			: null;
	const prompt =
		argsRecord && typeof argsRecord.prompt === 'string'
			? argsRecord.prompt
			: '';
	if (!prompt) return;
	const transcript = typeof output.output === 'string' ? output.output : '';
	if (!transcript) return;

	// Attribute receipts to the delegate (subagent_type), not the architect caller.
	const parsed = parseDelegationArgs(input.args);
	const agent = parsed?.targetAgent ?? 'unknown';
	const sessionId =
		typeof input.sessionID === 'string' ? input.sessionID : undefined;

	await collectDelegateAcks({
		directory,
		prompt,
		transcript,
		agent,
		sessionId,
	});
}
