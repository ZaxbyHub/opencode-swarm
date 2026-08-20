import { describe, expect, test } from 'bun:test';
import {
	buildReflectionDigest,
	type ReflectionAnchorStatus,
	renderReflectionMarkdown,
} from '../../../src/memory/reflection';
import type { MemoryRecord } from '../../../src/memory/types';

const NOW = new Date('2026-08-19T12:00:00.000Z');

function record(
	id: string,
	file: string,
	outcomes: MemoryRecord['outcomes'],
): MemoryRecord {
	return {
		id,
		scope: { type: 'repository', repoId: 'repo' },
		kind: 'code_pattern',
		text: `Lesson ${id}`,
		tags: ['reflection'],
		confidence: 0.8,
		stability: 'durable',
		source: { type: 'file', filePath: file },
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-08-19T00:00:00.000Z',
		contentHash: `hash-${id}`,
		metadata: {
			outcomeEventIds: outcomes?.map((_, index) => `${id}-event-${index}`),
			outcomeGeneration: `${id}-generation`,
		},
		anchors: [{ file }],
		outcomes,
	};
}

const alive =
	(boundary = 'pkg/core') =>
	(_anchor: { file: string }): ReflectionAnchorStatus => ({
		alive: true,
		packageBoundary: boundary,
	});

describe('buildReflectionDigest', () => {
	test('uses signed decay, corroboration, and recency-resolved contesting', () => {
		const digest = buildReflectionDigest(
			[
				record('tentative', 'src/tentative.ts', [
					{ outcome: 'useful', at: '2026-08-19T11:00:00.000Z' },
				]),
				record('preferred', 'src/preferred.ts', [
					{ outcome: 'useful', at: '2026-08-18T12:00:00.000Z' },
					{ outcome: 'useful', at: '2026-08-19T10:00:00.000Z' },
				]),
				record('contested', 'src/contested.ts', [
					{ outcome: 'useful', at: '2026-05-01T12:00:00.000Z' },
					{ outcome: 'dead_end', at: '2026-08-19T11:30:00.000Z' },
				]),
			],
			NOW,
			{ resolveAnchor: alive() },
		);

		expect(digest.tentative.map((item) => item.memoryId)).toEqual([
			'tentative',
		]);
		expect(digest.preferred.map((item) => item.memoryId)).toEqual([
			'preferred',
		]);
		expect(digest.contested).toHaveLength(1);
		expect(digest.contested[0]?.resolution).toBe('dead_end');
		expect(digest.contested[0]?.score).toBeLessThan(0);
	});

	test('counts distinct events, not task ids, for corroboration', () => {
		const digest = buildReflectionDigest(
			[
				record('same-task', 'src/same-task.ts', [
					{
						outcome: 'useful',
						at: '2026-08-19T10:00:00.000Z',
						taskId: '1.1',
					},
					{
						outcome: 'useful',
						at: '2026-08-19T11:00:00.000Z',
						taskId: '1.1',
					},
				]),
			],
			NOW,
			{ resolveAnchor: alive() },
		);

		expect(digest.preferred.map((item) => item.memoryId)).toEqual([
			'same-task',
		]);
	});

	test('deduplicates replayed event ids before scoring', () => {
		const replayed = record('replayed', 'src/replayed.ts', [
			{ outcome: 'useful', at: '2026-08-19T10:00:00.000Z' },
			{ outcome: 'useful', at: '2026-08-19T10:00:00.000Z' },
		]);
		replayed.metadata.outcomeEventIds = ['same-event', 'same-event'];
		const digest = buildReflectionDigest([replayed], NOW, {
			resolveAnchor: alive(),
		});

		expect(digest.preferred).toHaveLength(0);
		expect(digest.tentative).toHaveLength(1);
	});

	test('prunes all-dead anchors, groups live anchors, and falls back flat', () => {
		const entries = [
			record('live', 'packages/core/live.ts', [
				{ outcome: 'useful', at: '2026-08-18T12:00:00.000Z' },
				{ outcome: 'useful', at: '2026-08-19T10:00:00.000Z' },
				{ outcome: 'useful', at: '2026-08-19T11:00:00.000Z' },
			]),
			record('deleted', 'packages/old/deleted.ts', [
				{ outcome: 'useful', at: '2026-08-17T12:00:00.000Z' },
				{ outcome: 'useful', at: '2026-08-18T12:00:00.000Z' },
				{ outcome: 'useful', at: '2026-08-19T09:00:00.000Z' },
			]),
		];
		const resolveAnchor = (anchor: { file: string }): ReflectionAnchorStatus =>
			anchor.file.includes('deleted')
				? { alive: false }
				: { alive: true, packageBoundary: 'packages/core' };
		const digest = buildReflectionDigest(entries, NOW, { resolveAnchor });

		expect(digest.preferred).toHaveLength(1);
		expect(digest.preferred[0]?.group).toBe('packages/core');
		expect(digest.deadAnchorMemoryIds).toEqual(['deleted']);
		expect(renderReflectionMarkdown(digest)).toBe(
			renderReflectionMarkdown(
				buildReflectionDigest(entries, NOW, { resolveAnchor }),
			),
		);

		const flat = buildReflectionDigest([entries[0]!], NOW);
		expect(flat.preferred[0]?.group).toBeUndefined();
	});

	test('emits corrections and produces byte-stable rounded ordering', () => {
		const entries = [
			record('b', 'src/b.ts', [
				{
					outcome: 'corrected',
					at: '2026-08-19T11:00:00.000Z',
					correction: 'Use the bounded loader.',
				},
			]),
			record('a', 'src/a.ts', [
				{ outcome: 'dead_end', at: '2026-08-19T11:00:00.000Z' },
			]),
		];
		const first = buildReflectionDigest(entries, NOW, {
			resolveAnchor: alive('src'),
			halfLifeDays: 30,
		});
		const second = buildReflectionDigest([...entries].reverse(), NOW, {
			resolveAnchor: alive('src'),
			halfLifeDays: 30,
		});

		expect(first.corrections[0]?.correction).toBe('Use the bounded loader.');
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(renderReflectionMarkdown(first)).toBe(
			renderReflectionMarkdown(second),
		);
	});
});
