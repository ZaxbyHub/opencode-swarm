import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createConfiguredMemoryProvider,
	createMemoryId,
	createProposalId,
	LEGACY_JSONL_MIGRATION_NAME,
	LEGACY_JSONL_MIGRATION_VERSION,
	LocalJsonlMemoryProvider,
	type MemoryProposal,
	type MemoryProposalStore,
	type MemoryProvider,
	type MemoryRecord,
	readMigrationReport,
	resolveMemoryConfig,
	SQLiteMemoryProvider,
} from '../../../src/memory';

type ContractProvider = MemoryProvider &
	MemoryProposalStore & { close?: () => void };

interface ProviderCase {
	name: 'local-jsonl' | 'sqlite';
	create(root: string): ContractProvider;
	reopen(root: string): ContractProvider;
}

const providerCases: ProviderCase[] = [
	{
		name: 'local-jsonl',
		create: (root) => new LocalJsonlMemoryProvider(root, { enabled: true }),
		reopen: (root) => new LocalJsonlMemoryProvider(root, { enabled: true }),
	},
	{
		name: 'sqlite',
		create: (root) =>
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
			}),
		reopen: (root) =>
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
			}),
	},
];

let tmpDir: string;
const openProviders: ContractProvider[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-contract-')),
	);
	openProviders.length = 0;
});

afterEach(async () => {
	for (const provider of openProviders.splice(0)) {
		provider.close?.();
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(provider: ContractProvider): ContractProvider {
	openProviders.push(provider);
	return provider;
}

async function providerRoot(providerName: string): Promise<string> {
	const root = path.join(tmpDir, providerName);
	await fs.mkdir(root, { recursive: true });
	return root;
}

function makeRecord(text: string, repoId = 'repo-a'): MemoryRecord {
	const base = {
		scope: {
			type: 'repository' as const,
			repoId,
			repoRoot: path.join(tmpDir, repoId),
		},
		kind: 'repo_convention' as const,
		text,
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
	};
}

function makeProposal(record: MemoryRecord): MemoryProposal {
	const createdAt = '2026-05-24T12:00:00.000Z';
	return {
		id: createProposalId({
			createdAt,
			proposer: 'coder',
			text: record.text,
		}),
		operation: 'add',
		proposedRecord: record,
		proposedBy: { agentRole: 'coder', runId: 'session-a' },
		rationale: 'Useful test command convention.',
		evidenceRefs: ['package.json'],
		status: 'pending',
		createdAt,
		metadata: {},
	};
}

describe('MemoryProvider contract parity', () => {
	for (const providerCase of providerCases) {
		describe(providerCase.name, () => {
			test('stores, lists, gets, and reloads memory records', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const record = makeRecord('This repo uses bun for memory tests.');

				await provider.upsert(record);

				expect(await provider.get(record.id)).toEqual(record);
				expect(await provider.list({})).toEqual([record]);

				const reloaded = track(providerCase.reopen(root));
				expect(await reloaded.get(record.id)).toEqual(record);
				expect(await reloaded.list({})).toEqual([record]);
			});

			test('recalls only allowed scopes and records recall usage', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const repoA = makeRecord('Repo A uses bun for tests.', 'repo-a');
				const repoB = makeRecord('Repo B uses npm for tests.', 'repo-b');
				await provider.upsert(repoA);
				await provider.upsert(repoB);

				const results = await provider.recall({
					query: 'what test command should I run',
					scopes: [repoA.scope],
					maxItems: 5,
					tokenBudget: 1000,
					minScore: 0,
				});
				await provider.recordRecallUsage({
					bundleId: 'bundle_20260524_abcd',
					query: 'bun tests',
					scopes: [repoA.scope],
					kinds: ['repo_convention'],
					memoryIds: results.map((item) => item.record.id),
					scores: results.map((item) => item.score),
					tokenEstimate: 100,
					agentRole: 'coder',
					runId: 'session-a',
					timestamp: '2026-05-24T12:00:00.000Z',
				});

				expect(results.map((item) => item.record.id)).toEqual([repoA.id]);
			});

			test('tombstones deletes and refuses to upsert over tombstones', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const record = makeRecord('Do not resurrect this convention.');
				await provider.upsert(record);
				await provider.delete(record.id, 'obsolete');

				expect(await provider.get(record.id)).toMatchObject({
					id: record.id,
					metadata: { deleted: true, deleteReason: 'obsolete' },
				});
				expect(await provider.list({})).toHaveLength(0);
				await expect(
					provider.upsert({
						...record,
						updatedAt: '2026-05-24T13:00:00.000Z',
					}),
				).rejects.toThrow('tombstoned');
			});

			test('stores pending proposals without creating durable memory', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const proposal = makeProposal(makeRecord('This repo uses bun.'));

				await provider.createProposal(proposal);

				expect(await provider.list({})).toHaveLength(0);
				expect(await provider.listProposals({ status: 'pending' })).toEqual([
					proposal,
				]);
			});
		});
	}
});

describe('SQLiteMemoryProvider', () => {
	test('is selected by the resolved default memory provider config', async () => {
		const root = await providerRoot('sqlite-default');
		const provider = track(
			createConfiguredMemoryProvider(
				root,
				resolveMemoryConfig({ enabled: true }),
			),
		);

		expect(provider.name).toBe('sqlite');
	});

	test('creates the required tables inside .swarm memory storage', async () => {
		const root = await providerRoot('sqlite-schema');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close?.();

		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		expect(existsSync(dbPath)).toBe(true);
		const db = new Database(dbPath, { readonly: true });
		try {
			const tables = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
				.all()
				.map((row) => row.name)
				.sort();

			expect(tables).toEqual(
				expect.arrayContaining([
					'memory_items',
					'memory_proposals',
					'memory_events',
					'memory_recall_usage',
					'schema_migrations',
				]),
			);
		} finally {
			db.close();
		}
	});

	test('rejects sqlite database paths that escape .swarm', async () => {
		const root = await providerRoot('sqlite-containment');
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				sqlite: {
					path: '../memory.db',
					busyTimeoutMs: 5000,
				},
			}),
		);

		await expect(provider.initialize()).rejects.toThrow('path traversal');
		expect(existsSync(path.join(root, 'memory.db'))).toBe(false);
	});

	test('migrates legacy JSONL once, backs it up, and reports invalid rows', async () => {
		const root = await providerRoot('sqlite-jsonl-migration');
		const memoryDir = path.join(root, '.swarm', 'memory');
		await fs.mkdir(memoryDir, { recursive: true });
		const record = makeRecord('Legacy JSONL memory migrates into SQLite.');
		const laterRecord = makeRecord('Late JSONL rows are not auto imported.');
		const proposal = makeProposal(record);
		await fs.writeFile(
			path.join(memoryDir, 'memories.jsonl'),
			`${JSON.stringify(record)}\n{"not":"valid-memory"}\n`,
			'utf-8',
		);
		await fs.writeFile(
			path.join(memoryDir, 'proposals.jsonl'),
			`${JSON.stringify(proposal)}\nnot-json\n`,
			'utf-8',
		);

		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();

		expect((await provider.list({})).map((item) => item.id)).toEqual([
			record.id,
		]);
		expect(await provider.listProposals({ status: 'pending' })).toEqual([
			proposal,
		]);
		expect(
			existsSync(
				path.join(memoryDir, 'backups', 'memories.jsonl.pre-sqlite-migration'),
			),
		).toBe(true);
		expect(
			existsSync(
				path.join(memoryDir, 'backups', 'proposals.jsonl.pre-sqlite-migration'),
			),
		).toBe(true);
		const report = await readMigrationReport(root);
		expect(report?.importedMemories).toBe(1);
		expect(report?.importedProposals).toBe(1);
		expect(report?.invalidRows.map((row) => `${row.file}:${row.line}`)).toEqual(
			['memories.jsonl:2', 'proposals.jsonl:2'],
		);
		provider.close?.();

		await fs.appendFile(
			path.join(memoryDir, 'memories.jsonl'),
			`${JSON.stringify(laterRecord)}\n`,
			'utf-8',
		);
		const reopened = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await reopened.initialize();

		expect((await reopened.list({})).map((item) => item.id)).toEqual([
			record.id,
		]);
		reopened.close?.();

		const db = new Database(path.join(memoryDir, 'memory.db'), {
			readonly: true,
		});
		try {
			const row = db
				.query<{ version: number; name: string }, []>(
					'SELECT version, name FROM schema_migrations WHERE name = "legacy_jsonl_import_complete"',
				)
				.get();
			expect(row).toEqual({
				version: LEGACY_JSONL_MIGRATION_VERSION,
				name: LEGACY_JSONL_MIGRATION_NAME,
			});
		} finally {
			db.close();
		}
	});
});
