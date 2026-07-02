import { describe, expect, test } from 'bun:test';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	type RecallRequest,
} from '../../../src/memory';
import {
	SCORING_WEIGHTS,
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

	test('recall suppresses low-Q memories unless includeLowQ is set', () => {
		const lowQ = makeRecord({
			text: 'This repository uses bun for tests.',
			qValue: 0.1,
		});
		const suppressed = scoreMemoryRecord(lowQ, {
			...makeRequest(),
			suppressionThreshold: 0.15,
		});
		const included = scoreMemoryRecord(lowQ, {
			...makeRequest(),
			suppressionThreshold: 0.15,
			includeLowQ: true,
		});

		expect(suppressed).toBeNull();
		expect(included).not.toBeNull();
		expect(included?.signals.qValue).toBe(0.1);
	});

	test('Q-value boost changes ranking for otherwise equivalent memories', () => {
		const highQ = makeRecord({
			id: 'mem_highq000000000',
			qValue: 0.9,
		});
		const lowQ = makeRecord({
			id: 'mem_lowq0000000000',
			qValue: 0.2,
		});
		const result = scoreMemoryRecordsWithDiagnostics([lowQ, highQ], {
			...makeRequest(),
			qValueBoostWeight: 0.1,
			includeLowQ: true,
		});

		expect(result.items.map((item) => item.record.id)).toEqual([
			'mem_highq000000000',
			'mem_lowq0000000000',
		]);
		expect(result.items[0]?.reason).toContain('q_value=0.90');
	});
});

describe('SCORING_WEIGHTS pinned', () => {
	test('textOverlap is 0.38', () => {
		expect(SCORING_WEIGHTS.textOverlap).toBe(0.38);
	});
	test('tagOverlap is 0.16', () => {
		expect(SCORING_WEIGHTS.tagOverlap).toBe(0.16);
	});
	test('fileOverlap is 0.12', () => {
		expect(SCORING_WEIGHTS.fileOverlap).toBe(0.12);
	});
	test('symbolOverlap is 0.08', () => {
		expect(SCORING_WEIGHTS.symbolOverlap).toBe(0.08);
	});
	test('taskTermOverlap is 0.08', () => {
		expect(SCORING_WEIGHTS.taskTermOverlap).toBe(0.08);
	});
	test('scopeSpecificityBoost is 0.12', () => {
		expect(SCORING_WEIGHTS.scopeSpecificityBoost).toBe(0.12);
	});
	test('kindProfileBoost is 0.06', () => {
		expect(SCORING_WEIGHTS.kindProfileBoost).toBe(0.06);
	});
	test('roleBoost is 0.05', () => {
		expect(SCORING_WEIGHTS.roleBoost).toBe(0.05);
	});
	test('confidence is 0.08', () => {
		expect(SCORING_WEIGHTS.confidence).toBe(0.08);
	});
});
