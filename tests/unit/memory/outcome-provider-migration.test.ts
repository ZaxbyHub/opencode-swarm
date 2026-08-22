import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	LEGACY_JSONL_OUTCOME_META_KEY,
	type MemoryOutcomeEvent,
	type MemoryRecord,
	readMigrationReport,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { _internals } from '../../../src/memory/memory-family-migration';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
const providers: SQLiteMemoryProvider[] = [];

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-outcome-migration-');
});

afterEach(async () => {
	for (const provider of providers.splice(0)) provider.close();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(provider: SQLiteMemoryProvider): SQLiteMemoryProvider {
	providers.push(provider);
	return provider;
}

function record(text: string, generation: string): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'evidence' as const,
		text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['outcome'],
		confidence: 0.8,
		stability: 'durable',
		source: { type: 'tool', ref: 'migration-test' },
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-01T00:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: { outcomeGeneration: generation },
	};
}

function outcomeEvent(
	id: string,
	memory: MemoryRecord,
	at = '2026-08-02T00:00:00.000Z',
): MemoryOutcomeEvent {
	return {
		id,
		memoryId: memory.id,
		generation: String(memory.metadata.outcomeGeneration),
		outcome: { outcome: 'useful', at, taskId: 'task-1' },
		anchors: [{ file: 'src/memory/gateway.ts', symbol: 'MemoryGateway' }],
	};
}

function memoryDir(root: string): string {
	return path.join(root, '.swarm', 'memory');
}

async function root(name: string): Promise<string> {
	const value = path.join(tmpDir, name);
	await fs.mkdir(value, { recursive: true });
	return value;
}

describe('outcome event migration and export lifecycle', () => {
	test('imports older materialized JSONL outcomes without a canonical event file', async () => {
		const target = await root('materialized-only');
		const legacy = record('materialized legacy result', 'legacy-generation');
		legacy.metadata = {
			outcomeEventIds: ['legacy-duplicate-a', 'legacy-duplicate-b'],
		};
		legacy.outcomes = [
			{
				outcome: 'corrected',
				at: '2026-08-02T00:00:00.000Z',
				correction: 'Use the canonical parser.',
			},
			{
				outcome: 'corrected',
				at: '2026-08-02T00:00:00.000Z',
				correction: 'Use the canonical parser.',
			},
		];
		legacy.anchors = [{ file: 'src/legacy.ts' }];
		await fs.mkdir(memoryDir(target), { recursive: true });
		await fs.writeFile(
			path.join(memoryDir(target), 'memories.jsonl'),
			`${JSON.stringify(legacy)}\n`,
			'utf-8',
		);

		const provider = track(
			new SQLiteMemoryProvider(target, { enabled: true, provider: 'sqlite' }),
		);
		const loaded = await provider.get(legacy.id);

		expect(loaded?.outcomes).toEqual(legacy.outcomes);
		expect(loaded?.anchors).toEqual(legacy.anchors);
		expect(loaded?.metadata.outcomeEventIds).toEqual([
			'legacy-duplicate-a',
			'legacy-duplicate-b',
		]);
	});

	test('imports outcome events when legacy v2 is already marked', async () => {
		const target = await root('old-v2');
		const memory = record('old database result', 'generation-old');
		const first = track(
			new SQLiteMemoryProvider(target, { enabled: true, provider: 'sqlite' }),
		);
		await first.upsert(memory);
		first.close();

		const dbPath = path.join(memoryDir(target), 'memory.db');
		const db = new Database(dbPath);
		try {
			expect(
				db
					.query<{ n: number }, []>(
						"SELECT COUNT(*) AS n FROM schema_migrations WHERE name='legacy_jsonl_import_complete'",
					)
					.get()?.n,
			).toBe(1);
			expect(
				db
					.query<{ value: string }, [string]>(
						'SELECT value FROM _meta WHERE key = ?',
					)
					.get(LEGACY_JSONL_OUTCOME_META_KEY)?.value,
			).toBe('missing');
		} finally {
			db.close();
		}

		const event = outcomeEvent('legacy-outcome-1', memory);
		await fs.writeFile(
			path.join(memoryDir(target), 'outcome-events.jsonl'),
			`${JSON.stringify(event)}\n`,
			'utf-8',
		);
		const reopened = track(
			new SQLiteMemoryProvider(target, { enabled: true, provider: 'sqlite' }),
		);
		const loaded = await reopened.get(memory.id);
		expect(loaded?.outcomes).toEqual([event.outcome]);
		expect(loaded?.metadata.outcomeEventIds).toEqual([event.id]);

		const verify = new Database(dbPath, { readonly: true });
		try {
			expect(
				verify
					.query<{ value: string }, [string]>(
						'SELECT value FROM _meta WHERE key = ?',
					)
					.get(LEGACY_JSONL_OUTCOME_META_KEY)?.value,
			).toBeString();
		} finally {
			verify.close();
		}
	});

	for (const scenario of ['initial import', 'outcome-only catch-up'] as const) {
		test(`${scenario} isolates orphan and conflicting outcome rows`, async () => {
			const target = await root(scenario.replaceAll(' ', '-'));
			const memory = record(`${scenario} result`, `${scenario}-generation`);
			await fs.mkdir(memoryDir(target), { recursive: true });
			if (scenario === 'initial import') {
				await fs.writeFile(
					path.join(memoryDir(target), 'memories.jsonl'),
					`${JSON.stringify(memory)}\n`,
					'utf-8',
				);
			} else {
				const seeded = track(
					new SQLiteMemoryProvider(target, {
						enabled: true,
						provider: 'sqlite',
					}),
				);
				await seeded.upsert(memory);
				seeded.close();
			}

			const first = outcomeEvent('valid-a', memory);
			const orphan = {
				...outcomeEvent('orphan', memory),
				memoryId: 'missing-memory',
			};
			const conflict = {
				...first,
				outcome: { ...first.outcome, outcome: 'dead_end' as const },
			};
			const last = outcomeEvent('valid-b', memory, '2026-08-02T00:00:01.000Z');
			await fs.writeFile(
				path.join(memoryDir(target), 'outcome-events.jsonl'),
				`${[first, orphan, conflict, last].map(JSON.stringify).join('\n')}\n`,
				'utf-8',
			);

			const provider = track(
				new SQLiteMemoryProvider(target, {
					enabled: true,
					provider: 'sqlite',
				}),
			);
			const imported = await provider.importJsonl();
			expect(imported).toMatchObject({
				importedMemories: scenario === 'initial import' ? 1 : 0,
				importedOutcomes: 2,
				invalidRows: [
					{
						file: 'outcome-events.jsonl',
						line: 2,
						error: 'target memory was not found',
					},
					{
						file: 'outcome-events.jsonl',
						line: 3,
						error: 'outcome event id already exists with a different payload',
					},
				],
			});
			expect(imported.totalRows).toBe(scenario === 'initial import' ? 5 : 4);
			expect((await provider.get(memory.id))?.metadata.outcomeEventIds).toEqual(
				['valid-a', 'valid-b'],
			);
			const report = await readMigrationReport(target, {
				enabled: true,
				provider: 'sqlite',
			});
			expect(report?.importedOutcomes).toBe(2);
			expect(report?.invalidRows).toHaveLength(2);

			provider.close();
			const reopened = track(
				new SQLiteMemoryProvider(target, {
					enabled: true,
					provider: 'sqlite',
				}),
			);
			expect((await reopened.get(memory.id))?.outcomes).toHaveLength(2);
			expect(
				(
					await readMigrationReport(target, {
						enabled: true,
						provider: 'sqlite',
					})
				)?.importedOutcomes,
			).toBe(2);
		});
	}

	test('SQLite JSONL export and import preserve duplicate event identities', async () => {
		const sourceRoot = await root('source');
		const memory = record('round-trip result', 'generation-roundtrip');
		const source = track(
			new SQLiteMemoryProvider(sourceRoot, {
				enabled: true,
				provider: 'sqlite',
			}),
		);
		await source.upsert(memory);
		const outcome = {
			outcome: 'useful' as const,
			at: '2026-08-02T00:00:00.000Z',
			taskId: 'same-task',
		};
		await source.appendOutcome(memory.id, { id: 'duplicate-a', outcome }, [
			{ file: 'src/a.ts' },
		]);
		await source.appendOutcome(memory.id, { id: 'duplicate-b', outcome }, [
			{ file: 'src/a.ts' },
		]);
		const exported = await source.exportJsonl();
		expect(exported.outcomes).toBe(2);

		const destinationRoot = await root('destination');
		await fs.mkdir(memoryDir(destinationRoot), { recursive: true });
		for (const [from, filename] of [
			[exported.memoriesPath, 'memories.jsonl'],
			[exported.proposalsPath, 'proposals.jsonl'],
			[exported.outcomesPath, 'outcome-events.jsonl'],
		] as const) {
			await fs.copyFile(from, path.join(memoryDir(destinationRoot), filename));
		}

		const destination = track(
			new SQLiteMemoryProvider(destinationRoot, {
				enabled: true,
				provider: 'sqlite',
			}),
		);
		const loaded = await destination.get(memory.id);
		expect(loaded?.outcomes).toEqual([outcome, outcome]);
		expect(loaded?.metadata.outcomeEventIds).toEqual([
			'duplicate-a',
			'duplicate-b',
		]);
		expect(loaded?.anchors).toEqual([{ file: 'src/a.ts' }]);
	});

	test('non-empty SQLite cohort merge includes canonical outcome rows', async () => {
		const sourceRoot = await root('merge-source');
		const destinationRoot = await root('merge-destination');
		const sourceMemory = record('source result', 'source-generation');
		const destinationMemory = record(
			'destination result',
			'destination-generation',
		);
		const source = track(
			new SQLiteMemoryProvider(sourceRoot, {
				enabled: true,
				provider: 'sqlite',
			}),
		);
		const destination = track(
			new SQLiteMemoryProvider(destinationRoot, {
				enabled: true,
				provider: 'sqlite',
			}),
		);
		await source.upsert(sourceMemory);
		await source.appendOutcome(
			sourceMemory.id,
			{
				id: 'source-event',
				outcome: { outcome: 'useful', at: '2026-08-03T00:00:00.000Z' },
			},
			[{ file: 'src/source.ts' }],
		);
		await destination.upsert(destinationMemory);
		source.close();
		destination.close();

		const staged = _internals.stageSqliteDb(
			memoryDir(sourceRoot),
			memoryDir(destinationRoot),
		);
		expect(staged).not.toBeNull();
		await _internals.mergeStagedSqlite(
			memoryDir(destinationRoot),
			staged!.stagedPath,
		);

		const reopened = track(
			new SQLiteMemoryProvider(destinationRoot, {
				enabled: true,
				provider: 'sqlite',
			}),
		);
		expect(
			(await reopened.get(sourceMemory.id))?.metadata.outcomeEventIds,
		).toEqual(['source-event']);
		expect(await reopened.get(destinationMemory.id)).not.toBeNull();
	});
});
