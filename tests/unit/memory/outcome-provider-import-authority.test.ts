import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryOutcomeEvent,
	type MemoryRecord,
	readMigrationReport,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
const providers: SQLiteMemoryProvider[] = [];

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-outcome-authority-');
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

function event(
	id: string,
	memory: MemoryRecord,
	outcome: 'useful' | 'dead_end' = 'useful',
): MemoryOutcomeEvent {
	return {
		id,
		memoryId: memory.id,
		generation: String(memory.metadata.outcomeGeneration),
		outcome: {
			outcome,
			at: '2026-08-02T00:00:00.000Z',
			taskId: 'task-1',
		},
		anchors: [{ file: 'src/canonical.ts' }],
	};
}

function memoryDir(root: string): string {
	return path.join(root, '.swarm', 'memory');
}

async function makeRoot(name: string): Promise<string> {
	const root = path.join(tmpDir, name);
	await fs.mkdir(memoryDir(root), { recursive: true });
	return root;
}

function provider(root: string): SQLiteMemoryProvider {
	return track(
		new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
	);
}

describe('SQLite initial outcome import authority', () => {
	test('canonical outcome rows override conflicting materialized snapshots', async () => {
		const root = await makeRoot('canonical-authority');
		const snapshot = record('canonical authority result', 'generation-a');
		snapshot.metadata.outcomeEventIds = ['shared-event'];
		snapshot.outcomes = [
			{
				outcome: 'useful',
				at: '2026-08-02T00:00:00.000Z',
				taskId: 'task-1',
			},
		];
		snapshot.anchors = [{ file: 'src/materialized.ts' }];
		const canonical = event('shared-event', snapshot, 'dead_end');
		await fs.writeFile(
			path.join(memoryDir(root), 'memories.jsonl'),
			`${JSON.stringify(snapshot)}\n`,
			'utf-8',
		);
		await fs.writeFile(
			path.join(memoryDir(root), 'outcome-events.jsonl'),
			`${JSON.stringify(canonical)}\n`,
			'utf-8',
		);

		const first = provider(root);
		const result = await first.importJsonl();
		expect(result).toMatchObject({
			importedMemories: 1,
			importedOutcomes: 1,
			invalidRows: [
				{
					file: 'memories.jsonl',
					line: 1,
					error: 'outcome event id already exists with a different payload',
				},
			],
			totalRows: 2,
		});
		expect((await first.get(snapshot.id))?.outcomes).toEqual([
			canonical.outcome,
		]);

		first.close();
		const reopened = provider(root);
		expect((await reopened.get(snapshot.id))?.outcomes).toEqual([
			canonical.outcome,
		]);
		expect((await readMigrationReport(root))?.importedOutcomes).toBe(1);
	});

	test('conflicting materialized snapshots isolate the later source row', async () => {
		const root = await makeRoot('snapshot-collision');
		const firstMemory = record('first materialized result', 'generation-first');
		const secondMemory = record(
			'second materialized result',
			'generation-second',
		);
		for (const [memory, outcome] of [
			[firstMemory, 'useful'],
			[secondMemory, 'dead_end'],
		] as const) {
			memory.metadata.outcomeEventIds = ['snapshot-collision'];
			memory.outcomes = [
				{
					outcome,
					at: '2026-08-02T00:00:00.000Z',
					taskId: 'task-1',
				},
			];
			memory.anchors = [{ file: `src/${outcome}.ts` }];
		}
		await fs.writeFile(
			path.join(memoryDir(root), 'memories.jsonl'),
			`${[firstMemory, secondMemory].map(JSON.stringify).join('\n')}\n`,
			'utf-8',
		);

		const first = provider(root);
		const result = await first.importJsonl();
		expect(result).toMatchObject({
			importedMemories: 2,
			importedOutcomes: 1,
			invalidRows: [
				{
					file: 'memories.jsonl',
					line: 2,
					error: 'outcome event id already exists with a different payload',
				},
			],
			totalRows: 2,
		});
		expect((await first.get(firstMemory.id))?.outcomes).toHaveLength(1);
		expect((await first.get(secondMemory.id))?.outcomes).toBeUndefined();

		first.close();
		const reopened = provider(root);
		expect((await reopened.get(firstMemory.id))?.outcomes).toHaveLength(1);
		expect((await reopened.get(secondMemory.id))?.outcomes).toBeUndefined();
		expect((await readMigrationReport(root))?.invalidRows).toHaveLength(1);
	});

	test('invalid newest memory row shadows an older valid row', async () => {
		const root = await makeRoot('invalid-newest');
		const valid = record('shadowed result', 'shadow-generation');
		const invalid = { ...valid, contentHash: 'invalid-newest-row' };
		await fs.writeFile(
			path.join(memoryDir(root), 'memories.jsonl'),
			`${[valid, invalid].map(JSON.stringify).join('\n')}\n`,
			'utf-8',
		);

		const first = provider(root);
		const result = await first.importJsonl();
		expect(result).toMatchObject({
			importedMemories: 0,
			importedOutcomes: 0,
			invalidRows: [{ file: 'memories.jsonl', line: 2 }],
			totalRows: 2,
		});
		expect(await first.get(valid.id)).toBeNull();

		first.close();
		const reopened = provider(root);
		expect(await reopened.get(valid.id)).toBeNull();
		expect((await readMigrationReport(root))?.importedMemories).toBe(0);
	});
});
