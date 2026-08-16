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

import { recordKnowledgeEvent } from './knowledge-events.js';
import {
	queryLiveMemberships,
	validateAndCommitTerminalBatch,
} from './knowledge-receipt-ledger.js';

export type DirectiveBlockReason = 'no_verdict' | 'unremediated_violation';

export interface DirectiveGateResult {
	blocked: boolean;
	unresolved: Array<{
		id: string;
		trace_id?: string;
		reason: DirectiveBlockReason;
	}>;
	overridden: string[];
	/** True when the gate could not read its inputs (fail-closed → blocked). */
	failedClosed: boolean;
}

/**
 * Evaluate all critical directives shown during the phase. Fail-closed.
 */
export async function evaluatePhaseCriticalDirectives(params: {
	directory: string;
	sessionId?: string;
	phaseLabel?: string;
	acceptViolations?: string[];
}): Promise<DirectiveGateResult> {
	try {
		if (!params.phaseLabel?.trim())
			throw new Error('directive gate requires exact phase identity');
		const state = await queryLiveMemberships(params.directory, {
			phase: params.phaseLabel,
			session_id: params.sessionId?.trim() || undefined,
			include_terminal: true,
			include_phase_closed: false,
		});
		if (!state.ok) throw new Error(state.detail);
		const criticals = state.memberships.filter(
			(membership) => membership.critical,
		);
		// Missing session identity is harmless only when there is no durable
		// critical obligation to attribute. Once any critical membership exists,
		// accepting an unscoped terminal would risk cross-session satisfaction.
		if (!params.sessionId?.trim() && criticals.length > 0) {
			throw new Error('directive gate requires exact session identity');
		}
		if (criticals.length === 0) {
			return {
				blocked: false,
				unresolved: [],
				overridden: [],
				failedClosed: false,
			};
		}

		const unresolved: DirectiveGateResult['unresolved'] = [];
		const overridden: string[] = [];
		for (const membership of criticals) {
			const terminal = membership.terminal;
			if (terminal?.authorized_transition) {
				overridden.push(membership.entry_id);
				continue;
			}
			if (terminal?.outcome === 'applied') continue;
			if (
				(terminal?.outcome === 'ignored' || terminal?.outcome === 'n_a') &&
				terminal.reason?.trim()
			)
				continue;
			unresolved.push({
				id: membership.entry_id,
				trace_id: membership.trace_id,
				reason:
					terminal?.outcome === 'violated' ||
					terminal?.outcome === 'contradicted'
						? 'unremediated_violation'
						: 'no_verdict',
			});
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

/**
 * Record an architect override for accepted critical violations. Each accepted
 * id is logged as an `override` event with the written justification.
 */
export async function recordDirectiveOverrides(
	directory: string,
	ids: string[],
	justification: string,
	sessionId: string | undefined,
	phaseLabel?: string,
): Promise<void> {
	if (!justification.trim()) {
		throw new Error('directive override requires a written justification');
	}
	if (!sessionId?.trim() || !phaseLabel?.trim()) {
		throw new Error(
			'directive override requires exact session and phase identity',
		);
	}
	const state = await queryLiveMemberships(directory, {
		phase: phaseLabel,
		session_id: sessionId,
		include_terminal: true,
		include_phase_closed: false,
	});
	if (!state.ok) throw new Error(state.detail);
	const criticals = state.memberships.filter(
		(membership) => membership.critical,
	);
	const selected = ids.map((requested) => {
		const exact = criticals.filter(
			(membership) =>
				`${membership.trace_id}/${membership.entry_id}` === requested,
		);
		if (exact.length === 1) return exact[0];
		const byEntry = criticals.filter(
			(membership) => membership.entry_id === requested,
		);
		if (byEntry.length !== 1) {
			throw new Error(
				byEntry.length === 0
					? `unknown directive override target: ${requested}`
					: `ambiguous directive override target; use trace_id/entry_id: ${requested}`,
			);
		}
		return byEntry[0];
	});
	for (const membership of selected) {
		const outcome = membership.terminal?.outcome ?? 'n_a';
		const committed = await validateAndCommitTerminalBatch(directory, {
			trace_id: membership.trace_id,
			session_id: sessionId,
			phase: phaseLabel,
			task_id: membership.task_id,
			items: [
				{
					entry_id: membership.entry_id,
					outcome,
					source: 'phase_override',
					reason: justification,
				},
			],
			authorization: {
				actor: 'phase-override',
				reason: justification,
				expected_event_id: membership.terminal?.event_id ?? '',
			},
		});
		if (!committed.ok || committed.rejected.length > 0) {
			throw new Error('failed to persist authoritative directive override');
		}

		// Best-effort diagnostic projection after authoritative commit.
		try {
			await recordKnowledgeEvent(directory, {
				type: 'override',
				trace_id: membership.trace_id,
				knowledge_id: membership.entry_id,
				session_id: sessionId,
				agent: 'architect',
				// (#2032) Provenance must match the authoritative terminal's
				// 'phase_override' source — this is an architect phase override,
				// not a reviewer verdict.
				source: 'phase_override',
				reason: `override: ${justification}`.slice(0, 280),
			});
		} catch {
			// The V2 transition is authoritative. Legacy diagnostics must never
			// roll back or disguise an already-committed override.
		}
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
		const pair = u.trace_id ? `${u.trace_id}/${u.id}` : u.id;
		return `  - ${pair}: ${why}`;
	});
	return [
		'PHASE_COMPLETE_BLOCKED: unresolved critical knowledge directive(s):',
		...lines,
		'Resolve each by applying/verifying the directive, recording an explicit',
		'ignored/n_a with a reason, or (architect only) accept_violations with a',
		'written justification.',
	].join('\n');
}
