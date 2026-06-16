/**
 * Phase-complete critical-directive gate (Swarm Learning System, Change 2 /
 * Task 2.4).
 *
 * A phase may not complete while a CRITICAL knowledge directive shown during the
 * phase lacks a terminal outcome, or carries an unremediated violation. A
 * critical directive is RESOLVED when, within the phase window, it has either:
 *   - an `applied` outcome dated at/after its latest `violated` (remediation /
 *     reviewer VERIFIED), OR
 *   - an `ignored` or `n_a` outcome WITH a reason and no later `violated`.
 * Otherwise it BLOCKS with one of:
 *   - 'no_verdict'             — no terminal outcome at all, or
 *   - 'unremediated_violation' — a violation with no later applied/verified.
 *
 * The architect may override specific IDs via `acceptViolations` (logged as an
 * `override` event with a written justification). Fail-CLOSED: any read error
 * surfaces as a block, never a silent pass.
 */

import {
	type KnowledgeEvent,
	readKnowledgeEvents,
	recordKnowledgeEvent,
} from './knowledge-events.js';
import {
	collectPhaseDirectiveIds,
	readEntriesById,
} from './phase-directives.js';

export type DirectiveBlockReason = 'no_verdict' | 'unremediated_violation';

export interface DirectiveGateResult {
	blocked: boolean;
	unresolved: Array<{ id: string; reason: DirectiveBlockReason }>;
	overridden: string[];
	/** True when the gate could not read its inputs (fail-closed → blocked). */
	failedClosed: boolean;
}

interface ReceiptLike {
	type: string;
	knowledge_id?: string;
	timestamp: string;
	reason?: string;
}

function isReceipt(e: KnowledgeEvent): e is KnowledgeEvent & ReceiptLike {
	return (
		(e.type === 'applied' ||
			e.type === 'ignored' ||
			e.type === 'n_a' ||
			e.type === 'violated') &&
		typeof (e as ReceiptLike).knowledge_id === 'string'
	);
}

/**
 * Evaluate a single critical directive's phase outcomes. `phaseStart` bounds the
 * window so prior-phase outcomes do not satisfy the current phase.
 */
function evaluateCritical(
	id: string,
	receipts: ReceiptLike[],
): DirectiveBlockReason | null {
	const mine = receipts.filter((r) => r.knowledge_id === id);
	if (mine.length === 0) return 'no_verdict';

	const latestViolation = mine
		.filter((r) => r.type === 'violated')
		.reduce<string | null>(
			(acc, r) => (acc === null || r.timestamp > acc ? r.timestamp : acc),
			null,
		);
	const latestApplied = mine
		.filter((r) => r.type === 'applied')
		.reduce<string | null>(
			(acc, r) => (acc === null || r.timestamp > acc ? r.timestamp : acc),
			null,
		);
	const hasResolvedDecision = mine.some(
		(r) =>
			(r.type === 'ignored' || r.type === 'n_a') &&
			typeof r.reason === 'string' &&
			r.reason.trim().length > 0,
	);

	if (latestViolation !== null) {
		// A violation is remediated only by an applied/verified at or after it.
		if (latestApplied !== null && latestApplied >= latestViolation) return null;
		return 'unremediated_violation';
	}
	if (latestApplied !== null) return null;
	if (hasResolvedDecision) return null;
	return 'no_verdict';
}

/**
 * Evaluate all critical directives shown during the phase. Fail-closed.
 */
export async function evaluatePhaseCriticalDirectives(params: {
	directory: string;
	phaseLabel?: string;
	acceptViolations?: string[];
}): Promise<DirectiveGateResult> {
	const accept = new Set(params.acceptViolations ?? []);
	try {
		const events = await readKnowledgeEvents(params.directory);
		// Phase window start = earliest retrieved event for the phase.
		const retrievedThisPhase = events.filter(
			(e) =>
				e.type === 'retrieved' &&
				(!params.phaseLabel || e.phase === params.phaseLabel),
		);
		const phaseStart =
			retrievedThisPhase.length > 0
				? retrievedThisPhase
						.map((e) => e.timestamp)
						.reduce((a, b) => (a < b ? a : b))
				: null;

		const criticalIds = await readCriticalIdsForPhase(
			params.directory,
			params.phaseLabel,
		);
		if (criticalIds.length === 0) {
			return {
				blocked: false,
				unresolved: [],
				overridden: [],
				failedClosed: false,
			};
		}

		const receipts = events
			.filter(isReceipt)
			.filter((r) => phaseStart === null || r.timestamp >= phaseStart)
			.map((r) => ({
				type: r.type,
				knowledge_id: r.knowledge_id,
				timestamp: r.timestamp,
				reason: r.reason,
			})) as ReceiptLike[];

		const unresolved: DirectiveGateResult['unresolved'] = [];
		const overridden: string[] = [];
		for (const id of criticalIds) {
			const reason = evaluateCritical(id, receipts);
			if (reason === null) continue;
			if (accept.has(id)) {
				overridden.push(id);
				continue;
			}
			unresolved.push({ id, reason });
		}
		return {
			blocked: unresolved.length > 0,
			unresolved,
			overridden,
			failedClosed: false,
		};
	} catch {
		return {
			blocked: true,
			unresolved: [],
			overridden: [],
			failedClosed: true,
		};
	}
}

/** Critical directive IDs retrieved during the phase (entry-priority sourced). */
async function readCriticalIdsForPhase(
	directory: string,
	phaseLabel?: string,
): Promise<string[]> {
	const ids = await collectPhaseDirectiveIds(directory, phaseLabel);
	if (ids.length === 0) return [];
	const entries = await readEntriesById(directory);
	return ids.filter((id) => {
		const e = entries.get(id);
		if (!e) return false;
		if (e.status === 'archived' || e.status === 'quarantined') return false;
		return e.directive_priority === 'critical';
	});
}

/**
 * Record an architect override for accepted critical violations. Each accepted
 * id is logged as an `override` event with the written justification.
 */
export async function recordDirectiveOverrides(
	directory: string,
	ids: string[],
	justification: string,
	sessionId: string | undefined,
): Promise<void> {
	for (const id of ids) {
		await recordKnowledgeEvent(directory, {
			type: 'override',
			trace_id: '',
			knowledge_id: id,
			session_id: sessionId ?? 'unknown',
			agent: 'architect',
			source: 'reviewer',
			reason: `override: ${justification}`.slice(0, 280),
		});
	}
}

/** Build a structured, human-readable block message for unresolved criticals. */
export function formatDirectiveBlockMessage(
	unresolved: DirectiveGateResult['unresolved'],
): string {
	const lines = unresolved.map((u) => {
		const why =
			u.reason === 'no_verdict'
				? 'no terminal verdict (applied/verified/ignored+reason/n_a+reason)'
				: 'violated with no subsequent applied/verified remediation';
		return `  - ${u.id}: ${why}`;
	});
	return [
		'PHASE_COMPLETE_BLOCKED: unresolved critical knowledge directive(s):',
		...lines,
		'Resolve each by applying/verifying the directive, recording an explicit',
		'ignored/n_a with a reason, or (architect only) accept_violations with a',
		'written justification.',
	].join('\n');
}
