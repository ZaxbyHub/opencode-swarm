import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	createProposalId,
	LocalJsonlMemoryProvider,
	type MemoryProposal,
	type MemoryRecord,
} from '../../../src/memory';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-provider-')),
	);
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

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

describe('LocalJsonlMemoryProvider', () => {
	test('stores, lists, and reloads local memories from .swarm/memory', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const record = makeRecord('This repo uses pnpm. Run tests with pnpm test.');

		await provider.upsert(record);

		const memoryFile = path.join(tmpDir, '.swarm', 'memory', 'memories.jsonl');
		const auditFile = path.join(tmpDir, '.swarm', 'memory', 'audit.jsonl');
		expect(existsSync(memoryFile)).toBe(true);
		expect(existsSync(auditFile)).toBe(true);

		const reloaded = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		expect(await reloaded.get(record.id)).toEqual(record);
		expect(await reloaded.list({})).toHaveLength(1);
	});

	test('recall filters by allowed scopes before scoring', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const repoA = makeRecord('Repo A uses pnpm for tests.', 'repo-a');
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

		expect(results.map((item) => item.record.id)).toEqual([repoA.id]);
	});

	test('recall excludes expired records by default', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const expired = {
			...makeRecord('Old scratch note about tests.'),
			stability: 'session' as const,
			expiresAt: '2020-01-01T00:00:00.000Z',
		};
		await provider.upsert(expired);

		const results = await provider.recall({
			query: 'tests',
			scopes: [expired.scope],
			maxItems: 5,
			tokenBudget: 1000,
			minScore: 0,
		});

		expect(results).toHaveLength(0);
	});

	test('delete tombstones rather than physically erasing by default', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const record = makeRecord('Tombstone this convention.');
		await provider.upsert(record);
		await provider.delete(record.id, 'obsolete');

		expect(await provider.get(record.id)).toMatchObject({
			id: record.id,
			metadata: { deleted: true, deleteReason: 'obsolete' },
		});
		expect(await provider.list({})).toHaveLength(0);
	});

	test('refuses to upsert over tombstoned memories', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const record = makeRecord('Do not resurrect this convention.');
		await provider.upsert(record);
		await provider.delete(record.id, 'obsolete');

		await expect(
			provider.upsert({
				...record,
				updatedAt: '2026-05-24T13:00:00.000Z',
			}),
		).rejects.toThrow('tombstoned');
		expect(await provider.list({})).toHaveLength(0);
	});

	test('skips invalid raw JSONL memories and proposals on load', async () => {
		const valid = makeRecord('Valid records survive reload.');
		const invalidMemory = {
			...valid,
			id: 'mem_badbadbadbadbad',
			metadata: undefined,
		};
		const invalidProposal: MemoryProposal = {
			id: createProposalId({
				createdAt: '2026-05-24T12:00:00.000Z',
				proposer: 'coder',
				text: 'invalid proposal',
			}),
			operation: 'add',
			proposedRecord: {
				...makeRecord('Invalid proposal record has no evidence.'),
				source: { type: 'agent' },
			},
			proposedBy: { agentRole: 'coder' },
			rationale: 'Should be skipped because proposedRecord violates rules.',
			evidenceRefs: ['README.md'],
			status: 'pending',
			createdAt: '2026-05-24T12:00:00.000Z',
			metadata: {},
		};
		const memoryFile = path.join(tmpDir, '.swarm', 'memory', 'memories.jsonl');
		const proposalFile = path.join(
			tmpDir,
			'.swarm',
			'memory',
			'proposals.jsonl',
		);
		await fs.mkdir(path.dirname(memoryFile), { recursive: true });
		await fs.writeFile(
			memoryFile,
			`${JSON.stringify(valid)}\n${JSON.stringify(invalidMemory)}\n`,
			'utf-8',
		);
		await fs.writeFile(
			proposalFile,
			`${JSON.stringify({ id: 'prop_invalid' })}\n${JSON.stringify(invalidProposal)}\n`,
			'utf-8',
		);

		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });

		expect(await provider.list({})).toEqual([valid]);
		expect(await provider.listProposals({})).toEqual([]);
		const audit = await fs.readFile(
			path.join(tmpDir, '.swarm', 'memory', 'audit.jsonl'),
			'utf-8',
		);
		expect(audit).toContain('invalid memory JSONL row');
		expect(audit).toContain('invalid proposal JSONL row');
	});

	test('creates pending proposals without creating durable memory records', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const createdAt = '2026-05-24T12:00:00.000Z';
		const proposal: MemoryProposal = {
			id: createProposalId({
				createdAt,
				proposer: 'coder',
				text: 'This repo uses bun.',
			}),
			operation: 'add',
			proposedRecord: makeRecord('This repo uses bun.'),
			proposedBy: { agentRole: 'coder', runId: 'session-a' },
			rationale: 'Useful test command convention.',
			evidenceRefs: ['package.json'],
			status: 'pending',
			createdAt,
			metadata: {},
		};

		await provider.createProposal(proposal);

		expect(await provider.list({})).toHaveLength(0);
		expect(await provider.listProposals({ status: 'pending' })).toEqual([
			proposal,
		]);
		expect(
			existsSync(path.join(tmpDir, '.swarm', 'memory', 'proposals.jsonl')),
		).toBe(true);
	});
});
