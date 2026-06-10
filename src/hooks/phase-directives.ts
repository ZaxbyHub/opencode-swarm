/**
 * Phase-windowed directive sourcing (Swarm Learning System, Change 2).
 *
 * Single source of truth for "which knowledge directives were shown during this
 * phase". Used by both the reviewer verdict loop (Task 2.1/2.3 — which IDs the
 * reviewer must verify) and the phase-complete gate (Task 2.4 — which CRITICAL
 * IDs must reach a terminal outcome before the phase advances).
 *
 * The window is defined by the retrieval event's `phase` label: every
 * `retrieved` event (auto_injection AND delegate_inject) carries the plan phase
 * label, so a single equality filter gives a consistent set across consumers.
 * Passing an empty/undefined phase collects directives across all phases (used
 * only as a permissive fallback).
 */

import { existsSync } from 'node:fs';
import type { DirectiveToVerify } from '../agents/reviewer-directive-compliance.js';
import { readKnowledgeEvents } from './knowledge-events.js';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
} from './knowledge-store.js';
import type { KnowledgeEntryBase } from './knowledge-types.js';

/** Collect the directive IDs surfaced by `retrieved` events in the phase window. */
export async function collectPhaseDirectiveIds(
	directory: string,
	phaseLabel?: string,
): Promise<string[]> {
	const events = await readKnowledgeEvents(directory);
	const ids = new Set<string>();
	for (const e of events) {
		if (e.type !== 'retrieved') continue;
		if (phaseLabel && e.phase !== phaseLabel) continue;
		for (const id of e.result_ids) ids.add(id);
	}
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
		const ids = await collectPhaseDirectiveIds(directory, phaseLabel);
		if (ids.length === 0) return [];
		const entries = await readEntriesById(directory);
		const out: DirectiveToVerify[] = [];
		for (const id of ids) {
			const e = entries.get(id);
			if (!e) continue;
			if (e.status === 'archived' || e.status === 'quarantined') continue;
			out.push({
				id,
				priority: e.directive_priority ?? 'medium',
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
	return directives.filter((d) => d.priority === 'critical').map((d) => d.id);
}
