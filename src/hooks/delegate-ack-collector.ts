/**
 * Delegate ack collection (Swarm Learning System, Change 1 / Task 1.5).
 *
 * A `tool.execute.after` hook on the `Task` tool. After a delegated subagent
 * returns, this reconciles the directives that were shown to it (recovered by
 * parsing the `<delegate_knowledge_directives>` block out of the delegation
 * prompt) against the ack markers in the subagent's transcript:
 *
 *   - For every ack whose ID was actually shown, emit a receipt event of the
 *     matching type (applied / ignored / contradicted / violated / n_a). Acks for IDs that were
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
 *
 * Issue #2045: the reconciliation itself lives in {@link reconcileShownDirectives}
 * so lane collections (`collectLaneDelegateAcks`, keyed by the lane session's
 * durable `delegate_directive` memberships) and Task collections share ONE
 * implementation — not a second lifecycle copy.
 */

import { resolveRetentionCap } from '../retention/caps.js';
import { appendCappedJsonl } from '../retention/jsonl-cap.js';
import { ensureCohortIdCached } from './cohort-cache.js';
import { parseAcknowledgments } from './knowledge-application.js';
import { escalateViolatedEntries } from './knowledge-escalator.js';
import {
	type KnowledgeEventInput,
	recordKnowledgeEvent,
	recordKnowledgeEventsBatch,
} from './knowledge-events.js';
import {
	parseDelegateDirectiveBlock,
	parseDelegateDirectiveTraceId,
} from './knowledge-injector.js';
import { readLinkPointer } from './knowledge-link.js';
import {
	queryLiveMemberships,
	type ReceiptMembership,
	validateAndCommitTerminalBatch,
} from './knowledge-receipt-ledger.js';
import {
	type ReceiptItem,
	validateReceipt,
} from './knowledge-receipt-validator.js';
import type { PromotionEvidenceRecord } from './knowledge-types.js';
import {
	loadPlanTaskIdContext,
	toTaskIdPlanContextOptions,
} from './plan-task-id-context.js';
import { appendPromotionEvidence } from './promotion-evidence-store.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';
import { resolveTaskId, type TaskIdResolution } from './task-id-resolver.js';
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
export function resolveDelegateAckTaskId(
	args: Record<string, unknown>,
	knownPlanTaskIds?: ReadonlySet<string>,
	planContextOverLimit = false,
): string | undefined {
	const resolved = resolveDelegateAckTaskIdResult(
		args,
		knownPlanTaskIds,
		planContextOverLimit,
	);
	return resolved.status === 'resolved' ? resolved.taskId : undefined;
}

function resolveDelegateAckTaskIdResult(
	args: Record<string, unknown>,
	knownPlanTaskIds?: ReadonlySet<string>,
	planContextOverLimit = false,
): TaskIdResolution {
	return resolveTaskId(args, {
		policy: 'attribution',
		knownPlanTaskIds,
		planContextOverLimit,
	});
}

/**
 * Global FIFO cap on the unacknowledged-criticals audit stream (issue #2483
 * §2). Enforcement resolves the effective value through `resolveRetentionCap`
 * so the #2483 acceptance checks can shrink the cap below this default and
 * prove the writer clamps.
 */
export const MAX_UNACKNOWLEDGED_CRITICALS = 500;

/**
 * Append an unacknowledged-critical audit line. Path is validated to stay inside
 * `.swarm/`. Best-effort: errors are swallowed by the caller. The append is
 * capped FIFO via `appendCappedJsonl` (append + crash-atomic compaction), so
 * the audit stream is globally bounded (issue #2483).
 */
async function appendUnacknowledgedCritical(
	directory: string,
	record: Record<string, unknown>,
): Promise<void> {
	const filePath = validateSwarmPath(
		directory,
		'unacknowledged-criticals.jsonl',
	);
	await appendCappedJsonl(filePath, JSON.stringify(record), {
		maxEntries: resolveRetentionCap(
			'MAX_UNACKNOWLEDGED_CRITICALS',
			MAX_UNACKNOWLEDGED_CRITICALS,
		),
	});
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
	/** Typed authority failure: no V2 mutation was attempted. */
	unverifiable?: {
		code: 'missing_session_id';
		detail: string;
	};
}

/** A directive proven shown to a delegate, with the priority it was shown at. */
export interface ShownDirective {
	id: string;
	priority: string;
}

export interface ReconcileShownDirectivesParams {
	directory: string;
	/** Directives proven shown (anti-spoofing scope); never trust the ack list. */
	shown: readonly ShownDirective[];
	/**
	 * Retrieval trace the directives were shown under. `undefined` marks a
	 * legacy unverifiable prompt (pre-#1849): no receipt validation, no
	 * terminals, no fabricated trace.
	 */
	traceId?: string;
	transcript: string;
	agent: string;
	/** Host session the shown-set membership is bound to (V2 authority). */
	sessionId: string;
	taskId?: string;
	/**
	 * Replay mode (issue #2045 crash recovery): the AUTHORITATIVE receipts
	 * (validator/ledger-committed ACK terminals, unacknowledged-critical
	 * violations) still run — the ledger dedupes them — but the audit-only
	 * `unacknowledged` NON-critical observation is exactly-once-at-emit (it
	 * bypasses the ledger and would double-append on replay).
	 */
	replay?: boolean;
}

/**
 * Shared reconciliation core (issue #2045): reconcile a proven-shown directive
 * set against the ack markers in a transcript. Used by the Task
 * `tool.execute.after` adapter (shown-set parsed from the delegation prompt)
 * and by lane terminal observations (shown-set from the receipt ledger's
 * session-bound `delegate_directive` memberships). Returns a summary of what
 * was emitted. Never throws.
 */
export async function reconcileShownDirectives(
	params: ReconcileShownDirectivesParams,
): Promise<CollectDelegateAcksResult> {
	const result: CollectDelegateAcksResult = {
		emitted: [],
		unacknowledgedCriticals: [],
		unacknowledgedNonCritical: [],
	};
	try {
		const shown = params.shown;
		if (shown.length === 0) return result;

		const shownById = new Map(shown.map((d) => [d.id, d]));
		const criticalIds = shown
			.filter((d) => d.priority === 'critical')
			.map((d) => d.id);

		const acks = parseAcknowledgments(params.transcript);
		const ackedIds = new Set<string>();
		const violatedIds = new Set<string>();
		const sessionId = params.sessionId;
		const taskId = params.taskId;
		// Original trace identity: the recovered trace, or the legacy-unverifiable
		// tombstone value legacy prompts have always carried on their (audit-only)
		// `unacknowledged` events.
		const traceId = params.traceId ?? 'legacy-unverifiable';
		// (#PRR-008) Legacy prompts (no trace_id header) have no matching `retrieved`
		// event, so validateReceipt would ALWAYS return trace_not_found and drop
		// every ack — then the unacknowledged-critical loop would falsely escalate
		// criticals the delegate DID ack. For legacy prompts, skip validation and
		// emit acks directly (the pre-#1849 behavior). Validation only applies when
		// a real directive-block trace_id was recovered.
		const isLegacyPrompt = params.traceId === undefined;
		let cohortId: string | undefined;
		let linkId: string | undefined;
		try {
			cohortId = await ensureCohortIdCached(params.directory, sessionId);
			linkId = readLinkPointer(params.directory)?.linkId;
		} catch {
			// Cohort correlation is optional; receipt authority remains project-local.
		}

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
			// Preserve explicit-ACK mitigation even when correlation is malformed:
			// silence must not be fabricated for an ID the delegate did mention.
			// Authority is stricter: a V2 terminal is eligible only when the marker
			// cites the exact trace carried by this prompt.
			ackedIds.add(ack.id);
			if (!isLegacyPrompt && ack.trace_id !== traceId) continue;
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
			// Issue #2031: a legacy prompt has no provable retrieval membership.
			// Preserve explicit ACK presence so it is not mislabeled unacknowledged,
			// but do not fabricate a trace, terminal, or promotion credit.
			for (const ack of acks) {
				if (!shownById.has(ack.id)) continue;
				if (!ackByItemId.has(ack.id)) continue;
				ackedIds.add(ack.id);
			}
		} else {
			const validation = await validateReceipt({
				directory: params.directory,
				trace_id: traceId,
				session_id: sessionId,
				task_id: taskId,
				agent: params.agent,
				// (#2032) Delegate self-acks are delegate-sourced terminals; the
				// agent identity stays in `agent`. Never derive source from agent.
				source: 'delegate',
				cohort_id: cohortId,
				source_link_id: linkId,
				items: ackItems,
				no_relevant_knowledge: false,
			});

			if (validation.ok) {
				for (const item of validation.accepted) {
					const ack = ackByItemId.get(item.id);
					if (!ack) continue;
					ackedIds.add(item.id);
					await recordKnowledgeEvent(params.directory, {
						type: item.outcome,
						trace_id: traceId,
						knowledge_id: item.id,
						session_id: sessionId,
						task_id: taskId,
						agent: params.agent,
						source: 'delegate',
						reason: ack.reason,
					});
					const authoritativeEventId =
						validation.authoritative_event_ids[item.id];
					if (authoritativeEventId) {
						eventIdByKnowledgeId.set(item.id, authoritativeEventId);
					}
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
					// (#2032 F-003) Delegate-ack evidence is a self-report; the
					// promotion gate treats source 'delegate' as non-independent.
					receipt_source: 'delegate',
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
		// violation. Persist the authoritative V2 batch first; only committed
		// pairs receive diagnostics, promotion/escalation, or audit projections.
		const missingCriticalIds = criticalIds.filter((id) => !ackedIds.has(id));
		let committedMissingCriticalIds = new Set<string>();
		if (!isLegacyPrompt && missingCriticalIds.length > 0) {
			const committed = await validateAndCommitTerminalBatch(params.directory, {
				trace_id: traceId,
				session_id: sessionId,
				task_id: taskId,
				agent: params.agent,
				cohort_id: cohortId,
				source_link_id: linkId,
				items: missingCriticalIds.map((entry_id) => ({
					entry_id,
					outcome: 'violated' as const,
					source: 'delegate',
					reason: 'unacknowledged',
				})),
			});
			if (committed.ok) {
				committedMissingCriticalIds = new Set(
					committed.committed.map((item) => item.entry_id),
				);
			}
		}
		for (const id of missingCriticalIds) {
			if (!committedMissingCriticalIds.has(id)) continue;
			result.unacknowledgedCriticals.push(id);
			await recordKnowledgeEvent(params.directory, {
				type: 'violated',
				trace_id: traceId,
				knowledge_id: id,
				session_id: sessionId,
				task_id: taskId,
				agent: params.agent,
				source: 'delegate',
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
			if (params.replay === true) continue;
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
	/** A caller-owned resolution attempt; non-resolved states forbid reparsing. */
	taskIdResolution?: TaskIdResolution;
}): Promise<CollectDelegateAcksResult> {
	const shown = parseDelegateDirectiveBlock(params.prompt);
	if (shown.length === 0) {
		return {
			emitted: [],
			unacknowledgedCriticals: [],
			unacknowledgedNonCritical: [],
		};
	}
	const sessionId = params.sessionId;
	if (!sessionId) {
		return {
			emitted: [],
			unacknowledgedCriticals: [],
			unacknowledgedNonCritical: [],
			unverifiable: {
				code: 'missing_session_id',
				detail: 'Delegate acknowledgments require a real host session id',
			},
		};
	}
	// (#1849 RC-4/R2) Recover the ORIGINAL retrieval trace_id from the
	// directive block instead of minting an untied one. This links ack events
	// back to the delegate retrieval's `retrieved` event, which the shared
	// receipt validator requires (trace-existence + cited-ID membership). Fall
	// back to a fresh trace only for legacy prompts without the trace header.
	const traceId = parseDelegateDirectiveTraceId(params.prompt) ?? undefined;
	const taskId = params.taskIdResolution
		? params.taskIdResolution.status === 'resolved'
			? params.taskIdResolution.taskId
			: undefined
		: // Legacy explicit fallback for callers that do not provide
			// taskIdResolution.
			(params.taskId ?? resolveDelegateAckTaskId({ prompt: params.prompt }));
	return reconcileShownDirectives({
		directory: params.directory,
		shown,
		traceId,
		transcript: params.transcript,
		agent: params.agent,
		sessionId,
		taskId,
	});
}

export interface CollectLaneDelegateAcksResult
	extends CollectDelegateAcksResult {
	/**
	 * Phases recorded on the lane session's `delegate_directive` memberships
	 * (issue #2045). The reviewer verdict reconciliation windows by this phase.
	 */
	phases: string[];
}

/**
 * Lane-side delegate-ack reconciliation (issue #2045). Task delegations are
 * reconciled by the `tool.execute.after` hook; lane outputs never pass through
 * that hook, so this variant derives the proven-shown set from the receipt
 * ledger's session-bound `delegate_directive` memberships — the durable record
 * of exactly what the transform-path injector displayed to the lane session —
 * and runs the SAME shared core. Idempotent per trace: replayed settlements
 * hit the validator's idempotency, never double terminals.
 *
 * `sessionId` MUST be the lane SUBAGENT session id (memberships bind to the
 * child session); a parent-session id queries zero rows by design.
 */
export async function collectLaneDelegateAcks(params: {
	directory: string;
	sessionId: string;
	agent: string;
	transcript: string;
	/**
	 * Replay mode (issue #2045 crash recovery): set by the lifecycle module's
	 * duplicate-settle path so the ledger-committed receipts still close while
	 * the audit-only non-critical observation stays exactly-once-at-emit.
	 */
	replay?: boolean;
}): Promise<CollectLaneDelegateAcksResult> {
	const empty: CollectLaneDelegateAcksResult = {
		emitted: [],
		unacknowledgedCriticals: [],
		unacknowledgedNonCritical: [],
		phases: [],
	};
	try {
		const memberships = await queryLiveMemberships(params.directory, {
			session_id: params.sessionId,
			exposure_kind: 'delegate_directive',
			include_terminal: true,
		});
		if (!memberships.ok) return empty;
		const byTrace = new Map<string, ReceiptMembership[]>();
		const phases = new Set<string>();
		for (const membership of memberships.memberships) {
			const group = byTrace.get(membership.trace_id) ?? [];
			group.push(membership);
			byTrace.set(membership.trace_id, group);
			if (membership.phase) phases.add(membership.phase);
		}
		const combined: CollectDelegateAcksResult = {
			emitted: [],
			unacknowledgedCriticals: [],
			unacknowledgedNonCritical: [],
		};
		for (const [traceId, group] of byTrace) {
			const taskId = group.find((m) => m.task_id)?.task_id;
			const outcome = await reconcileShownDirectives({
				directory: params.directory,
				shown: group.map((m) => ({
					id: m.entry_id,
					// The membership's `critical` flag is the authoritative
					// priority the injector computed at display time
					// (`directive_priority === 'critical' && isActiveStatus`).
					priority: m.critical ? 'critical' : 'medium',
				})),
				traceId,
				transcript: params.transcript,
				agent: params.agent,
				sessionId: params.sessionId,
				taskId,
				replay: params.replay,
			});
			combined.emitted.push(...outcome.emitted);
			combined.unacknowledgedCriticals.push(...outcome.unacknowledgedCriticals);
			combined.unacknowledgedNonCritical.push(
				...outcome.unacknowledgedNonCritical,
			);
			if (outcome.unverifiable) combined.unverifiable = outcome.unverifiable;
		}
		return { ...combined, phases: [...phases] };
	} catch {
		// fail-open — store unavailable (e.g. repair uncertainty) or worse; the
		// lane settle path must never break on reconciliation.
		return empty;
	}
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

	const planTaskIdOptions = toTaskIdPlanContextOptions(
		await loadPlanTaskIdContext(directory),
	);
	const taskIdResolution = resolveDelegateAckTaskIdResult(
		argsRecord ?? { prompt },
		planTaskIdOptions.knownPlanTaskIds,
		planTaskIdOptions.planContextOverLimit,
	);
	await collectDelegateAcks({
		directory,
		prompt,
		transcript,
		agent,
		sessionId,
		taskIdResolution,
	});
}
