/**
 * Phase-windowed directive sourcing (Swarm Learning System, Change 2).
 *
 * Single source of truth for "which knowledge directives were shown during this
 * phase". Used by both the reviewer verdict loop (Task 2.1/2.3 — which IDs the
 * reviewer must verify) and the phase-complete gate (Task 2.4 — which CRITICAL
 * IDs must reach a terminal outcome before the phase advances).
 *
 * The window is defined by each authoritative receipt membership's `phase`
 * label. Legacy retrieval events are imported by the V2 ledger at cutover, so a
 * single equality filter gives a consistent set across consumers.
 * Passing an empty/undefined phase collects directives across all phases (used
 * only as a permissive fallback).
 */

import { existsSync } from 'node:fs';
import type { DirectiveToVerify } from '../agents/reviewer-directive-compliance.js';
import { queryLiveMemberships } from './knowledge-receipt-ledger.js';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
} from './knowledge-store.js';
import type { KnowledgeEntryBase } from './knowledge-types.js';
import { isActiveStatus } from './knowledge-types.js';

/** Collect unique entry IDs from authoritative memberships in the phase window. */
export async function collectPhaseDirectiveIds(
	directory: string,
	phaseLabel?: string,
): Promise<string[]> {
	const result = await queryLiveMemberships(directory, {
		phase: phaseLabel || undefined,
		include_terminal: true,
		include_phase_closed: false,
	});
	if (!result.ok) {
		throw new Error(`receipt ledger unavailable: ${result.code}`);
	}
	const ids = new Set<string>();
	for (const membership of result.memberships) ids.add(membership.entry_id);
	return [...ids];
}

/** Load all knowledge entries (swarm + hive) indexed by id. */
export async function readEntriesById(
	directory: string,
): Promise<Map<string, KnowledgeEntryBase>> {
	const map = new Map<string, KnowledgeEntryBase>();
	const swarm = await readKnowledge<KnowledgeEntryBase>(
		resolveSwarmKnowledgePath(directory),
	);
	for (const e of swarm) map.set(e.id, e);
	const hivePath = resolveHiveKnowledgePath();
	if (existsSync(hivePath)) {
		const hive = await readKnowledge<KnowledgeEntryBase>(hivePath);
		for (const e of hive) if (!map.has(e.id)) map.set(e.id, e);
	}
	return map;
}

/**
 * One candidate obligation per receipt membership, before per-entry collapse.
 * `committed_at` and the terminal fields come from the membership so the
 * representative selection below is deterministic.
 */
export interface DirectiveCandidate {
	directive: DirectiveToVerify;
	/** Membership commit time (ISO-8601 UTC from the receipt ledger). */
	committed_at: string;
}

/**
 * True when `next` is a better per-entry representative than `incumbent`.
 * Precedence (#2628): a membership whose current terminal is `violated` wins
 * (it carries the remediation obligation via prior_terminal_*), then the most
 * recently committed membership, then the lexicographically greatest trace_id
 * (code-unit order — locale-independent determinism).
 */
export function isPreferredDirectiveCandidate(
	next: DirectiveCandidate,
	incumbent: DirectiveCandidate,
): boolean {
	const nextViolated = next.directive.prior_terminal_outcome === 'violated';
	const incumbentViolated =
		incumbent.directive.prior_terminal_outcome === 'violated';
	if (nextViolated !== incumbentViolated) return nextViolated;
	if (next.committed_at !== incumbent.committed_at) {
		return next.committed_at > incumbent.committed_at;
	}
	return next.directive.trace_id > incumbent.directive.trace_id;
}

/**
 * Collapse membership-derived candidates to at most one per unique entry_id
 * (issue #2628). The reviewer's obligation unit is the directive (entry), not
 * the (trace_id, entry_id) pair — pair multiplicity re-created one verification
 * per historical exposure and grew the injected block O(entries x trace_ids).
 * Snapshot semantics: the result is a pure function of the membership list at
 * read time; a membership committed between dispatch and settle can shift the
 * representative (pre-existing skew class, not widened here).
 */
export function pickDirectiveRepresentatives(
	candidates: DirectiveCandidate[],
): DirectiveCandidate[] {
	const byEntry = new Map<string, DirectiveCandidate>();
	for (const candidate of candidates) {
		const incumbent = byEntry.get(candidate.directive.entry_id);
		if (!incumbent || isPreferredDirectiveCandidate(candidate, incumbent)) {
			byEntry.set(candidate.directive.entry_id, candidate);
		}
	}
	return [...byEntry.values()];
}

/**
 * Resolve the directives the reviewer must verify for a phase: the entries
 * behind the phase's retrieved IDs, with priority + lesson + verification
 * predicate, deduplicated to ONE obligation per entry. Archived/quarantined
 * entries are excluded. Fail-open: returns [] on any error.
 */
export async function readPhaseDirectivesToVerify(
	directory: string,
	phaseLabel?: string,
): Promise<DirectiveToVerify[]> {
	try {
		const result = await queryLiveMemberships(directory, {
			phase: phaseLabel || undefined,
			include_terminal: true,
			include_phase_closed: false,
		});
		if (!result.ok || result.memberships.length === 0) return [];
		const entries = await readEntriesById(directory);
		const candidates: DirectiveCandidate[] = [];
		for (const membership of result.memberships) {
			if (membership.terminal && membership.terminal.outcome !== 'violated') {
				continue;
			}
			const e = entries.get(membership.entry_id);
			if (!e) continue;
			// G4 (#1716): use the canonical helper so the inactive set has a single
			// source of truth — also excludes `quarantined_unactionable` (failed
			// the actionability gate; should not be re-injected as a directive).
			if (!isActiveStatus(e.status)) continue;
			candidates.push({
				committed_at: membership.committed_at,
				directive: {
					trace_id: membership.trace_id,
					entry_id: membership.entry_id,
					session_id: membership.session_id,
					cohort_id: membership.cohort_id,
					source_link_id: membership.source_link_id,
					prior_terminal_outcome:
						membership.terminal?.outcome === 'violated'
							? 'violated'
							: undefined,
					prior_terminal_event_id:
						membership.terminal?.outcome === 'violated'
							? membership.terminal.event_id
							: undefined,
					priority: membership.critical
						? 'critical'
						: (e.directive_priority ?? 'medium'),
					lesson: e.lesson,
					verification_predicate: e.verification_predicate,
				},
			});
		}
		return pickDirectiveRepresentatives(candidates).map(
			(candidate) => candidate.directive,
		);
	} catch {
		return [];
	}
}

/** The CRITICAL directive IDs retrieved during the phase. */
export async function readPhaseCriticalDirectiveIds(
	directory: string,
	phaseLabel?: string,
): Promise<string[]> {
	const directives = await readPhaseDirectivesToVerify(directory, phaseLabel);
	return [
		...new Set(
			directives
				.filter((d) => d.priority === 'critical')
				.map((d) => d.entry_id),
		),
	];
}
