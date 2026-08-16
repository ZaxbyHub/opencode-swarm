/**
 * Reviewer DIRECTIVE_COMPLIANCE parsing + reconciliation (Swarm Learning System,
 * Change 2 / Task 2.3).
 *
 * Parses a reviewer's `DIRECTIVE_COMPLIANCE` block (VERIFIED / VIOLATED / N/A
 * lines) and reconciles it against the exact retrieval memberships the reviewer
 * was asked to verify, committing one authoritative terminal per pair:
 *
 *   VERIFIED:<trace_id>:<entry_id> -> outcome:'applied'
 *   VIOLATED:<trace_id>:<entry_id> -> outcome:'violated'
 *   N/A:<trace_id>:<entry_id>      -> outcome:'n_a'
 *
 * Anti-spoofing: verdicts for pairs that were not in the verify-set are dropped.
 * An omitted CRITICAL pair gets a `violated` / `reviewer_omitted` terminal.
 * Authority failures return typed uncertainty and never fabricate success.
 */

import {
	type DirectiveToVerify,
	decodeDirectiveCorrelationId,
	parseDirectivesToVerifyBlock,
} from '../agents/reviewer-directive-compliance.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { runDirectivePredicate } from '../services/directive-predicate-runner.js';
import { escalateViolatedEntries } from './knowledge-escalator.js';
import { recordKnowledgeEvent } from './knowledge-events.js';
import { validateAndCommitTerminalBatch } from './knowledge-receipt-ledger.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';

/** Narrow dependency seam for isolated reconciliation ordering tests. */
export const _internals = {
	validateAndCommitTerminalBatch,
	recordKnowledgeEvent,
	runDirectivePredicate,
	escalateViolatedEntries,
};

export type ReviewerVerdict = 'verified' | 'violated' | 'n_a';

export interface ParsedReviewerVerdict {
	trace_id: string;
	entry_id: string;
	verdict: ReviewerVerdict;
	/** evidence=... (VERIFIED/VIOLATED) or reason=... (N/A). */
	evidence?: string;
}

// Correlation tokens are URI-encoded by the prompt renderer, so ':' remains a
// safe pair delimiter even when either underlying identifier contains one.
// Evidence/reason runs to end-of-line or the next verdict on the same line.
const VERDICT_PATTERN =
	/\b(VERIFIED|VIOLATED|N\/A)\s*:\s*([^:\s]{1,512})\s*:\s*([^:\s]{1,512})(?:\s+(?:evidence|reason)\s*=\s*([^\n\r]+?))?(?=$|[\n\r]|\s+(?:VERIFIED|VIOLATED|N\/A)\b)/gi;

/** Parse a reviewer transcript's DIRECTIVE_COMPLIANCE verdict lines. */
export function parseReviewerDirectiveCompliance(
	text: string,
): ParsedReviewerVerdict[] {
	if (!text || typeof text !== 'string') return [];
	const out: ParsedReviewerVerdict[] = [];
	for (const m of text.matchAll(VERDICT_PATTERN)) {
		const verb = m[1].toUpperCase();
		const traceId = decodeDirectiveCorrelationId(m[2]);
		const entryId = decodeDirectiveCorrelationId(m[3]);
		if (!traceId || !entryId) continue;
		const evidence = m[4]?.trim().slice(0, 280);
		const verdict: ReviewerVerdict =
			verb === 'VERIFIED'
				? 'verified'
				: verb === 'VIOLATED'
					? 'violated'
					: 'n_a';
		out.push({ trace_id: traceId, entry_id: entryId, verdict, evidence });
	}
	return out;
}

/** Map a reviewer verdict to the receipt event type used by the rollup. */
function verdictToEventType(
	v: ReviewerVerdict,
): 'applied' | 'violated' | 'n_a' {
	return v === 'verified' ? 'applied' : v === 'violated' ? 'violated' : 'n_a';
}

export interface ReconcileReviewerVerdictsParams {
	directory: string;
	transcript: string;
	directivesToVerify: DirectiveToVerify[];
	sessionId?: string;
	taskId?: string;
	phase?: string;
	agent?: string;
}

export interface ReconcileReviewerVerdictsResult {
	emitted: Array<{
		trace_id: string;
		entry_id: string;
		/** Legacy diagnostic alias. */
		id: string;
		type: string;
		source: 'reviewer';
	}>;
	omittedCriticals: Array<{ trace_id: string; entry_id: string }>;
	uncertainties: Array<{
		trace_id: string;
		entry_id?: string;
		code: string;
		uncertainty?: unknown;
	}>;
}

function pairKey(traceId: string, entryId: string): string {
	return JSON.stringify([traceId, entryId]);
}

type PendingTerminal = {
	directive: DirectiveToVerify;
	type: 'applied' | 'violated' | 'n_a';
	reason?: string;
	predicate_check?: {
		predicate: string;
		result: 'pass' | 'fail' | 'error';
		detail: string;
	};
};

/**
 * Reconcile reviewer verdicts against the verify-set and emit receipt events.
 * Runs a directive's verification_predicate when the reviewer reports VIOLATED
 * and the directive carries one. Never throws.
 */
export async function reconcileReviewerVerdicts(
	params: ReconcileReviewerVerdictsParams,
): Promise<ReconcileReviewerVerdictsResult> {
	const result: ReconcileReviewerVerdictsResult = {
		emitted: [],
		omittedCriticals: [],
		uncertainties: [],
	};
	const verifyByPair = new Map(
		params.directivesToVerify.map((d) => [pairKey(d.trace_id, d.entry_id), d]),
	);
	if (verifyByPair.size === 0) return result;

	const verdictsByPair = new Map<string, ParsedReviewerVerdict[]>();
	for (const verdict of parseReviewerDirectiveCompliance(params.transcript)) {
		const key = pairKey(verdict.trace_id, verdict.entry_id);
		if (!verifyByPair.has(key)) continue;
		const existing = verdictsByPair.get(key) ?? [];
		existing.push(verdict);
		verdictsByPair.set(key, existing);
	}

	const pending: PendingTerminal[] = [];
	for (const [key, directive] of verifyByPair) {
		const matching = verdictsByPair.get(key) ?? [];
		if (matching.length > 1) {
			result.uncertainties.push({
				trace_id: directive.trace_id,
				entry_id: directive.entry_id,
				code: 'duplicate_verdict',
				uncertainty:
					'Reviewer emitted more than one verdict for the exact pair',
			});
			continue;
		}
		if (matching.length === 0) {
			if (directive.priority !== 'critical') continue;
			result.omittedCriticals.push({
				trace_id: directive.trace_id,
				entry_id: directive.entry_id,
			});
			pending.push({
				directive,
				type: 'violated',
				reason: 'reviewer_omitted',
			});
			continue;
		}

		const verdict = matching[0];
		if (verdict.verdict === 'verified' && !verdict.evidence?.trim()) {
			// Issue #2031: VERIFIED is an authoritative applied terminal, so the
			// reviewer's contract requires concrete, bounded evidence. Preserve the
			// uncertainty and fail a critical pair closed instead of granting credit.
			result.uncertainties.push({
				trace_id: directive.trace_id,
				entry_id: directive.entry_id,
				code: 'reviewer_missing_evidence',
				uncertainty: 'VERIFIED requires nonempty evidence',
			});
			if (directive.priority === 'critical') {
				result.omittedCriticals.push({
					trace_id: directive.trace_id,
					entry_id: directive.entry_id,
				});
				pending.push({
					directive,
					type: 'violated',
					reason: 'reviewer_missing_evidence',
				});
			}
			continue;
		}
		const item: PendingTerminal = {
			directive,
			type: verdictToEventType(verdict.verdict),
			reason: verdict.evidence,
		};
		if (verdict.verdict === 'violated' && directive.verification_predicate) {
			try {
				const outcome = await _internals.runDirectivePredicate(
					directive.verification_predicate,
					params.directory,
				);
				item.predicate_check = {
					predicate: directive.verification_predicate,
					result: outcome.result,
					detail: outcome.detail,
				};
			} catch (error) {
				item.predicate_check = {
					predicate: directive.verification_predicate,
					result: 'error',
					detail: error instanceof Error ? error.message : String(error),
				};
			}
		}
		pending.push(item);
	}

	const groups = new Map<string, PendingTerminal[]>();
	for (const item of pending) {
		const groupKey = JSON.stringify([
			item.directive.trace_id,
			item.directive.session_id,
			item.directive.cohort_id,
			item.directive.source_link_id,
			item.directive.prior_terminal_outcome,
			item.directive.prior_terminal_event_id,
		]);
		const group = groups.get(groupKey) ?? [];
		group.push(item);
		groups.set(groupKey, group);
	}

	const violatedIds = new Set<string>();
	const agent = params.agent ?? 'reviewer';
	for (const group of groups.values()) {
		const first = group[0].directive;
		const remediationAuthorization =
			first.prior_terminal_outcome === 'violated' &&
			first.prior_terminal_event_id &&
			group.some((item) => item.type !== 'violated')
				? {
						actor: 'reviewer-remediation' as const,
						reason: 'reviewer_verified_remediation',
						expected_event_id: first.prior_terminal_event_id,
						expected_outcome: first.prior_terminal_outcome,
					}
				: undefined;
		let committedEntries: Set<string>;
		try {
			const committed = await _internals.validateAndCommitTerminalBatch(
				params.directory,
				{
					trace_id: first.trace_id,
					session_id: first.session_id,
					cohort_id: first.cohort_id,
					source_link_id: first.source_link_id,
					authorization: remediationAuthorization,
					items: group.map((item) => ({
						entry_id: item.directive.entry_id,
						outcome: item.type,
						source: 'reviewer',
						reason: item.reason,
					})),
				},
			);
			if (!committed.ok) {
				for (const item of group) {
					result.uncertainties.push({
						trace_id: item.directive.trace_id,
						entry_id: item.directive.entry_id,
						code: committed.code,
						uncertainty: committed.detail,
					});
				}
				continue;
			}
			committedEntries = new Set(
				committed.accepted.map((terminal) => terminal.entry_id),
			);
			for (const rejected of committed.rejected) {
				result.uncertainties.push({
					trace_id: first.trace_id,
					entry_id: rejected.entry_id || undefined,
					code: rejected.reason,
					uncertainty: 'Authoritative ledger rejected reviewer terminal',
				});
			}
		} catch (error) {
			for (const item of group) {
				result.uncertainties.push({
					trace_id: item.directive.trace_id,
					entry_id: item.directive.entry_id,
					code: 'ledger_exception',
					uncertainty: error instanceof Error ? error.message : String(error),
				});
			}
			continue;
		}

		// The authoritative batch call has returned and released its lock before
		// any best-effort legacy diagnostic event is appended.
		for (const item of group) {
			if (!committedEntries.has(item.directive.entry_id)) continue;
			try {
				await _internals.recordKnowledgeEvent(params.directory, {
					type: item.type,
					trace_id: item.directive.trace_id,
					knowledge_id: item.directive.entry_id,
					session_id: item.directive.session_id,
					task_id: params.taskId,
					phase: params.phase,
					agent,
					source: 'reviewer',
					reason: item.reason,
					predicate_check: item.predicate_check,
				});
				result.emitted.push({
					trace_id: item.directive.trace_id,
					entry_id: item.directive.entry_id,
					id: item.directive.entry_id,
					type: item.type,
					source: 'reviewer',
				});
				if (item.type === 'violated') {
					violatedIds.add(item.directive.entry_id);
				}
			} catch (error) {
				result.uncertainties.push({
					trace_id: item.directive.trace_id,
					entry_id: item.directive.entry_id,
					code: 'diagnostic_event_failed',
					uncertainty: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	if (violatedIds.size > 0) {
		try {
			await _internals.escalateViolatedEntries(params.directory, [
				...violatedIds,
			]);
		} catch (error) {
			result.uncertainties.push({
				trace_id: '',
				code: 'escalation_failed',
				uncertainty: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

// ============================================================================
// Runtime adapter
// ============================================================================

export interface ReviewerVerdictInput {
	tool: unknown;
	args?: unknown;
	sessionID?: unknown;
}

export interface ReviewerVerdictOutput {
	output?: unknown;
}

function isTaskTool(tool: unknown): boolean {
	return tool === 'Task' || tool === 'task';
}

/**
 * `tool.execute.after` adapter (Task 2.3). When a reviewer Task returns,
 * recover the verify-set from the `<directives_to_verify>` block in its prompt
 * (anti-spoofing), then reconcile the reviewer's DIRECTIVE_COMPLIANCE verdicts
 * into knowledge events. No-op for non-reviewer delegations. Never throws.
 */
export async function collectReviewerVerdictsAfter(
	directory: string,
	input: ReviewerVerdictInput,
	output: ReviewerVerdictOutput,
): Promise<void> {
	if (!isTaskTool(input.tool)) return;
	const parsedArgs = parseDelegationArgs(input.args);
	if (!parsedArgs) return;
	if (
		stripKnownSwarmPrefix(parsedArgs.targetAgent).toLowerCase() !== 'reviewer'
	) {
		return;
	}
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

	const directivesToVerify = parseDirectivesToVerifyBlock(prompt);
	if (directivesToVerify.length === 0) return;

	const sessionId =
		typeof input.sessionID === 'string' ? input.sessionID : undefined;

	await reconcileReviewerVerdicts({
		directory,
		transcript,
		directivesToVerify,
		sessionId,
		agent: 'reviewer',
	});
}
