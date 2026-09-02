import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	createProposalId,
	LocalJsonlMemoryProvider,
	type MemoryProposal,
	type MemoryProposalStore,
	type MemoryProvider,
	type MemoryRecord,
	MemoryValidationError,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import {
	expandRelatedRecallItems,
	projectMemoryRelations,
} from '../../../src/memory/relations';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

type Provider = MemoryProvider & MemoryProposalStore & { close?: () => void };

const cases = [
	{
		name: 'local-jsonl',
		create: (root: string): Provider =>
			new LocalJsonlMemoryProvider(root, { enabled: true }),
	},
	{
		name: 'sqlite',
		create: (root: string): Provider =>
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
	},
] as const;

let tmpDir: string;
const providers: Provider[] = [];

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-related-memory-');
});

afterEach(async () => {
	for (const provider of providers.splice(0)) provider.close?.();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(provider: Provider): Provider {
	providers.push(provider);
	return provider;
}

function memory(
	text: string,
	repoId = 'repo-a',
	filePath = 'package.json',
): MemoryRecord {
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
		tags: [],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath },
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

function mergeProposal(ids: string[]): MemoryProposal {
	const createdAt = '2026-09-01T00:00:00.000Z';
	const canonical = [...ids].sort();
	return {
		id: createProposalId({
			createdAt,
			proposer: 'curator',
			text: `merge:${canonical.join(',')}`,
		}),
		operation: 'merge',
		relatedMemoryIds: canonical,
		proposedBy: { agentRole: 'curator' },
		rationale: 'These facts are useful together.',
		evidenceRefs: [],
		status: 'pending',
		createdAt,
		metadata: {},
	};
}

describe('durable related-memory semantics', () => {
	test('expands a dense-only source whose result record lacks projected links', () => {
		const left = memory('Use bun for package scripts.');
		const right = memory(
			'Invoke the Windows command shim.',
			'repo-a',
			'docs/windows.md',
		);
		const proposal = {
			...mergeProposal([left.id, right.id]),
			status: 'applied' as const,
		};
		const projected = projectMemoryRelations([left, right], [proposal]);
		const expanded = expandRelatedRecallItems(
			[
				{
					record: left,
					score: 1,
					reason: 'dense-only',
					signals: {
						textOverlap: 0,
						tagOverlap: 0,
						fileOverlap: 0,
						symbolOverlap: 0,
						kindMatch: false,
						scopeMatch: true,
					},
				},
			],
			projected,
			{
				query: 'unrelated dense query',
				mode: 'injection',
				requireQuerySignal: true,
				scopes: [left.scope],
				maxItems: 2,
				tokenBudget: 1000,
				minScore: 0,
			},
		);
		expect(expanded.map((item) => item.record.id)).toEqual([left.id, right.id]);
		expect(expanded[1].relation?.sourceMemoryId).toBe(left.id);
	});

	for (const providerCase of cases) {
		describe(providerCase.name, () => {
			test('applies, reloads, and recalls a bounded related memory', async () => {
				const root = path.join(tmpDir, providerCase.name);
				await fs.mkdir(root, { recursive: true });
				const provider = track(providerCase.create(root));
				const direct = memory('Use bun for package scripts.');
				const related = memory(
					'On Microsoft hosts invoke the command shim.',
					'repo-a',
					'docs/windows.md',
				);
				await provider.upsert(direct);
				await provider.upsert(related);
				const proposal = await provider.createProposal(
					mergeProposal([related.id, direct.id]),
				);

				const change = await provider.applyCuratorDecision?.({
					action: 'merge',
					proposalId: proposal.id,
					relatedMemoryIds: [direct.id, related.id],
					reason: 'Both facts describe the package runner.',
				});
				expect(change?.relatedMemoryIds).toEqual(
					[direct.id, related.id].sort(),
				);
				expect((await provider.get(direct.id))?.relations).toEqual([
					{ memoryId: related.id, type: 'merged_with' },
				]);

				provider.close?.();
				const reloaded = track(providerCase.create(root));
				const results = await reloaded.recall({
					query: 'package scripts bun',
					mode: 'injection',
					requireQuerySignal: true,
					scopes: [direct.scope],
					maxItems: 2,
					tokenBudget: 1000,
					minScore: 0,
				});
				expect(results.map((item) => item.record.id)).toEqual([
					direct.id,
					related.id,
				]);
				expect(results[1].relation).toEqual({
					type: 'merged_with',
					sourceMemoryId: direct.id,
				});
			});

			test('rejects cross-scope merges without reviewing the proposal', async () => {
				const root = path.join(tmpDir, `${providerCase.name}-scope`);
				await fs.mkdir(root, { recursive: true });
				const provider = track(providerCase.create(root));
				const left = memory('Left fact.', 'repo-a');
				const right = memory('Right fact.', 'repo-b');
				await provider.upsert(left);
				await provider.upsert(right);
				const proposal = await provider.createProposal(
					mergeProposal([left.id, right.id]),
				);

				await expect(
					provider.applyCuratorDecision?.({
						action: 'merge',
						proposalId: proposal.id,
						relatedMemoryIds: [left.id, right.id],
						reason: 'Invalid cross-scope relation.',
					}),
				).rejects.toBeInstanceOf(MemoryValidationError);
				expect(
					(await provider.listProposals({ status: 'pending' }))[0]?.id,
				).toBe(proposal.id);
			});

			test('does not persist caller-forged links and suppresses deleted targets', async () => {
				const root = path.join(tmpDir, `${providerCase.name}-stale`);
				await fs.mkdir(root, { recursive: true });
				const provider = track(providerCase.create(root));
				const direct = memory('Use bun for package scripts.');
				const related = memory(
					'The Windows shim is required.',
					'repo-a',
					'docs/windows.md',
				);
				await provider.upsert({
					...direct,
					relations: [{ memoryId: related.id, type: 'merged_with' }],
				});
				expect((await provider.get(direct.id))?.relations).toBeUndefined();

				await provider.upsert(related);
				const proposal = await provider.createProposal(
					mergeProposal([direct.id, related.id]),
				);
				await provider.applyCuratorDecision?.({
					action: 'merge',
					proposalId: proposal.id,
					relatedMemoryIds: [direct.id, related.id],
					reason: 'Related package runner facts.',
				});
				await provider.delete(related.id, 'obsolete');
				const results = await provider.recall({
					query: 'package scripts bun',
					mode: 'injection',
					requireQuerySignal: true,
					scopes: [direct.scope],
					maxItems: 2,
					tokenBudget: 1000,
					minScore: 0,
				});
				expect(results.map((item) => item.record.id)).toEqual([direct.id]);
				if (providerCase.name === 'sqlite') {
					await expect(
						provider.compactMaintenance?.({ dryRun: false }),
					).resolves.toMatchObject({ removedDeleted: 1 });
					expect((await provider.get(direct.id))?.relations).toBeUndefined();
				}
			});
		});
	}

	test('repairs a partial proposal tail before applying a merge', async () => {
		const root = path.join(tmpDir, 'partial-tail');
		await fs.mkdir(root, { recursive: true });
		const provider = track(
			new LocalJsonlMemoryProvider(root, { enabled: true }),
		);
		const left = memory('Use bun for package scripts.');
		const right = memory(
			'Invoke the Windows command shim.',
			'repo-a',
			'docs/windows.md',
		);
		await provider.upsert(left);
		await provider.upsert(right);
		const proposal = await provider.createProposal(
			mergeProposal([left.id, right.id]),
		);
		await fs.appendFile(
			path.join(root, '.swarm', 'memory', 'proposals.jsonl'),
			'{"incomplete":',
		);

		await expect(
			provider.applyCuratorDecision?.({
				action: 'merge',
				proposalId: proposal.id,
				relatedMemoryIds: [left.id, right.id],
				reason: 'The proposal ledger remains recoverable.',
			}),
		).resolves.toMatchObject({ action: 'merge' });
		expect((await provider.get(left.id))?.relations?.[0]?.memoryId).toBe(
			right.id,
		);
	});

	test('keeps an applied JSONL merge when the auxiliary audit append fails', async () => {
		const root = path.join(tmpDir, 'audit-failure');
		await fs.mkdir(root, { recursive: true });
		const provider = track(
			new LocalJsonlMemoryProvider(root, { enabled: true }),
		);
		const left = memory('Use bun for package scripts.');
		const right = memory(
			'Invoke the Windows command shim.',
			'repo-a',
			'docs/windows.md',
		);
		await provider.upsert(left);
		await provider.upsert(right);
		const proposal = await provider.createProposal(
			mergeProposal([left.id, right.id]),
		);
		const auditPath = path.join(root, '.swarm', 'memory', 'audit.jsonl');
		await fs.rm(auditPath);
		await fs.mkdir(auditPath);

		await expect(
			provider.applyCuratorDecision?.({
				action: 'merge',
				proposalId: proposal.id,
				relatedMemoryIds: [left.id, right.id],
				reason: 'Audit failure must not roll back the canonical ledger.',
			}),
		).resolves.toMatchObject({ action: 'merge' });
		expect((await provider.get(left.id))?.relations?.[0]?.memoryId).toBe(
			right.id,
		);
	});

	test('SQLite revalidates participants against concurrent provider changes', async () => {
		const root = path.join(tmpDir, 'sqlite-concurrent');
		await fs.mkdir(root, { recursive: true });
		const first = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const second = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const left = memory('Use bun for package scripts.');
		const right = memory(
			'Invoke the Windows command shim.',
			'repo-a',
			'docs/windows.md',
		);
		await first.upsert(left);
		await first.upsert(right);
		const proposal = await first.createProposal(
			mergeProposal([left.id, right.id]),
		);
		await second.list();
		await second.delete(right.id, 'removed concurrently');

		await expect(
			first.applyCuratorDecision?.({
				action: 'merge',
				proposalId: proposal.id,
				relatedMemoryIds: [left.id, right.id],
				reason: 'Must see the transaction snapshot.',
			}),
		).rejects.toThrow(`merge participant is not active: ${right.id}`);
	});

	test('SQLite exports canonical records without materialized relations', async () => {
		const root = path.join(tmpDir, 'sqlite-export');
		await fs.mkdir(root, { recursive: true });
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const left = memory('Use bun for package scripts.');
		const right = memory(
			'Invoke the Windows command shim.',
			'repo-a',
			'docs/windows.md',
		);
		await provider.upsert(left);
		await provider.upsert(right);
		const proposal = await provider.createProposal(
			mergeProposal([left.id, right.id]),
		);
		await provider.applyCuratorDecision?.({
			action: 'merge',
			proposalId: proposal.id,
			relatedMemoryIds: [left.id, right.id],
			reason: 'Export only canonical state.',
		});
		const exported = await provider.exportJsonl();
		const rows = (await fs.readFile(exported.memoriesPath, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as MemoryRecord);
		expect(rows.every((record) => record.relations === undefined)).toBe(true);

		const importedRoot = path.join(tmpDir, 'sqlite-import');
		const importedMemoryDir = path.join(importedRoot, '.swarm', 'memory');
		await fs.mkdir(importedMemoryDir, { recursive: true });
		await fs.copyFile(
			exported.memoriesPath,
			path.join(importedMemoryDir, 'memories.jsonl'),
		);
		await fs.copyFile(
			exported.proposalsPath,
			path.join(importedMemoryDir, 'proposals.jsonl'),
		);
		const imported = track(
			new SQLiteMemoryProvider(importedRoot, {
				enabled: true,
				provider: 'sqlite',
			}),
		);
		expect((await imported.get(left.id))?.relations).toEqual([
			{ memoryId: right.id, type: 'merged_with' },
		]);
	});

	test('SQLite readers observe merges applied by another live provider', async () => {
		const root = path.join(tmpDir, 'sqlite-live-read');
		await fs.mkdir(root, { recursive: true });
		const reader = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const writer = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const left = memory('Use bun for package scripts.');
		const right = memory(
			'Invoke the Windows command shim.',
			'repo-a',
			'docs/windows.md',
		);
		await writer.upsert(left);
		await writer.upsert(right);
		await reader.list();
		const proposal = await writer.createProposal(
			mergeProposal([left.id, right.id]),
		);
		await writer.applyCuratorDecision?.({
			action: 'merge',
			proposalId: proposal.id,
			relatedMemoryIds: [left.id, right.id],
			reason: 'Live readers must refresh applied proposal state.',
		});

		expect((await reader.get(left.id))?.relations).toEqual([
			{ memoryId: right.id, type: 'merged_with' },
		]);
	});
});
