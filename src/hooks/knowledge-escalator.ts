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
	countEntryViolationsInWindow,
	readKnowledgeEvents,
	recordKnowledgeEvent,
} from './knowledge-events.js';
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

/**
 * Evaluate and (if warranted) apply a repeat-violation escalation to a single
 * entry. Call AFTER the triggering `violated` event has been persisted.
 */
export async function maybeEscalateOnViolation(
	directory: string,
	entryId: string,
	now: Date = new Date(),
): Promise<EscalationResult> {
	try {
		let count = await countEntryViolationsInWindow(
			directory,
			entryId,
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
					const seen = new Set<string>([entryId]);
					const targetBigrams = wordBigrams(target.lesson);
					for (const e of allEntries) {
						if (seen.has(e.id)) continue;
						seen.add(e.id);
						if (
							jaccardBigram(targetBigrams, wordBigrams(e.lesson)) >=
							NEAR_DUPLICATE_THRESHOLD
						) {
							count += await countEntryViolationsInWindow(
								directory,
								e.id,
								ESCALATION_WINDOW_DAYS,
								now,
							);
							if (count >= ESCALATION_THRESHOLD) break;
						}
					}
				}
			} catch {
				// fail-open: near-dup co-counting is best-effort
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
