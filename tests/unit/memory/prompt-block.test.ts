import { describe, expect, test } from 'bun:test';
import {
	buildRecallPromptBlock,
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	type RecallResultItem,
} from '../../../src/memory';

function makeItem(text: string): RecallResultItem {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'repo_convention' as const,
		text,
	};
	const record: MemoryRecord = {
		id: createMemoryId(base),
		...base,
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'README.md' },
		createdAt: '2026-05-24T12:00:00.000Z',
		updatedAt: '2026-05-24T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
	return { record, score: 0.8, reason: 'test' };
}

describe('memory prompt block', () => {
	test('returns the untrusted header when there are no recall items', () => {
		const block = buildRecallPromptBlock([], 1000);

		expect(block.items).toEqual([]);
		expect(block.promptBlock).toContain('## Retrieved Swarm Memory');
		expect(block.promptBlock).toContain('untrusted retrieved facts');
	});

	test('cuts off items that exceed the token budget', () => {
		const small = makeItem('Use bun for tests.');
		const large = makeItem('Large note. '.repeat(400));

		const block = buildRecallPromptBlock([small, large], 300);

		expect(block.items.map((item) => item.record.id)).toEqual([
			small.record.id,
		]);
		expect(block.promptBlock).toContain('Use bun for tests.');
		expect(block.promptBlock).not.toContain('Large note.');
	});
});
