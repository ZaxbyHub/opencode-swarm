import { describe, expect, test } from 'bun:test';
import {
	expandRelatedRecallItems,
	MAX_MERGE_PARTICIPANTS,
	MAX_RELATIONS_PER_MEMORY,
	validateMergeParticipants,
} from '../../../src/memory/relations';
import { MemoryProposalSchema } from '../../../src/memory/schema';
import type {
	MemoryProposal,
	MemoryRecord,
	RecallResultItem,
} from '../../../src/memory/types';

const scope = {
	type: 'repository' as const,
	repoId: 'boundary-repo',
	repoRoot: 'boundary-root',
};

function record(id: string): MemoryRecord {
	return {
		id,
		scope,
		kind: 'repo_convention',
		text: `memory ${id}`,
		tags: [],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'manual' },
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z',
		contentHash: `hash-${id}`,
		metadata: {},
	};
}

function proposal(ids: string[], suffix: string): MemoryProposal {
	return {
		id: `prop_${suffix}`,
		operation: 'merge',
		relatedMemoryIds: ids,
		proposedBy: { agentRole: 'curator' },
		rationale: 'boundary fixture',
		evidenceRefs: [],
		status: 'applied',
		createdAt: '2026-09-01T00:00:00.000Z',
		metadata: {},
	};
}

function item(recordValue: MemoryRecord, explored = false): RecallResultItem {
	return {
		record: recordValue,
		score: 1,
		reason: 'fixture',
		signals: {
			textOverlap: 1,
			tagOverlap: 0,
			kindMatch: true,
			scopeMatch: true,
		},
		explored,
	};
}

describe('related-memory bounds and expansion', () => {
	test('accepts exactly 2 and 8 participants but rejects 9', () => {
		const ids = Array.from(
			{ length: 9 },
			(_, index) => `mem_${String(index + 1).padStart(16, '0')}`,
		);
		const base = {
			operation: 'merge' as const,
			proposedBy: { agentRole: 'curator' },
			rationale: 'boundary fixture',
			evidenceRefs: [],
			status: 'pending' as const,
			createdAt: '2026-09-01T00:00:00.000Z',
			metadata: {},
		};
		const parse = (relatedMemoryIds: string[]) =>
			MemoryProposalSchema.safeParse({
				...base,
				id: 'prop_0000000000000001',
				relatedMemoryIds,
			});
		expect(parse(ids.slice(0, 2)).success).toBe(true);
		expect(parse(ids.slice(0, MAX_MERGE_PARTICIPANTS)).success).toBe(true);
		expect(parse(ids).success).toBe(false);
	});

	test('accepts degree 32 and rejects degree 33', () => {
		const anchor = record('anchor');
		const neighbors = Array.from(
			{ length: MAX_RELATIONS_PER_MEMORY + 1 },
			(_, index) => record(`neighbor-${index}`),
		);
		const records = [anchor, ...neighbors];
		const existing = neighbors
			.slice(0, MAX_RELATIONS_PER_MEMORY - 1)
			.map((neighbor, index) =>
				proposal(
					[anchor.id, neighbor.id],
					String(index + 1).padStart(16, '0'),
				),
			);
		const next = proposal(
			[anchor.id, neighbors[MAX_RELATIONS_PER_MEMORY - 1].id],
			'00000000000000aa',
		);
		expect(
			validateMergeParticipants(next.relatedMemoryIds ?? [], records, existing),
		).toEqual([anchor.id, neighbors[MAX_RELATIONS_PER_MEMORY - 1].id].sort());
		const overLimit = proposal(
			[anchor.id, neighbors[MAX_RELATIONS_PER_MEMORY].id],
			'00000000000000ab',
		);
		expect(() =>
			validateMergeParticipants(overLimit.relatedMemoryIds ?? [], records, [
				...existing,
				next,
			]),
		).toThrow(`merge would exceed ${MAX_RELATIONS_PER_MEMORY} relations`);
	});

	test('expands only direct sources and deduplicates explored overlap', () => {
		const source = record('source');
		const direct = {
			...record('direct'),
			relations: [{ memoryId: 'transitive', type: 'merged_with' as const }],
		};
		const transitive = record('transitive');
		source.relations = [{ memoryId: direct.id, type: 'merged_with' }];
		const request = {
			query: 'memory',
			scopes: [scope],
			maxItems: 4,
			tokenBudget: 1000,
			requireQuerySignal: false,
		};
		const expanded = expandRelatedRecallItems(
			[item(source)],
			[source, direct, transitive],
			request,
		);
		expect(expanded.map(({ record: value }) => value.id)).toEqual([
			source.id,
			direct.id,
		]);
		const overlap = expandRelatedRecallItems(
			[item(source), item(direct, true)],
			[source, direct, transitive],
			request,
		);
		expect(new Set(overlap.map(({ record: value }) => value.id)).size).toBe(
			overlap.length,
		);
	});
});
