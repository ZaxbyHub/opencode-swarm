import { describe, expect, test } from 'bun:test';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	type RecallRequest,
} from '../../../src/memory';
import {
	scoreMemoryRecord,
	scoreMemoryRecordsWithDiagnostics,
} from '../../../src/memory/scoring';

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

	test('manual recall can return same-scope lower-confidence matches without query signal', () => {
		const result = scoreMemoryRecord(
			makeRecord({
				text: 'Use pnpm for frontend packages.',
				tags: ['frontend'],
				confidence: 0.2,
			}),
			makeRequest(),
		);

		expect(result).not.toBeNull();
		expect(result?.signals).toMatchObject({
			textOverlap: 0,
			tagOverlap: 0,
			kindMatch: false,
			scopeMatch: true,
		});
	});

	test('injection recall rejects unrelated same-scope memories without query signal', () => {
		const result = scoreMemoryRecord(
			makeRecord({
				text: 'Use pnpm for frontend packages.',
				tags: ['frontend'],
				confidence: 1,
			}),
			{
				...makeRequest(),
				mode: 'injection',
				kinds: ['repo_convention'],
				requireQuerySignal: true,
			},
		);

		expect(result).toBeNull();
	});

	test('injection recall accepts relevant tag and file signals', () => {
		const tagged = scoreMemoryRecord(
			makeRecord({
				text: 'Package manager note.',
				tags: ['tests'],
			}),
			{
				...makeRequest(),
				mode: 'injection',
				requireQuerySignal: true,
			},
		);
		const fileMatched = scoreMemoryRecord(
			makeRecord({
				text: 'Config note.',
				tags: ['config'],
				source: { type: 'file', filePath: 'tests/unit/memory/scoring.test.ts' },
			}),
			{
				...makeRequest(),
				query: 'adjust tests/unit/memory/scoring.test.ts',
				mode: 'injection',
				requireQuerySignal: true,
			},
		);

		expect(tagged?.signals.tagOverlap).toBeGreaterThan(0);
		expect(fileMatched?.signals.fileOverlap).toBeGreaterThan(0);
	});

	test('injection diagnostics exclude pre-scoring filters from no-signal denominator', () => {
		const expired = makeRecord({
			text: 'This repository uses database migrations.',
			expiresAt: '2020-01-01T00:00:00.000Z',
		});
		const unrelated = makeRecord({
			text: 'Use pnpm for frontend packages.',
			tags: ['frontend'],
			confidence: 1,
		});
		const result = scoreMemoryRecordsWithDiagnostics([expired, unrelated], {
			...makeRequest(),
			query: 'backend database migration strategy',
			mode: 'injection',
			kinds: ['repo_convention'],
			requireQuerySignal: true,
		});

		expect(result.items).toHaveLength(0);
		expect(result.diagnostics).toMatchObject({
			candidateCount: 2,
			preScoredFilteredCount: 1,
			noSignalCount: 1,
		});
	});

	test('injection diagnostics count all-filtered candidates separately from no-signal', () => {
		const result = scoreMemoryRecordsWithDiagnostics(
			[
				makeRecord({
					text: 'This repository uses database migrations.',
					expiresAt: '2020-01-01T00:00:00.000Z',
				}),
			],
			{
				...makeRequest(),
				query: 'backend database migration strategy',
				mode: 'injection',
				kinds: ['repo_convention'],
				requireQuerySignal: true,
			},
		);

		expect(result.items).toHaveLength(0);
		expect(result.diagnostics).toMatchObject({
			candidateCount: 1,
			preScoredFilteredCount: 1,
			noSignalCount: 0,
		});
	});
});
