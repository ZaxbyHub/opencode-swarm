/**
 * Reviewer DIRECTIVE_COMPLIANCE parsing + reconciliation (Swarm Learning System,
 * Change 2 / Task 2.3).
 *
 * Parses a reviewer's `DIRECTIVE_COMPLIANCE` block (VERIFIED / VIOLATED / N/A
 * lines) and reconciles it against the set of directives the reviewer was asked
 * to verify, emitting one receipt event per directive (tagged source:'reviewer'):
 *
 *   VERIFIED:<id>  → type:'applied'   (verified === honored)
 *   VIOLATED:<id>  → type:'violated'  (+ run any verification_predicate)
 *   N/A:<id>       → type:'n_a'        (neutral)
 *
 * Anti-spoofing: verdicts for IDs that were not in the verify-set are dropped.
 * A CRITICAL directive the reviewer never addressed gets a synthetic
 * `violated` / `reviewer_omitted` event. Fail-open: never throws.
 */

import {
	type DirectiveToVerify,
	parseDirectivesToVerifyBlock,
} from '../agents/reviewer-directive-compliance.js';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { runDirectivePredicate } from '../services/directive-predicate-runner.js';
import { escalateViolatedEntries } from './knowledge-escalator.js';
import { newTraceId, recordKnowledgeEvent } from './knowledge-events.js';
import { parseDelegationArgs } from './skill-propagation-gate.js';

export type ReviewerVerdict = 'verified' | 'violated' | 'n_a';

export interface ParsedReviewerVerdict {
	id: string;
	verdict: ReviewerVerdict;
	/** evidence=... (VERIFIED/VIOLATED) or reason=... (N/A). */
	evidence?: string;
}

// VERIFIED:<id> evidence=...
// VIOLATED:<id> evidence=...
// N/A:<id> reason=...
// IDs are permissive (UUIDs or human ids); evidence/reason runs to end-of-line.
const VERDICT_PATTERN =
	/\b(VERIFIED|VIOLATED|N\/A)\s*:\s*([A-Za-z0-9._-]{1,80})(?:\s+(?:evidence|reason)\s*=\s*([^\n\r]+?))?(?=$|[\n\r]|\s+(?:VERIFIED|VIOLATED|N\/A)\b)/gi;

/** Parse a reviewer transcript's DIRECTIVE_COMPLIANCE verdict lines. */
export function parseReviewerDirectiveCompliance(
	text: string,
): ParsedReviewerVerdict[] {
	if (!text || typeof text !== 'string') return [];
	const out: ParsedReviewerVerdict[] = [];
	for (const m of text.matchAll(VERDICT_PATTERN)) {
		const verb = m[1].toUpperCase();
		const id = m[2];
		const evidence = m[3]?.trim().slice(0, 280);
		const verdict: ReviewerVerdict =
			verb === 'VERIFIED'
				? 'verified'
				: verb === 'VIOLATED'
					? 'violated'
					: 'n_a';
		out.push({ id, verdict, evidence });
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
	emitted: Array<{ id: string; type: string; source: 'reviewer' }>;
	omittedCriticals: string[];
}

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
	};
	try {
		const verifyById = new Map(params.directivesToVerify.map((d) => [d.id, d]));
		if (verifyById.size === 0) return result;

		const verdicts = parseReviewerDirectiveCompliance(params.transcript);
		const addressed = new Set<string>();
		const violatedIds = new Set<string>();
		const traceId = newTraceId();
		const sessionId = params.sessionId ?? 'unknown';
		const agent = params.agent ?? 'reviewer';

		for (const v of verdicts) {
			const directive = verifyById.get(v.id);
			// Anti-spoofing: only honor verdicts for directives in the verify-set.
			if (!directive) continue;
			addressed.add(v.id);
			const type = verdictToEventType(v.verdict);

			let predicateCheck:
				| {
						predicate: string;
						result: 'pass' | 'fail' | 'error';
						detail: string;
				  }
				| undefined;
			// When the reviewer reports a violation and the directive ships a
			// predicate, execute it and persist the machine result alongside.
			if (v.verdict === 'violated' && directive.verification_predicate) {
				const outcome = await runDirectivePredicate(
					directive.verification_predicate,
					params.directory,
				);
				predicateCheck = {
					predicate: directive.verification_predicate,
					result: outcome.result,
					detail: outcome.detail,
				};
			}

			await recordKnowledgeEvent(params.directory, {
				type,
				trace_id: traceId,
				knowledge_id: v.id,
				session_id: sessionId,
				task_id: params.taskId,
				phase: params.phase,
				agent,
				source: 'reviewer',
				reason: v.evidence,
				predicate_check: predicateCheck,
			});
			if (type === 'violated') violatedIds.add(v.id);
			result.emitted.push({ id: v.id, type, source: 'reviewer' });
		}

		// A CRITICAL directive the reviewer never addressed is a verdict gap:
		// synthesize a violated/reviewer_omitted event so the gate sees it.
		for (const d of params.directivesToVerify) {
			if (d.priority !== 'critical') continue;
			if (addressed.has(d.id)) continue;
			result.omittedCriticals.push(d.id);
			await recordKnowledgeEvent(params.directory, {
				type: 'violated',
				trace_id: traceId,
				knowledge_id: d.id,
				session_id: sessionId,
				task_id: params.taskId,
				phase: params.phase,
				agent,
				source: 'reviewer',
				reason: 'reviewer_omitted',
			});
			violatedIds.add(d.id);
			result.emitted.push({ id: d.id, type: 'violated', source: 'reviewer' });
		}

		// Repeat-mistake escalation (Change 3): escalate any directive that
		// crossed the repeat-violation threshold after these verdicts.
		if (violatedIds.size > 0) {
			await escalateViolatedEntries(params.directory, [...violatedIds]);
		}
	} catch {
		// fail-open
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
