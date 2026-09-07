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
	type ReceiptMembership,
	type ReceiptUnavailable,
	validateAndCommitTerminalBatch,
} from './knowledge-receipt-ledger.js';

export type DirectiveBlockReason = 'no_verdict' | 'unremediated_violation';

export type DirectiveGateFailureCode =
	| 'RECEIPT_MISSING'
	| 'RECEIPT_CORRUPT'
	| 'RECEIPT_LOCK_TIMEOUT'
	| 'RECEIPT_WRONG_ROOT'
	| 'RECEIPT_PERMISSION'
	| 'RECEIPT_TRANSIENT'
	| 'RECEIPT_STORE_UNAVAILABLE';

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
	failure?: {
		code: DirectiveGateFailureCode;
		action_id:
			| 'knowledge_receipt'
			| 'phase_complete'
			| 'repair_knowledge_receipt_ledger';
	};
	recovery?: {
		kind: 'tool' | 'retry';
		action:
			| 'knowledge_receipt'
			| 'phase_complete'
			| 'repair_knowledge_receipt_ledger';
	};
}

function classifyDirectiveGateFailure(
	error: unknown | ReceiptUnavailable,
): Pick<DirectiveGateResult, 'failure' | 'recovery'> {
	if (
		typeof error === 'object' &&
		error !== null &&
		'ok' in error &&
		error.ok === false &&
		'code' in error
	) {
		const unavailable = error as ReceiptUnavailable;
		if (unavailable.code === 'store_corrupt') {
			return {
				failure: {
					code: 'RECEIPT_CORRUPT',
					action_id: 'repair_knowledge_receipt_ledger',
				},
				recovery: {
					kind: 'tool',
					action: 'repair_knowledge_receipt_ledger',
				},
			};
		}
		if (unavailable.code === 'lock_timeout') {
			return {
				failure: {
					code: 'RECEIPT_LOCK_TIMEOUT',
					action_id: 'phase_complete',
				},
				recovery: { kind: 'retry', action: 'phase_complete' },
			};
		}
		error = unavailable.detail;
	}
	const message =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: '';
	const lower = message.toLowerCase();
	if (lower.includes('exact session identity')) {
		return {
			failure: {
				code: 'RECEIPT_MISSING',
				action_id: 'knowledge_receipt',
			},
			recovery: { kind: 'tool', action: 'knowledge_receipt' },
		};
	}
	if (lower.includes('corrupt') || lower.includes('legacy_unverifiable')) {
		return {
			failure: {
				code: 'RECEIPT_CORRUPT',
				action_id: 'repair_knowledge_receipt_ledger',
			},
			recovery: { kind: 'tool', action: 'repair_knowledge_receipt_ledger' },
		};
	}
	if (lower.includes('lock_timeout')) {
		return {
			failure: {
				code: 'RECEIPT_LOCK_TIMEOUT',
				action_id: 'phase_complete',
			},
			recovery: { kind: 'retry', action: 'phase_complete' },
		};
	}
	if (lower.includes('project root') || lower.includes('root')) {
		return {
			failure: {
				code: 'RECEIPT_WRONG_ROOT',
				action_id: 'repair_knowledge_receipt_ledger',
			},
			recovery: { kind: 'tool', action: 'repair_knowledge_receipt_ledger' },
		};
	}
	if (
		lower.includes('eacces') ||
		lower.includes('eperm') ||
		lower.includes('permission')
	) {
		return {
			failure: {
				code: 'RECEIPT_PERMISSION',
				action_id: 'repair_knowledge_receipt_ledger',
			},
			recovery: { kind: 'tool', action: 'repair_knowledge_receipt_ledger' },
		};
	}
	if (
		lower.includes('ebusy') ||
		lower.includes('temporar') ||
		lower.includes('transient')
	) {
		return {
			failure: {
				code: 'RECEIPT_TRANSIENT',
				action_id: 'phase_complete',
			},
			recovery: { kind: 'retry', action: 'phase_complete' },
		};
	}
	return {
		failure: {
			code: 'RECEIPT_STORE_UNAVAILABLE',
			action_id: 'repair_knowledge_receipt_ledger',
		},
		recovery: { kind: 'tool', action: 'repair_knowledge_receipt_ledger' },
	};
}

/**
 * Evaluate all critical directives shown during the phase. Fail-closed.
 *
 * Since #2628 the reviewer-facing obligation unit is the ENTRY (one shown
 * obligation per entry), so resolution is evaluated per entry: an entry is
 * resolved when (a) at least one of its phase-window memberships carries a
 * satisfying terminal (authorized override, applied, or ignored/n_a with a
 * reason), AND (b) every violated/contradicted membership is remediated by an
 * `applied` terminal committed STRICTLY LATER on some membership of the same
 * entry (an earlier applied never hides a later violation; the same-membership
 * case is the historical in-place remediation flow, where the current terminal
 * is `applied` and the violated state moved to terminal_history). The reported
 * trace_id is the representative the reviewer was shown: a violated membership
 * when one exists, else the most recently committed one (ties by greatest
 * trace_id) — mirroring `pickDirectiveRepresentatives` in phase-directives.ts.
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
		if (!state.ok) {
			return {
				blocked: true,
				unresolved: [],
				overridden: [],
				failedClosed: true,
				...classifyDirectiveGateFailure(state),
			};
		}
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

		const byEntry = new Map<string, ReceiptMembership[]>();
		for (const membership of criticals) {
			const group = byEntry.get(membership.entry_id) ?? [];
			group.push(membership);
			byEntry.set(membership.entry_id, group);
		}

		const isSatisfied = (membership: ReceiptMembership): boolean => {
			const terminal = membership.terminal;
			if (terminal?.authorized_transition) return true;
			if (terminal?.outcome === 'applied') return true;
			return (
				(terminal?.outcome === 'ignored' || terminal?.outcome === 'n_a') &&
				Boolean(terminal.reason?.trim())
			);
		};
		const isViolation = (outcome: string): boolean =>
			outcome === 'violated' || outcome === 'contradicted';

		const unresolved: DirectiveGateResult['unresolved'] = [];
		const overridden: string[] = [];
		for (const [entryId, members] of byEntry) {
			for (const membership of members) {
				if (membership.terminal?.authorized_transition) {
					overridden.push(entryId);
				}
			}
			const hasSatisfied = members.some((membership) =>
				isSatisfied(membership),
			);
			const violated = members.filter(
				(membership) =>
					membership.terminal !== undefined &&
					// An authorized override is a terminal disposition (the architect
					// accepted the violation), not an unremediated one — mirrors the
					// pre-#2628 short-circuit.
					!membership.terminal.authorized_transition &&
					isViolation(membership.terminal.outcome),
			);
			const unremediated = violated.filter(
				(membership) =>
					!members.some(
						(other) =>
							other.terminal?.outcome === 'applied' &&
							other.terminal.committed_at > membership.terminal!.committed_at,
					),
			);
			if (hasSatisfied && unremediated.length === 0) continue;
			// Representative membership: violated preferred (the obligation the
			// reviewer was asked to remediate), else most recently committed, ties
			// by greatest trace_id — same precedence as the shown block.
			const representative = [...members].sort((a, b) => {
				const aViolated =
					a.terminal !== undefined && isViolation(a.terminal.outcome) ? 0 : 1;
				const bViolated =
					b.terminal !== undefined && isViolation(b.terminal.outcome) ? 0 : 1;
				if (aViolated !== bViolated) return aViolated - bViolated;
				if (a.committed_at !== b.committed_at) {
					return a.committed_at < b.committed_at ? 1 : -1;
				}
				return a.trace_id < b.trace_id ? 1 : -1;
			})[0];
			unresolved.push({
				id: entryId,
				trace_id: representative.trace_id,
				reason: violated.length > 0 ? 'unremediated_violation' : 'no_verdict',
			});
		}
		unresolved.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return {
			blocked: unresolved.length > 0,
			unresolved,
			overridden: [...new Set(overridden)],
			failedClosed: false,
		};
	} catch (error) {
		return {
			blocked: true,
			unresolved: [],
			overridden: [],
			failedClosed: true,
			...classifyDirectiveGateFailure(error),
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
		'ignored/n_a with a reason, or use the separate architect-only record_directive_override action with a',
		'written justification.',
	].join('\n');
}
