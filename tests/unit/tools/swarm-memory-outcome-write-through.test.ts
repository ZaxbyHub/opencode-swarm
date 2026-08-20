import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	LocalJsonlMemoryProvider,
	type MemoryRecord,
} from '../../../src/memory';
import { evictAndClose } from '../../../src/memory/provider-pool';
import { swarm_memory_outcome } from '../../../src/tools/swarm-memory-outcome';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let root: string;

function storedMemory(
	text: string,
	overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo' },
		kind: 'code_pattern' as const,
		text,
		tags: ['reflection'],
		confidence: 0.8,
		stability: 'durable' as const,
		source: { type: 'file' as const, filePath: 'README.md' },
		createdAt: '2026-08-19T00:00:00.000Z',
		updatedAt: '2026-08-20T11:00:00.000Z',
		metadata: {},
		anchors: [{ file: 'README.md' }],
	};
	return {
		...base,
		id: createMemoryId(base),
		contentHash: computeMemoryContentHash(base),
		...overrides,
	};
}

beforeEach(async () => {
	root = canonicalMkdtemp('swarm-outcome-write-through-');
	await fs.mkdir(path.join(root, '.git'));
	await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n', 'utf-8');
	await fs.mkdir(path.join(root, '.opencode'));
	await fs.writeFile(
		path.join(root, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			memory: {
				enabled: true,
				provider: 'local-jsonl',
				reflection: { enabled: false, halfLifeDays: 30 },
			},
		}),
		'utf-8',
	);
});

afterEach(async () => {
	evictAndClose(root);
	await fs.rm(root, { recursive: true, force: true });
});

describe('swarm_memory_outcome write-through', () => {
	test('lessons artifacts exist before the default-off tool call returns', async () => {
		const result = await swarm_memory_outcome.execute(
			{
				question: 'Which parser should handle the memory file?',
				outcome: 'useful',
				anchors: [{ file: 'README.md' }],
			},
			{
				directory: root,
				worktree: root,
				sessionID: 'session-write-through',
				messageID: 'message-write-through',
				agent: 'coder',
				abort: new AbortController().signal,
				metadata: () => {},
				ask: async () => {},
			} as any,
		);
		const parsed = JSON.parse(result);
		const markdownPath = path.join(root, '.swarm', 'reflections', 'lessons.md');
		const jsonPath = path.join(root, '.swarm', 'reflections', 'lessons.json');

		if (parsed.success !== true) throw new Error(JSON.stringify(parsed));
		expect(parsed.success).toBe(true);
		expect(parsed.reflection_updated).toBe(true);
		expect(existsSync(markdownPath)).toBe(true);
		expect(existsSync(jsonPath)).toBe(true);
		expect(await fs.readFile(markdownPath, 'utf-8')).toContain(
			'Which parser should handle the memory file?',
		);
	});

	test('reports committed partial success and retries reflection without duplicating the outcome', async () => {
		const reflectionDir = path.join(root, '.swarm', 'reflections');
		const markdownPath = path.join(reflectionDir, 'lessons.md');
		await fs.mkdir(markdownPath, { recursive: true });
		const args = {
			question: 'How is a committed outcome retried safely?',
			outcome: 'useful' as const,
			anchors: [{ file: 'README.md' }],
		};
		const context = {
			directory: root,
			worktree: root,
			sessionID: 'session-partial',
			messageID: 'message-partial',
			agent: 'coder',
			abort: new AbortController().signal,
			metadata: () => {},
			task: async () => {},
		} as any;

		const partial = JSON.parse(
			await swarm_memory_outcome.execute(args, context),
		);

		expect(partial).toMatchObject({
			success: true,
			status: 'partial',
			partial: true,
			outcome_recorded: true,
			reflection_updated: false,
			outcomes: 1,
		});
		expect(partial.event_id).toMatch(/^tool-[a-f0-9]{32}$/);
		expect(partial.error).toBeString();
		expect(partial.reflection_error).toBeString();

		await fs.rm(markdownPath, { recursive: true });
		const retry = JSON.parse(await swarm_memory_outcome.execute(args, context));

		expect(retry).toMatchObject({
			success: true,
			status: 'complete',
			partial: false,
			outcome_recorded: true,
			reflection_updated: true,
			outcomes: 1,
		});
		expect(retry.event_id).toBe(partial.event_id);
		expect(retry.memory_id).toBe(partial.memory_id);
		expect(existsSync(markdownPath)).toBe(true);
	});

	test('persists only the committed negative evidence for superseded and expired targets', async () => {
		const provider = new LocalJsonlMemoryProvider(root, { enabled: true });
		const supersededSeed = storedMemory('Superseded parser lesson', {
			supersededBy: 'mem_cccccccccccccccc',
		});
		const expiredSeed = storedMemory('Expired parser lesson', {
			expiresAt: '2020-01-01T00:00:00.000Z',
		});
		const supersededId = supersededSeed.id;
		const expiredId = expiredSeed.id;
		try {
			for (const seeded of [supersededSeed, expiredSeed]) {
				await provider.upsert(seeded);
				await provider.appendOutcome(seeded.id, {
					id: `prior-useful-${seeded.id}`,
					outcome: {
						outcome: 'useful',
						at: '2026-08-20T10:00:00.000Z',
					},
				});
			}
		} finally {
			await (provider as unknown as { close?: () => Promise<void> }).close?.();
		}

		const context = {
			directory: root,
			worktree: root,
			sessionID: 'session-inactive-evidence',
			agent: 'coder',
			abort: new AbortController().signal,
			metadata: () => {},
			task: async () => {},
		} as any;
		const supersededResult = JSON.parse(
			await swarm_memory_outcome.execute(
				{ memory_id: supersededId, outcome: 'dead_end' },
				{ ...context, messageID: 'message-superseded' },
			),
		);
		const digestPath = path.join(root, '.swarm', 'reflections', 'lessons.json');
		const supersededDigest = JSON.parse(await fs.readFile(digestPath, 'utf-8'));

		expect(supersededResult).toMatchObject({
			success: true,
			outcome_recorded: true,
			reflection_updated: true,
		});
		expect(supersededDigest.generatedFrom.entries).toBe(1);
		expect(supersededDigest.deadEnds[0]?.memoryId).toBe(supersededId);
		expect(supersededDigest.preferred).toEqual([]);
		expect(supersededDigest.tentative).toEqual([]);
		expect(supersededDigest.contested).toEqual([]);

		const correction = 'Use the replacement parser instead.';
		const expiredResult = JSON.parse(
			await swarm_memory_outcome.execute(
				{
					memory_id: expiredId,
					outcome: 'corrected',
					correction,
				},
				{ ...context, messageID: 'message-expired' },
			),
		);
		const expiredDigest = JSON.parse(await fs.readFile(digestPath, 'utf-8'));
		const markdown = await fs.readFile(
			path.join(root, '.swarm', 'reflections', 'lessons.md'),
			'utf-8',
		);

		expect(expiredResult).toMatchObject({
			success: true,
			outcome_recorded: true,
			reflection_updated: true,
		});
		expect(expiredDigest.generatedFrom.entries).toBe(1);
		expect(expiredDigest.deadEnds[0]?.memoryId).toBe(expiredId);
		expect(expiredDigest.corrections[0]?.correction).toBe(correction);
		expect(expiredDigest.preferred).toEqual([]);
		expect(expiredDigest.tentative).toEqual([]);
		expect(expiredDigest.contested).toEqual([]);
		expect(markdown).toContain(correction);
	});
});
