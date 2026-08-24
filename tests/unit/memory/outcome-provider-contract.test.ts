import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	DEFAULT_MEMORY_CONFIG,
	LocalJsonlMemoryProvider,
	type MemoryProvider,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

interface ProviderCase {
	name: string;
	create(root: string, hardDelete?: boolean): MemoryProvider;
}

const cases: ProviderCase[] = [
	{
		name: 'local-jsonl',
		create: (root, hardDelete = false) =>
			new LocalJsonlMemoryProvider(root, { enabled: true, hardDelete }),
	},
	{
		name: 'sqlite',
		create: (root, hardDelete = false) =>
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				hardDelete,
			}),
	},
];

let tmpDir: string;
const openProviders: MemoryProvider[] = [];

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-outcome-provider-');
});

afterEach(async () => {
	for (const provider of openProviders.splice(0)) await provider.close?.();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track<T extends MemoryProvider>(provider: T): T {
	openProviders.push(provider);
	return provider;
}

function memoryFile(root: string, fileName: string): string {
	return path.join(root, '.swarm', 'memory', fileName);
}

async function readJsonlLines(filePath: string): Promise<string[]> {
	try {
		return (await fs.readFile(filePath, 'utf-8'))
			.split('\n')
			.filter((line) => line.trim().length > 0);
	} catch {
		return [];
	}
}

function memory(text = 'Prefer the bounded parser.'): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'code_pattern' as const,
		text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['outcomes'],
		confidence: 0.8,
		stability: 'durable',
		source: { type: 'file', filePath: 'src/parser.ts' },
		createdAt: '2026-08-19T10:00:00.000Z',
		updatedAt: '2026-08-19T10:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

for (const providerCase of cases) {
	describe(`${providerCase.name} memory outcomes`, () => {
		test('older records remain unchanged until the first append, then reopen round-trips', async () => {
			const root = path.join(tmpDir, providerCase.name);
			await fs.mkdir(root, { recursive: true });
			const provider = track(providerCase.create(root));
			const base = memory();
			expect(await provider.upsert(base)).toEqual(base);

			const updated = await provider.appendOutcome?.(
				base.id,
				{
					id: 'event-1',
					outcome: {
						outcome: 'useful',
						at: '2026-08-19T11:00:00.000Z',
						taskId: '1.1',
					},
				},
				[{ file: 'src/parser.ts', symbol: 'parseBounded' }],
			);
			expect(updated?.outcomes).toEqual([
				{
					outcome: 'useful',
					at: '2026-08-19T11:00:00.000Z',
					taskId: '1.1',
				},
			]);
			expect(updated?.metadata.outcomeEventIds).toEqual(['event-1']);

			await provider.close?.();
			const reopened = track(providerCase.create(root));
			expect((await reopened.get(base.id))?.outcomes).toEqual(
				updated?.outcomes,
			);
			expect((await reopened.get(base.id))?.anchors).toEqual([
				{ file: 'src/parser.ts', symbol: 'parseBounded' },
			]);
		});

		test('same event replays idempotently while distinct identical events corroborate', async () => {
			const root = path.join(tmpDir, `${providerCase.name}-identity`);
			await fs.mkdir(root, { recursive: true });
			const provider = track(providerCase.create(root));
			const base = memory();
			await provider.upsert(base);
			const outcome = {
				outcome: 'useful' as const,
				at: '2026-08-19T11:00:00.000Z',
				taskId: '1.1',
			};
			await provider.appendOutcome?.(base.id, { id: 'event-a', outcome });
			await provider.appendOutcome?.(base.id, {
				id: 'event-a',
				outcome: {
					...outcome,
					at: '2026-08-19T11:00:01.000Z',
					correction: undefined,
				},
			});
			await provider.appendOutcome?.(base.id, { id: 'event-b', outcome });

			const loaded = await provider.get(base.id);
			expect(loaded?.outcomes).toHaveLength(2);
			expect(loaded?.metadata.outcomeEventIds).toEqual(['event-a', 'event-b']);
			await expect(
				provider.appendOutcome?.(base.id, {
					id: 'event-a',
					outcome: { ...outcome, outcome: 'dead_end' },
				}),
			).rejects.toThrow('different payload');
			await expect(
				provider.appendOutcome?.(base.id, {
					id: 'event-a',
					outcome: { ...outcome, taskId: 'different-task' },
				}),
			).rejects.toThrow('different payload');

			await provider.upsert({ ...base, updatedAt: '2026-08-19T12:00:00.000Z' });
			expect((await provider.get(base.id))?.outcomes).toHaveLength(2);
		});

		test('superseded memories accept outcomes while tombstones reject them', async () => {
			const root = path.join(tmpDir, `${providerCase.name}-lifecycle`);
			await fs.mkdir(root, { recursive: true });
			const provider = track(providerCase.create(root));
			const superseded = {
				...memory('Superseded result.'),
				supersededBy: 'new-id',
			};
			await provider.upsert(superseded);
			expect(
				(
					await provider.appendOutcome?.(superseded.id, {
						id: 'superseded-event',
						outcome: {
							outcome: 'corrected',
							at: '2026-08-19T11:00:00.000Z',
							correction: 'Use the replacement.',
						},
					})
				)?.outcomes,
			).toHaveLength(1);

			const tombstone = memory('Tombstoned result.');
			await provider.upsert(tombstone);
			await provider.delete(tombstone.id, 'obsolete');
			await expect(
				provider.appendOutcome?.(tombstone.id, {
					id: 'rejected-event',
					outcome: {
						outcome: 'dead_end',
						at: '2026-08-19T11:00:00.000Z',
					},
				}),
			).rejects.toThrow('deleted');
		});

		test('rejects invalid or secret correction payloads before persistence', async () => {
			const root = path.join(tmpDir, `${providerCase.name}-outcome-policy`);
			await fs.mkdir(root, { recursive: true });
			const provider = track(providerCase.create(root));
			const base = memory('Provider policy result.');
			await provider.upsert(base);

			await expect(
				provider.appendOutcome?.(base.id, {
					id: 'missing-correction',
					outcome: {
						outcome: 'corrected',
						at: '2026-08-19T11:00:00.000Z',
					},
				}),
			).rejects.toThrow('corrected outcomes require correction text');
			await expect(
				provider.appendOutcome?.(base.id, {
					id: 'secret-correction',
					outcome: {
						outcome: 'corrected',
						at: '2026-08-19T11:00:01.000Z',
						correction:
							'Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz12345',
					},
				}),
			).rejects.toThrow('likely secret');
			await expect(
				provider.appendOutcome?.(base.id, {
					id: 'misplaced-correction',
					outcome: {
						outcome: 'useful',
						at: '2026-08-19T11:00:02.000Z',
						correction: 'Not valid for this outcome.',
					},
				}),
			).rejects.toThrow('only valid for corrected outcomes');
			expect(await provider.listOutcomeEvents?.()).toEqual([]);

			await expect(
				provider.upsert({
					...base,
					metadata: {
						outcomeGeneration: 'import-generation',
						outcomeEventIds: ['import-secret'],
					},
					outcomes: [
						{
							outcome: 'corrected',
							at: '2026-08-19T11:00:03.000Z',
							correction:
								'Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz12345',
						},
					],
				}),
			).rejects.toThrow('likely secret');
			expect(await provider.listOutcomeEvents?.()).toEqual([]);
		});

		test('hard delete and same-id recreation cannot resurrect prior-generation outcomes', async () => {
			const root = path.join(tmpDir, `${providerCase.name}-generation`);
			await fs.mkdir(root, { recursive: true });
			const provider = track(providerCase.create(root, true));
			const base = memory();
			await provider.upsert(base);
			await provider.appendOutcome?.(base.id, {
				id: 'old-event',
				outcome: {
					outcome: 'dead_end',
					at: '2026-08-19T11:00:00.000Z',
				},
			});
			await provider.delete(base.id, 'replace result');
			await provider.upsert({
				...base,
				createdAt: '2026-08-19T12:00:00.000Z',
				updatedAt: '2026-08-19T12:00:00.000Z',
			});

			await provider.close?.();
			const reopened = track(providerCase.create(root, true));
			expect((await reopened.get(base.id))?.outcomes).toBeUndefined();
		});
	});
}

test('two initialized JSONL providers do not lose racing outcome appends', async () => {
	const root = path.join(tmpDir, 'jsonl-concurrent');
	await fs.mkdir(root, { recursive: true });
	const first = track(cases[0]!.create(root));
	const second = track(cases[0]!.create(root));
	const base = memory();
	await first.upsert(base);
	await second.get(base.id);

	await Promise.all([
		first.appendOutcome?.(base.id, {
			id: 'race-a',
			outcome: { outcome: 'useful', at: '2026-08-19T11:00:00.000Z' },
		}),
		second.appendOutcome?.(base.id, {
			id: 'race-b',
			outcome: { outcome: 'useful', at: '2026-08-19T11:00:01.000Z' },
		}),
	]);

	expect((await first.get(base.id))?.metadata.outcomeEventIds).toEqual([
		'race-a',
		'race-b',
	]);
});

test('two initialized SQLite providers observe all outcome appends', async () => {
	const root = path.join(tmpDir, 'sqlite-concurrent');
	await fs.mkdir(root, { recursive: true });
	const first = track(cases[1]!.create(root));
	const second = track(cases[1]!.create(root));
	const base = memory();
	await first.upsert(base);
	await second.get(base.id);

	await Promise.all([
		first.appendOutcome?.(base.id, {
			id: 'sqlite-race-a',
			outcome: { outcome: 'useful', at: '2026-08-19T11:00:00.000Z' },
		}),
		second.appendOutcome?.(base.id, {
			id: 'sqlite-race-b',
			outcome: { outcome: 'dead_end', at: '2026-08-19T11:00:01.000Z' },
		}),
	]);

	expect((await first.get(base.id))?.metadata.outcomeEventIds).toEqual([
		'sqlite-race-a',
		'sqlite-race-b',
	]);
});
