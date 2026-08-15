/**
 * Repeat-mistake escalator (Swarm Learning System, Change 3 / Task 3.2).
 *
 * When the same directive is violated >= {@link ESCALATION_THRESHOLD} times
 * within {@link ESCALATION_WINDOW_DAYS} days (across sessions), it is
 * auto-promoted to `directive_priority:'critical'` + `enforcement_mode:'enforce'`,
 * its `escalation_history` gets a `repeat_violation` record, and an `escalation`
 * event is emitted. Idempotent: an entry already at critical/enforce is never
 * re-escalated, even on subsequent violations.
 *
 * Persistence goes through `rewriteKnowledge` (never a raw JSONL write). Fail-open:
 * any error leaves the entry untouched and returns `escalated:false`.
 */

import { existsSync } from 'node:fs';
import {
	readKnowledgeEvents,
	recordKnowledgeEvent,
} from './knowledge-events.js';
import {
	queryHistoricalOutcomes,
	type ReceiptMembership,
	type ReceiptTerminal,
} from './knowledge-receipt-ledger.js';
import {
	jaccardBigram,
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	transactKnowledge,
	wordBigrams,
} from './knowledge-store.js';
import type {
	DirectiveEscalationRecord,
	DirectivePriority,
	KnowledgeEntryBase,
} from './knowledge-types.js';
import { isActiveStatus } from './knowledge-types.js';

const NEAR_DUPLICATE_THRESHOLD = 0.6;

export const ESCALATION_WINDOW_DAYS = 30;
export const ESCALATION_THRESHOLD = 2;

type EscalationOutcome =
	| { kind: 'escalated'; from: DirectivePriority }
	| { kind: 'already' }
	| { kind: 'not_found' };

export interface EscalationResult {
	escalated: boolean;
	entryId: string;
	from?: DirectivePriority;
	to?: DirectivePriority;
	violationsInWindow?: number;
	/** True when the entry was already critical/enforce (no-op, idempotent). */
	alreadyEscalated?: boolean;
}

function isFullyEscalated(e: KnowledgeEntryBase): boolean {
	return (
		e.directive_priority === 'critical' && e.enforcement_mode === 'enforce'
	);
}

function terminalHistory(membership: ReceiptMembership): ReceiptTerminal[] {
	const compatible = membership as ReceiptMembership & {
		terminal_history?: ReceiptTerminal[];
		historical_terminals?: ReceiptTerminal[];
	};
	return [
		...(compatible.terminal_history ?? []),
		...(compatible.historical_terminals ?? []),
		...(membership.terminal ? [membership.terminal] : []),
	];
}

function countTerminalOutcomesInWindow(
	memberships: ReceiptMembership[],
	entryIds: ReadonlySet<string>,
	outcome: 'violated' | 'contradicted',
	windowDays: number,
	now: Date,
): number {
	const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
	const upper = now.getTime();
	const seenEvents = new Set<string>();
	let count = 0;
	for (const membership of memberships) {
		if (!entryIds.has(membership.entry_id)) continue;
		for (const terminal of terminalHistory(membership)) {
			if (terminal.outcome !== outcome || seenEvents.has(terminal.event_id)) {
				continue;
			}
			const timestamp = Date.parse(terminal.committed_at);
			if (
				!Number.isNaN(timestamp) &&
				timestamp >= cutoff &&
				timestamp <= upper
			) {
				seenEvents.add(terminal.event_id);
				count += 1;
			}
		}
	}
	return count;
}

/**
 * Evaluate and (if warranted) apply a repeat-violation escalation to a single
 * entry. Call AFTER the triggering authoritative `violated` terminal commits.
 */
export async function maybeEscalateOnViolation(
	directory: string,
	entryId: string,
	now: Date = new Date(),
): Promise<EscalationResult> {
	try {
		const history = await _internals.queryHistoricalOutcomes(directory);
		if (!history.ok) return { escalated: false, entryId };
		let count = countTerminalOutcomesInWindow(
			history.memberships,
			new Set([entryId]),
			'violated',
			ESCALATION_WINDOW_DAYS,
			now,
		);

		// Co-count violations on semantically near-duplicate entries so
		// equivalent lessons under different IDs accumulate toward escalation.
		if (count < ESCALATION_THRESHOLD) {
			try {
				const allEntries: KnowledgeEntryBase[] = [];
				allEntries.push(
					...(await readKnowledge<KnowledgeEntryBase>(
						resolveSwarmKnowledgePath(directory),
					)),
				);
				const hivePath = resolveHiveKnowledgePath();
				if (existsSync(hivePath)) {
					allEntries.push(
						...(await readKnowledge<KnowledgeEntryBase>(hivePath)),
					);
				}
				const target = allEntries.find((e) => e.id === entryId);
				if (target) {
					const equivalentIds = new Set<string>([entryId]);
					const targetBigrams = wordBigrams(target.lesson);
					for (const e of allEntries) {
						if (equivalentIds.has(e.id)) continue;
						if (
							jaccardBigram(targetBigrams, wordBigrams(e.lesson)) >=
							NEAR_DUPLICATE_THRESHOLD
						) {
							equivalentIds.add(e.id);
						}
					}
					count = countTerminalOutcomesInWindow(
						history.memberships,
						equivalentIds,
						'violated',
						ESCALATION_WINDOW_DAYS,
						now,
					);
				}
			} catch {
				// Conservative: exact authoritative evidence can still decide, but
				// near-duplicate discovery never invents additional credit.
			}
		}

		if (count < ESCALATION_THRESHOLD) {
			return { escalated: false, entryId, violationsInWindow: count };
		}

		const to: DirectivePriority = 'critical';
		const at = now.toISOString();

		// Atomic, lock-protected read-modify-write to avoid a TOCTOU race when two
		// concurrent violations escalate the same entry. The mutate closure is the
		// single point of truth for the idempotency check, so even racing
		// transactions can only escalate once. Outcome is captured via a holder.
		const state: { outcome: EscalationOutcome } = {
			outcome: { kind: 'not_found' },
		};

		const mutate = (
			entries: KnowledgeEntryBase[],
		): KnowledgeEntryBase[] | null => {
			const entry = entries.find((e) => e.id === entryId);
			if (!entry) {
				state.outcome = { kind: 'not_found' };
				return null; // no write
			}
			if (isFullyEscalated(entry)) {
				state.outcome = { kind: 'already' };
				return null; // idempotent no-op
			}
			const from: DirectivePriority = entry.directive_priority ?? 'medium';
			const record: DirectiveEscalationRecord = {
				from,
				to,
				reason: 'repeat_violation',
				at,
			};
			entry.directive_priority = to;
			entry.enforcement_mode = 'enforce';
			entry.escalation_history = [...(entry.escalation_history ?? []), record];
			(entry as { updated_at?: string }).updated_at = at;
			state.outcome = { kind: 'escalated', from };
			return entries;
		};

		// Try the swarm store first; only touch the hive store if the entry was
		// not present in the swarm store at all.
		await transactKnowledge<KnowledgeEntryBase>(
			resolveSwarmKnowledgePath(directory),
			mutate,
		);
		if (state.outcome.kind === 'not_found') {
			const hivePath = resolveHiveKnowledgePath();
			if (existsSync(hivePath)) {
				await transactKnowledge<KnowledgeEntryBase>(hivePath, mutate);
			}
		}

		if (state.outcome.kind === 'already') {
			return {
				escalated: false,
				entryId,
				violationsInWindow: count,
				alreadyEscalated: true,
			};
		}
		if (state.outcome.kind === 'not_found') {
			return { escalated: false, entryId, violationsInWindow: count };
		}

		const from = state.outcome.from;
		await recordKnowledgeEvent(directory, {
			type: 'escalation',
			entry_id: entryId,
			from,
			to,
			reason: 'repeat_violation',
			enforcement_mode: 'enforce',
		});

		return {
			escalated: true,
			entryId,
			from,
			to,
			violationsInWindow: count,
		};
	} catch {
		return { escalated: false, entryId };
	}
}

export interface RecentEscalation {
	entry_id: string;
	from: string;
	to: string;
	reason: string;
	at: string;
}

export const ESCALATION_DISPLAY_WINDOW_DAYS = 7;

/**
 * Read escalation events from the last `windowDays` days, newest first. Used by
 * the architect briefing and `/swarm status`. Fail-open: returns [] on error.
 */
export async function readRecentEscalations(
	directory: string,
	windowDays: number = ESCALATION_DISPLAY_WINDOW_DAYS,
	now: Date = new Date(),
): Promise<RecentEscalation[]> {
	try {
		const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
		const events = await readKnowledgeEvents(directory);
		const out: RecentEscalation[] = [];
		for (const e of events) {
			if (e.type !== 'escalation') continue;
			const t = Date.parse(e.timestamp);
			if (Number.isNaN(t) || t < cutoff) continue;
			out.push({
				entry_id: e.entry_id,
				from: e.from,
				to: e.to,
				reason: e.reason,
				at: e.timestamp,
			});
		}
		out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
		return out;
	} catch {
		return [];
	}
}

/**
 * Render the architect-briefing "Recently Escalated" subsection. Returns null
 * when there is nothing to show (no empty header).
 */
export function buildEscalationBriefing(
	escalations: RecentEscalation[],
	windowDays: number = ESCALATION_DISPLAY_WINDOW_DAYS,
): string | null {
	if (escalations.length === 0) return null;
	const lines = [`### Recently Escalated (last ${windowDays} days)`];
	for (const e of escalations) {
		lines.push(`- ${e.entry_id} (${e.from}→${e.to}) reason=${e.reason}`);
	}
	return lines.join('\n');
}

/** Run the escalator for several entry IDs (deduped). Never throws. */
export async function escalateViolatedEntries(
	directory: string,
	entryIds: string[],
	now: Date = new Date(),
): Promise<EscalationResult[]> {
	const out: EscalationResult[] = [];
	for (const id of [...new Set(entryIds)]) {
		out.push(await maybeEscalateOnViolation(directory, id, now));
	}
	return out;
}

// ============================================================================
// G3 (#1715): repeat-contradiction quarantine
// ============================================================================

export interface ContradictionQuarantineResult {
	quarantined: boolean;
	entryId: string;
	contradictionsInWindow?: number;
	/** True when the entry was already quarantined/archived (no-op, idempotent). */
	alreadyInactive?: boolean;
}

/**
 * G3 (#1715): if an entry's `contradicted` count within `windowDays` crosses
 * `threshold`, auto-quarantine it. Mirrors {@link maybeEscalateOnViolation}
 * Counts exact authoritative receipt terminals, never the diagnostic FIFO or
 * rollup cache. Idempotent: already-quarantined/archived entries are skipped.
 * Receipt-ledger uncertainty is conservative and never quarantines.
 */
export async function maybeQuarantineOnContradiction(
	directory: string,
	entryId: string,
	threshold: number,
	windowDays: number,
	now: Date = new Date(),
): Promise<ContradictionQuarantineResult> {
	try {
		const history = await _internals.queryHistoricalOutcomes(directory, [
			entryId,
		]);
		if (!history.ok) return { quarantined: false, entryId };
		const count = countTerminalOutcomesInWindow(
			history.memberships,
			new Set([entryId]),
			'contradicted',
			windowDays,
			now,
		);
		if (count < threshold) {
			return { quarantined: false, entryId, contradictionsInWindow: count };
		}

		// Idempotency: skip if already inactive. Read fresh under no lock (the
		// quarantine call below does its own locking; this is just a guard).
		const entries = await readKnowledge<KnowledgeEntryBase>(
			resolveSwarmKnowledgePath(directory),
		);
		const entry = entries.find((e) => e.id === entryId);
		if (!entry) {
			return { quarantined: false, entryId, contradictionsInWindow: count };
		}
		if (!isActiveStatus(entry.status)) {
			return {
				quarantined: false,
				entryId,
				contradictionsInWindow: count,
				alreadyInactive: true,
			};
		}

		const { quarantineEntry } = await import('./knowledge-validator.js');
		// #1848 §2 (IR-4 fix): contradiction-quarantine uses cohort-wide evidence
		// (the contradiction count is over the link-aware event window). Route
		// through the cohort-safe policy so unknown-owner legacy entries are
		// protected and a sibling worktree cannot quarantine another's entry from
		// local-only signals. Best-effort config load: fall back to undefined
		// when the schema module is unavailable (mock-leak resilient).
		let policyConfig: unknown;
		try {
			const { KnowledgeConfigSchema } = await import('../config/schema.js');
			// F-06: parse the project's real config so the cohort config-fingerprint
			// guard compares actual settings, not defaults-vs-defaults.
			const { loadPluginConfigWithMeta } = await import('../config/index.js');
			const { config: loadedConfig } = loadPluginConfigWithMeta(directory);
			policyConfig = KnowledgeConfigSchema.parse(loadedConfig.knowledge ?? {});
		} catch {
			policyConfig = undefined;
		}
		await quarantineEntry(
			directory,
			entryId,
			`repeat_contradiction: ${count} contradicted events in ${windowDays}d`,
			'auto',
			{
				input: {
					directory,
					action: 'quarantine' as const,
					entryId,
					reason: `repeat_contradiction: ${count} in ${windowDays}d`,
					evidenceScope: 'cohort-wide' as const,
				},
				context: { config: policyConfig, entry: entry as never } as never,
			},
		);
		return { quarantined: true, entryId, contradictionsInWindow: count };
	} catch {
		return { quarantined: false, entryId };
	}
}

/** Dependency seam for authoritative-history tests; restore after each test. */
export const _internals = { queryHistoricalOutcomes };
