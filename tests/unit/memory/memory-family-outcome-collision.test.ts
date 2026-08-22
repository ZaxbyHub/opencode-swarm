import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryOutcomeEvent,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { _internals } from '../../../src/memory/memory-family-migration';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
const providers: SQLiteMemoryProvider[] = [];

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-family-outcomes-');
});

afterEach(async () => {
	for (const provider of providers.splice(0)) provider.close();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(provider: SQLiteMemoryProvider): SQLiteMemoryProvider {
	providers.push(provider);
	return provider;
}

function memory(text = 'Cohort collision result.'): MemoryRecord {
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
		metadata: { outcomeGeneration: 'cohort-generation' },
	};
}

function event(
	memoryRecord: MemoryRecord,
	at: string,
	outcome: 'useful' | 'dead_end' = 'useful',
): MemoryOutcomeEvent {
	return {
		id: 'shared-outcome-event',
		memoryId: memoryRecord.id,
		generation: String(memoryRecord.metadata.outcomeGeneration),
		outcome: { outcome, at, taskId: 'task-1' },
		anchors: [{ file: 'src/cohort.ts', symbol: 'merge' }],
	};
}

function storageDir(root: string): string {
	return path.join(root, '.swarm', 'memory');
}

describe('memory family outcome collision semantics', () => {
	test('JSONL append-union rejects a changed payload for the same event id', () => {
		const record = memory();
		const destination = event(record, '2026-08-02T00:00:00.000Z');
		const source = event(record, '2026-08-02T00:00:01.000Z', 'dead_end');

		expect(() =>
			_internals.appendUnionOutcomeEvents([destination], [source]),
		).toThrow('outcome event id already exists with a different payload');
	});

	test('JSONL append-union accepts a timestamp-only retry and retains the first commit', () => {
		const record = memory();
		const destination = event(record, '2026-08-02T00:00:00.000Z');
		const source = event(record, '2026-08-02T00:00:01.000Z');

		const result = _internals.appendUnionOutcomeEvents([destination], [source]);
		expect(result).toEqual({ merged: [destination], added: 0, skipped: 1 });
	});

	for (const scenario of ['changed payload', 'timestamp-only retry'] as const) {
		test(`SQLite cohort merge handles ${scenario} with provider identity semantics`, async () => {
			const sourceRoot = path.join(tmpDir, `${scenario}-source`);
			const destinationRoot = path.join(tmpDir, `${scenario}-destination`);
			await fs.mkdir(sourceRoot, { recursive: true });
			await fs.mkdir(destinationRoot, { recursive: true });
			const record = memory();
			const unrelated = memory('Source-only memory must roll back.');
			const destinationEvent = event(record, '2026-08-02T00:00:00.000Z');
			const sourceEvent = event(
				record,
				'2026-08-02T00:00:01.000Z',
				scenario === 'changed payload' ? 'dead_end' : 'useful',
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
			await source.upsert(record);
			if (scenario === 'changed payload') await source.upsert(unrelated);
			await destination.upsert(record);
			await source.appendOutcome(
				record.id,
				{
					id: sourceEvent.id,
					outcome: sourceEvent.outcome,
				},
				sourceEvent.anchors,
			);
			await destination.appendOutcome(
				record.id,
				{
					id: destinationEvent.id,
					outcome: destinationEvent.outcome,
				},
				destinationEvent.anchors,
			);
			source.close();
			destination.close();

			const staged = _internals.stageSqliteDb(
				storageDir(sourceRoot),
				storageDir(destinationRoot),
			);
			expect(staged).not.toBeNull();
			const merge = _internals.mergeStagedSqlite(
				storageDir(destinationRoot),
				staged!.stagedPath,
			);
			if (scenario === 'changed payload') {
				await expect(merge).rejects.toThrow(
					'outcome event id already exists with a different payload',
				);
			} else {
				await expect(merge).resolves.toMatchObject({ skipped: 0 });
			}

			const reopened = track(
				new SQLiteMemoryProvider(destinationRoot, {
					enabled: true,
					provider: 'sqlite',
				}),
			);
			expect(await reopened.listOutcomeEvents()).toEqual([destinationEvent]);
			if (scenario === 'changed payload') {
				expect(await reopened.get(unrelated.id)).toBeNull();
				expect(
					(
						await reopened.list({
							includeExpired: true,
							includeInactive: true,
						})
					).map((item) => item.id),
				).toEqual([record.id]);
			}
		});
	}
});
