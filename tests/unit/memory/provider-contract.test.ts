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
import { _test_exports as sqliteProviderTestExports } from '../../../src/memory/sqlite-provider';

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
				expect(await provider.listRecallUsage()).toEqual([
					expect.objectContaining({
						bundleId: 'bundle_20260524_abcd',
						memoryIds: [repoA.id],
						agentRole: 'coder',
					}),
				]);
				expect(await provider.listRecallUsage({ limit: 1 })).toHaveLength(1);
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

			test('applies curator add decisions and durably marks proposals applied', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const record = makeRecord('Curator approved this memory.');
				const proposal = makeProposal(record);
				await provider.createProposal(proposal);

				const change = await provider.applyCuratorDecision?.({
					action: 'add',
					proposalId: proposal.id,
					memory: record,
				});

				expect(change).toMatchObject({
					action: 'add',
					proposalId: proposal.id,
					proposalStatus: 'applied',
					memoryId: record.id,
				});
				expect(await provider.list({})).toEqual([
					expect.objectContaining({ id: record.id, text: record.text }),
				]);
				const reloaded = track(providerCase.reopen(root));
				expect(await reloaded.list({})).toEqual([
					expect.objectContaining({ id: record.id, text: record.text }),
				]);
				expect(await reloaded.listProposals({ status: 'applied' })).toEqual([
					expect.objectContaining({
						id: proposal.id,
						status: 'applied',
						reviewer: 'curator_agent',
					}),
				]);
			});

			test('applies curator reject decisions without durable memory writes', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const proposal = makeProposal(makeRecord('Rejected memory candidate.'));
				await provider.createProposal(proposal);

				const change = await provider.applyCuratorDecision?.({
					action: 'reject',
					proposalId: proposal.id,
					reason: 'Insufficient evidence.',
				});

				expect(change).toMatchObject({
					action: 'reject',
					proposalId: proposal.id,
					proposalStatus: 'rejected',
					reason: 'Insufficient evidence.',
				});
				expect(await provider.list({})).toHaveLength(0);
				expect(await provider.listProposals({ status: 'rejected' })).toEqual([
					expect.objectContaining({
						id: proposal.id,
						status: 'rejected',
						reviewer: 'curator_agent',
						rejectionReason: 'Insufficient evidence.',
					}),
				]);
			});

			test('applies curator noop decisions as durable proposal decisions only', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const proposal = makeProposal(makeRecord('Noop memory candidate.'));
				await provider.createProposal(proposal);

				const change = await provider.applyCuratorDecision?.({
					action: 'noop',
					proposalId: proposal.id,
					reason: 'Already captured by existing memory.',
				});

				expect(change).toMatchObject({
					action: 'noop',
					proposalId: proposal.id,
					proposalStatus: 'applied',
					reason: 'Already captured by existing memory.',
				});
				expect(await provider.list({})).toHaveLength(0);
				expect(await provider.listProposals({ status: 'applied' })).toEqual([
					expect.objectContaining({
						id: proposal.id,
						status: 'applied',
						reviewer: 'curator_agent',
						metadata: expect.objectContaining({
							curatorDecision: expect.objectContaining({
								action: 'noop',
								reason: 'Already captured by existing memory.',
							}),
						}),
					}),
				]);
			});

			test('applies curator update decisions with partial patch merging', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const existing = {
					...makeRecord('Keep using bun --smol for memory tests.'),
					tags: ['testing', 'memory'],
					metadata: { source: 'original' },
				};
				await provider.upsert(existing);
				const proposal: MemoryProposal = {
					...makeProposal(existing),
					operation: 'update',
					targetMemoryId: existing.id,
				};
				await provider.createProposal(proposal);

				const change = await provider.applyCuratorDecision?.({
					action: 'update',
					proposalId: proposal.id,
					targetMemoryId: existing.id,
					patch: {
						confidence: 0.72,
						tags: ['Memory Review', 'testing'],
						metadata: { reviewed: true },
					},
					reason: 'Curator adjusted confidence and tags.',
				});

				expect(change).toMatchObject({
					action: 'update',
					proposalId: proposal.id,
					proposalStatus: 'applied',
					memoryId: existing.id,
					targetMemoryId: existing.id,
				});
				const oldAfterUpdate = await provider.get(existing.id);
				expect(oldAfterUpdate).toMatchObject({
					id: existing.id,
					text: existing.text,
					confidence: 0.72,
					tags: ['memory-review', 'testing'],
					metadata: { source: 'original', reviewed: true },
				});
			});

			test('content-changing curator updates tombstone the old memory id', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const existing = makeRecord('Run the outdated memory command.');
				await provider.upsert(existing);
				const proposal: MemoryProposal = {
					...makeProposal(existing),
					operation: 'update',
					targetMemoryId: existing.id,
				};
				await provider.createProposal(proposal);

				const change = await provider.applyCuratorDecision?.({
					action: 'update',
					proposalId: proposal.id,
					targetMemoryId: existing.id,
					patch: {
						text: 'Run the current memory command.',
						metadata: { reviewed: true },
					},
					reason: 'The command changed.',
				});

				expect(change?.memoryId).toBeDefined();
				expect(change?.memoryId).not.toBe(existing.id);
				const oldAfterUpdate = await provider.get(existing.id);
				expect(oldAfterUpdate?.id).toBe(existing.id);
				expect(oldAfterUpdate?.metadata.deleted).toBe(true);
				expect(oldAfterUpdate?.metadata.deleteReason).toBe(
					'The command changed.',
				);
				expect(oldAfterUpdate?.metadata.updateReplacementId).toBe(
					change?.memoryId,
				);
				const listed = await provider.list({});
				expect(listed.map((item) => item.id)).toEqual([change?.memoryId]);
				const recall = await provider.recall({
					query: 'current memory command',
					scopes: [existing.scope],
					maxItems: 5,
					tokenBudget: 1000,
					minScore: 0,
				});
				expect(recall.map((item) => item.record.id)).toEqual([
					change?.memoryId,
				]);
			});

			test('superseded memories stop appearing in recall and list results', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const oldMemory = makeRecord('Use the old memory command.');
				const replacement = makeRecord('Use the new memory command.');
				await provider.upsert(oldMemory);
				const proposal = {
					...makeProposal(replacement),
					operation: 'supersede' as const,
					targetMemoryId: oldMemory.id,
				};
				await provider.createProposal(proposal);

				const change = await provider.applyCuratorDecision?.({
					action: 'supersede',
					proposalId: proposal.id,
					oldMemoryId: oldMemory.id,
					replacement,
					reason: 'The command changed.',
				});

				expect(change).toMatchObject({
					action: 'supersede',
					oldMemoryId: oldMemory.id,
					replacementMemoryId: replacement.id,
					proposalStatus: 'applied',
				});
				expect((await provider.get(oldMemory.id))?.supersededBy).toBe(
					replacement.id,
				);
				expect((await provider.list({})).map((item) => item.id)).toEqual([
					replacement.id,
				]);
				const recall = await provider.recall({
					query: 'memory command',
					scopes: [oldMemory.scope],
					maxItems: 5,
					tokenBudget: 1000,
					minScore: 0,
				});
				expect(recall.map((item) => item.record.id)).toEqual([replacement.id]);
			});

			test('rejects curator decisions that target a different memory than the proposal', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const oldMemory = makeRecord('Original memory target.');
				const otherMemory = makeRecord('Different memory target.');
				const replacement = makeRecord('Replacement memory target.');
				await provider.upsert(oldMemory);
				await provider.upsert(otherMemory);
				const proposal = {
					...makeProposal(replacement),
					operation: 'supersede' as const,
					targetMemoryId: oldMemory.id,
				};
				await provider.createProposal(proposal);

				await expect(
					provider.applyCuratorDecision?.({
						action: 'supersede',
						proposalId: proposal.id,
						oldMemoryId: otherMemory.id,
						replacement,
						reason: 'Wrong target must be rejected.',
					}),
				).rejects.toThrow('target does not match');

				expect(await provider.listProposals({ status: 'pending' })).toEqual([
					proposal,
				]);
				expect(
					(await provider.get(otherMemory.id))?.supersededBy,
				).toBeUndefined();
			});

			test('rejects curator decisions whose action does not match the proposal operation', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const existing = makeRecord('Update action mismatch source.');
				const approved = makeRecord('Action mismatch approved memory.');
				await provider.upsert(existing);
				const proposal: MemoryProposal = {
					...makeProposal(approved),
					operation: 'update',
					targetMemoryId: existing.id,
				};
				await provider.createProposal(proposal);

				await expect(
					provider.applyCuratorDecision?.({
						action: 'add',
						proposalId: proposal.id,
						memory: approved,
					}),
				).rejects.toThrow('does not match update proposal');

				expect(await provider.listProposals({ status: 'pending' })).toEqual([
					proposal,
				]);
				expect(await provider.get(approved.id)).toBeNull();
			});
		});
	}
});

describe('LocalJsonlMemoryProvider', () => {
	test('event-logs curator decisions with the structured provider payload', async () => {
		const root = await providerRoot('local-jsonl-events');
		const provider = track(
			new LocalJsonlMemoryProvider(root, { enabled: true }),
		);
		const record = makeRecord('Local JSONL logs curator decisions.');
		const proposal = makeProposal(record);
		await provider.createProposal(proposal);

		const change = await provider.applyCuratorDecision({
			action: 'add',
			proposalId: proposal.id,
			memory: record,
		});

		const auditPath = path.join(root, '.swarm', 'memory', 'audit.jsonl');
		const events = (await fs.readFile(auditPath, 'utf-8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const decisionEvent = events.find(
			(event) => event.operation === 'curator_decision',
		);
		expect(decisionEvent).toMatchObject({
			targetId: proposal.id,
			eventJson: {
				action: 'add',
				proposalId: proposal.id,
				proposalOperation: 'add',
				memoryId: record.id,
			},
		});
		expect(decisionEvent.reason).toBeUndefined();
		expect(change).toMatchObject({
			action: 'add',
			memoryId: record.id,
		});
	});
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
					'memory_items_fts',
					'memory_proposals',
					'memory_events',
					'memory_recall_usage',
					'schema_migrations',
				]),
			);
			const ftsMigration = db
				.query<{ version: number; name: string }, []>(
					'SELECT version, name FROM schema_migrations WHERE name = "create_memory_fts5_shadow_index"',
				)
				.get();
			expect(ftsMigration).toEqual({
				version: sqliteProviderTestExports.FTS_SCHEMA_MIGRATION_VERSION,
				name: sqliteProviderTestExports.FTS_SCHEMA_MIGRATION_NAME,
			});
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

	test('recalls SQLite FTS candidates from source refs, symbols, and files', async () => {
		const root = await providerRoot('sqlite-fts-fields');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const record = makeSearchRecord({
			text: 'Hybrid recall stores searchable structured fields.',
			source: { type: 'manual', ref: 'PR7-FTS-hybrid-recall' },
			metadata: {
				symbols: ['HybridRecallPlanner'],
				files: ['src/memory/sqlite-provider.ts'],
			},
		});
		const unrelated = makeSearchRecord({
			text: 'General package manager convention.',
			tags: ['package'],
			source: { type: 'file', filePath: 'package.json' },
			metadata: { files: ['package.json'] },
		});
		await provider.upsert(record);
		await provider.upsert(unrelated);

		const results = await provider.recall({
			query: 'HybridRecallPlanner PR7 FTS src/memory/sqlite-provider.ts',
			task: 'Implement HybridRecallPlanner in src/memory/sqlite-provider.ts',
			mode: 'injection',
			scopes: [record.scope],
			kinds: ['code_pattern', 'repo_convention'],
			maxItems: 5,
			tokenBudget: 1000,
			minScore: 0,
			requireQuerySignal: true,
		});

		expect(results.map((item) => item.record.id)).toEqual([record.id]);
		expect(results[0]?.reason).toContain('fts_rank=1');
		expect(results[0]?.signals.symbolOverlap).toBeGreaterThan(0);
		expect(results[0]?.signals.fileOverlap).toBeGreaterThan(0);
	});

	test('builds safe FTS queries from task and recall text', () => {
		const query = sqliteProviderTestExports.buildFtsQuery({
			query: 'How should PR7 handle src/memory/sqlite-provider.ts?',
			task: 'Implement FTS recall for HybridRecallPlanner and C++ notes.',
			mode: 'injection',
			scopes: [{ type: 'repository', repoId: 'repo-search' }],
			maxItems: 5,
			tokenBudget: 1000,
		});

		expect(query).toContain('"implement"');
		expect(query).toContain('"hybridrecallplanner"');
		expect(query).toContain('"sqlite"');
		expect(query).not.toContain('how');
		expect(query).not.toContain(' OR OR ');
	});

	test('documents conservative injection behavior when FTS has no candidates', async () => {
		const root = await providerRoot('sqlite-fts-injection-empty');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const record = makeSearchRecord({
			text: 'Same-scope memory can be recalled manually by pure scoring.',
			tags: ['manual-only'],
			confidence: 1,
		});
		await provider.upsert(record);

		const result = await provider.recallWithDiagnostics?.({
			query: 'missingterm',
			mode: 'injection',
			scopes: [record.scope],
			kinds: ['code_pattern'],
			maxItems: 5,
			tokenBudget: 1000,
			minScore: 0,
			requireQuerySignal: false,
		});

		expect(result?.items).toEqual([]);
		expect(result?.diagnostics).toMatchObject({
			candidateCount: 0,
			noSignalCount: 0,
			returnedCount: 0,
		});
	});

	test('evaluation fixture ranks file-specific recall ahead of broad PR2-style scoring noise', async () => {
		const root = await providerRoot('sqlite-fts-eval');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const fileSpecific = makeSearchRecord({
			text: 'SQLiteMemoryProvider FTS recall tests must cover metadata files.',
			tags: ['memory', 'fts'],
			source: { type: 'file', filePath: 'src/memory/sqlite-provider.ts' },
			metadata: {
				files: ['src/memory/sqlite-provider.ts'],
				symbols: ['SQLiteMemoryProvider'],
			},
			confidence: 0.75,
		});
		const broadButIrrelevant = makeSearchRecord({
			text: 'SQLite memory provider defaults use WAL and busy timeouts.',
			tags: ['memory', 'sqlite'],
			source: { type: 'file', filePath: 'src/memory/config.ts' },
			metadata: { files: ['src/memory/config.ts'] },
			confidence: 1,
		});
		await provider.upsert(broadButIrrelevant);
		await provider.upsert(fileSpecific);

		const results = await provider.recall({
			query: 'SQLite memory provider FTS recall',
			task: 'Implement PR7 in src/memory/sqlite-provider.ts with FTS recall tests',
			mode: 'injection',
			agentRole: 'coder',
			scopes: [fileSpecific.scope],
			kinds: ['code_pattern', 'repo_convention'],
			maxItems: 1,
			tokenBudget: 1000,
			minScore: 0,
			requireQuerySignal: true,
		});

		expect(results.map((item) => item.record.id)).toEqual([fileSpecific.id]);
		expect(results[0]?.score).toBeGreaterThan(0);
	});

	test('filters scope before limiting FTS candidates', async () => {
		const root = await providerRoot('sqlite-fts-scope-limit');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		for (let i = 0; i < 110; i++) {
			await provider.upsert(
				makeSearchRecord({
					scope: { type: 'repository', repoId: `repo-other-${i}` },
					text: `Needle out-of-scope memory ${i}.`,
					tags: ['needle'],
				}),
			);
		}
		const target = makeSearchRecord({
			scope: { type: 'repository', repoId: 'repo-target' },
			text: 'Needle in-scope memory survives FTS candidate limiting.',
			tags: ['needle'],
		});
		await provider.upsert(target);

		const results = await provider.recall({
			query: 'needle',
			mode: 'injection',
			scopes: [target.scope],
			kinds: ['code_pattern'],
			maxItems: 1,
			tokenBudget: 1000,
			minScore: 0,
			requireQuerySignal: true,
		});

		expect(results.map((item) => item.record.id)).toEqual([target.id]);
	});

	test('falls back to shared scoring when the FTS table is unavailable', async () => {
		const root = await providerRoot('sqlite-fts-fallback');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const record = makeSearchRecord({
			text: 'Fallback recall still works when FTS is unavailable.',
			tags: ['fallback'],
		});
		await provider.upsert(record);
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run('DROP TABLE memory_items_fts');
		} finally {
			db.close();
		}

		const results = await provider.recall({
			query: 'fallback recall',
			scopes: [record.scope],
			maxItems: 5,
			tokenBudget: 1000,
			minScore: 0,
		});

		expect(results.map((item) => item.record.id)).toEqual([record.id]);
		expect(results[0]?.reason).not.toContain('fts_rank=');
	});

	test('rebuilds the FTS shadow index for existing SQLite rows', async () => {
		const root = await providerRoot('sqlite-fts-rebuild');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const record = makeSearchRecord({
			text: 'Existing SQLite rows are rebuilt into FTS on startup.',
			tags: ['rebuild'],
			metadata: { files: ['src/memory/sqlite-provider.ts'] },
		});
		await provider.upsert(record);
		provider.close?.();
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run('DROP TABLE memory_items_fts');
		} finally {
			db.close();
		}
		const reopened = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);

		const results = await reopened.recall({
			query: 'existing rows rebuild src/memory/sqlite-provider.ts',
			mode: 'injection',
			scopes: [record.scope],
			kinds: ['code_pattern'],
			maxItems: 5,
			tokenBudget: 1000,
			minScore: 0,
			requireQuerySignal: true,
		});

		expect(results.map((item) => item.record.id)).toEqual([record.id]);
		expect(results[0]?.reason).toContain('fts_rank=1');
	});

	test('compares FTS rebuild counts against valid rows only', async () => {
		const root = await providerRoot('sqlite-fts-invalid-row-count');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const record = makeSearchRecord({
			text: 'Valid rows stay searchable when invalid SQLite rows exist.',
			tags: ['valid-row'],
		});
		await provider.upsert(record);
		provider.close?.();
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				`INSERT INTO memory_items (
					id,
					scope_key,
					kind,
					updated_at,
					deleted,
					record_json
				) VALUES (?, ?, ?, ?, ?, ?)`,
				[
					'mem_0000000000000000',
					JSON.stringify(record.scope),
					record.kind,
					record.updatedAt,
					0,
					'{"not":"a valid memory"}',
				],
			);
		} finally {
			db.close();
		}
		const reopened = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await reopened.initialize();
		reopened.close?.();
		const verifyDb = new Database(dbPath, { readonly: true });
		try {
			const ftsCount = verifyDb
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM memory_items_fts',
				)
				.get()?.count;
			expect(ftsCount).toBe(1);
		} finally {
			verifyDb.close();
		}
	});

	test('event-logs every curator decision in SQLite', async () => {
		const root = await providerRoot('sqlite-decision-events');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const record = makeRecord('SQLite logs curator decisions.');
		const proposal = makeProposal(record);
		await provider.createProposal(proposal);

		const change = await provider.applyCuratorDecision({
			action: 'add',
			proposalId: proposal.id,
			memory: record,
		});
		provider.close?.();

		const db = new Database(path.join(root, '.swarm', 'memory', 'memory.db'), {
			readonly: true,
		});
		try {
			const row = db
				.query<
					{
						operation: string;
						target_id: string;
						event_json: string;
					},
					[]
				>(
					'SELECT operation, target_id, event_json FROM memory_events WHERE id = ?',
				)
				.get(change.eventId ?? '');
			expect(row?.operation).toBe('curator_decision');
			expect(row?.target_id).toBe(proposal.id);
			expect(JSON.parse(row?.event_json ?? '{}')).toMatchObject({
				action: 'add',
				proposalId: proposal.id,
				proposalOperation: 'add',
				memoryId: record.id,
			});
		} finally {
			db.close();
		}
	});

	test('curator decision application is atomic when validation fails', async () => {
		const root = await providerRoot('sqlite-decision-atomic');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const record = makeRecord(
			'Invalid approved memory is rejected atomically.',
		);
		const proposal = makeProposal(record);
		await provider.createProposal(proposal);

		await expect(
			provider.applyCuratorDecision({
				action: 'add',
				proposalId: proposal.id,
				memory: {
					...record,
					contentHash:
						'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				},
			}),
		).rejects.toThrow('contentHash does not match');

		expect(await provider.list({})).toEqual([]);
		expect(await provider.listProposals({ status: 'pending' })).toEqual([
			proposal,
		]);
		provider.close?.();

		const db = new Database(path.join(root, '.swarm', 'memory', 'memory.db'), {
			readonly: true,
		});
		try {
			const row = db
				.query<{ count: number }, []>(
					"SELECT COUNT(*) as count FROM memory_events WHERE operation = 'curator_decision'",
				)
				.get();
			expect(row?.count).toBe(0);
		} finally {
			db.close();
		}
	});
});

function makeSearchRecord(overrides: Partial<MemoryRecord>): MemoryRecord {
	const scope =
		overrides.scope ?? ({ type: 'repository', repoId: 'repo-search' } as const);
	const kind = overrides.kind ?? ('code_pattern' as const);
	const text = overrides.text ?? 'Searchable memory record.';
	const base = { scope, kind, text };
	return {
		id: createMemoryId(base),
		...base,
		tags: overrides.tags ?? ['memory'],
		confidence: overrides.confidence ?? 0.9,
		stability: overrides.stability ?? 'durable',
		source:
			overrides.source ??
			({ type: 'file', filePath: 'src/memory/sqlite-provider.ts' } as const),
		createdAt: overrides.createdAt ?? '2026-05-24T12:00:00.000Z',
		updatedAt: overrides.updatedAt ?? '2026-05-24T12:00:00.000Z',
		lastAccessedAt: overrides.lastAccessedAt,
		expiresAt: overrides.expiresAt,
		supersedes: overrides.supersedes,
		supersededBy: overrides.supersededBy,
		contentHash: computeMemoryContentHash(base),
		metadata: overrides.metadata ?? {},
	};
}
