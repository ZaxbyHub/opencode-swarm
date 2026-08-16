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
 * Resolve the directives the reviewer must verify for a phase: the entries
 * behind the phase's retrieved IDs, with priority + lesson + verification
 * predicate. Archived/quarantined entries are excluded. Fail-open: returns [] on
 * any error.
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
		const out: DirectiveToVerify[] = [];
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
			out.push({
				trace_id: membership.trace_id,
				entry_id: membership.entry_id,
				session_id: membership.session_id,
				cohort_id: membership.cohort_id,
				source_link_id: membership.source_link_id,
				prior_terminal_outcome:
					membership.terminal?.outcome === 'violated' ? 'violated' : undefined,
				prior_terminal_event_id:
					membership.terminal?.outcome === 'violated'
						? membership.terminal.event_id
						: undefined,
				priority: membership.critical
					? 'critical'
					: (e.directive_priority ?? 'medium'),
				lesson: e.lesson,
				verification_predicate: e.verification_predicate,
			});
		}
		return out;
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
