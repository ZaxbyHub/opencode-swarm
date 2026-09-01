import { MemoryValidationError } from './errors';

export {
	MAX_MERGE_PARTICIPANTS,
	MAX_RELATIONS_PER_MEMORY,
	RELATED_RECALL_FANOUT,
} from './relation-constants';

import {
	MAX_MERGE_PARTICIPANTS,
	MAX_RELATIONS_PER_MEMORY,
	RELATED_RECALL_FANOUT,
} from './relation-constants';
import { isExpired, stableScopeKey } from './schema';
import { scoreMemoryRecord } from './scoring';
import type {
	MemoryProposal,
	MemoryRecord,
	MemoryRelation,
	RecallRequest,
	RecallResultItem,
} from './types';

export function canonicalMemoryIds(ids: readonly string[]): string[] {
	return Array.from(new Set(ids)).sort();
}

export function buildMemoryRelationIndex(
	proposals: Iterable<MemoryProposal>,
): Map<string, MemoryRelation[]> {
	const index = new Map<string, Map<string, MemoryRelation>>();
	for (const proposal of proposals) {
		if (proposal.operation !== 'merge' || proposal.status !== 'applied')
			continue;
		const ids = canonicalMemoryIds(proposal.relatedMemoryIds ?? []);
		for (const sourceId of ids) {
			let related = index.get(sourceId);
			if (!related) {
				related = new Map();
				index.set(sourceId, related);
			}
			for (const targetId of ids) {
				if (targetId !== sourceId) {
					related.set(targetId, { memoryId: targetId, type: 'merged_with' });
				}
			}
		}
	}
	return new Map(
		Array.from(index, ([id, relations]) => [
			id,
			Array.from(relations.values()).sort((a, b) =>
				a.memoryId.localeCompare(b.memoryId),
			),
		]),
	);
}

export function projectMemoryRelations(
	records: readonly MemoryRecord[],
	proposals: Iterable<MemoryProposal>,
): MemoryRecord[] {
	const index = buildMemoryRelationIndex(proposals);
	return records.map(({ relations: _derived, ...record }) => {
		const relations = index.get(record.id);
		return relations?.length ? { ...record, relations } : record;
	});
}

export function stripDerivedRelations(record: MemoryRecord): MemoryRecord {
	const { relations: _derived, ...stored } = record;
	return stored;
}

export function validateMergeParticipants(
	ids: readonly string[],
	records: Iterable<MemoryRecord>,
	proposals: Iterable<MemoryProposal>,
	now = new Date(),
): string[] {
	const canonical = canonicalMemoryIds(ids);
	if (canonical.length < 2 || canonical.length > MAX_MERGE_PARTICIPANTS) {
		throw new MemoryValidationError(
			`merge decisions require 2-${MAX_MERGE_PARTICIPANTS} distinct relatedMemoryIds`,
		);
	}
	const byId = new Map(Array.from(records, (record) => [record.id, record]));
	const participants = canonical.map((id) => {
		const record = byId.get(id);
		if (
			!record ||
			record.metadata.deleted === true ||
			record.supersededBy ||
			isExpired(record, now)
		) {
			throw new MemoryValidationError(`merge participant is not active: ${id}`);
		}
		return record;
	});
	const scopeKey = stableScopeKey(participants[0].scope);
	if (
		participants.some((record) => stableScopeKey(record.scope) !== scopeKey)
	) {
		throw new MemoryValidationError(
			'merge participants must share one memory scope',
		);
	}
	const index = buildMemoryRelationIndex(proposals);
	for (const id of canonical) {
		const degree = new Set([
			...(index.get(id)?.map((relation) => relation.memoryId) ?? []),
			...canonical.filter((candidate) => candidate !== id),
		]).size;
		if (degree > MAX_RELATIONS_PER_MEMORY) {
			throw new MemoryValidationError(
				`merge would exceed ${MAX_RELATIONS_PER_MEMORY} relations for ${id}`,
			);
		}
	}
	return canonical;
}

export function expandRelatedRecallItems(
	items: readonly RecallResultItem[],
	allRecords: readonly MemoryRecord[],
	request: RecallRequest,
): RecallResultItem[] {
	const normal = items
		.filter((item) => !item.explored)
		.slice(0, request.maxItems);
	const explored = items.filter((item) => item.explored);
	if (normal.length < request.maxItems) {
		const byId = new Map(allRecords.map((record) => [record.id, record]));
		// Expansion is intentionally one hop from the direct recall set. Keep the
		// source list immutable so relation hits cannot recursively become sources,
		// and reserve explored IDs so exploration never produces duplicate results.
		const selected = new Set(
			[...normal, ...explored].map((item) => item.record.id),
		);
		const directSources = [...normal];
		for (const source of directSources) {
			const sourceRecord = byId.get(source.record.id) ?? source.record;
			let addedForSource = 0;
			for (const relation of sourceRecord.relations ?? []) {
				if (
					normal.length >= request.maxItems ||
					addedForSource >= RELATED_RECALL_FANOUT
				) {
					break;
				}
				if (selected.has(relation.memoryId)) continue;
				const record = byId.get(relation.memoryId);
				if (!record) continue;
				const scored = scoreMemoryRecord(record, {
					...request,
					requireQuerySignal: false,
				});
				if (!scored) continue;
				normal.push({
					...scored,
					reason: `${scored.reason}, relation=${relation.type}, related_from=${source.record.id}`,
					relation: { type: relation.type, sourceMemoryId: source.record.id },
				});
				selected.add(record.id);
				addedForSource++;
			}
		}
	}
	const seen = new Set<string>();
	return [...normal, ...explored].filter((item) => {
		if (seen.has(item.record.id)) return false;
		seen.add(item.record.id);
		return true;
	});
}
