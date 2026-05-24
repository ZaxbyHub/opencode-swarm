import { describe, expect, test } from 'bun:test';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	type RecallRequest,
} from '../../../src/memory';
import { scoreMemoryRecord } from '../../../src/memory/scoring';

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'repo_convention' as const,
		text: 'This repository uses bun for tests.',
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: '2026-05-24T12:00:00.000Z',
		updatedAt: '2026-05-24T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
		...overrides,
	};
}

function makeRequest(): RecallRequest {
	return {
		query: 'bun tests',
		scopes: [{ type: 'repository', repoId: 'repo-a' }],
		maxItems: 5,
		tokenBudget: 1000,
		minScore: 0,
	};
}

describe('memory scoring', () => {
	test('does not score superseded records', () => {
		const result = scoreMemoryRecord(
			makeRecord({ supersededBy: 'mem_1111111111111111' }),
			makeRequest(),
		);

		expect(result).toBeNull();
	});
});
