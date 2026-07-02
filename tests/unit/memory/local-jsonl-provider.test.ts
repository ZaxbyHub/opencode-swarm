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
import { DEFAULT_QLEARNING_CONFIG } from '../../../src/memory/config';

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

	test('records recall usage through the provider audit seam', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const repoA = makeRecord('Repo A uses pnpm for tests.', 'repo-a');
		await provider.upsert(repoA);

		await provider.recordRecallUsage({
			bundleId: 'bundle_20260524_abcd',
			query: 'pnpm tests',
			scopes: [repoA.scope],
			kinds: ['repo_convention'],
			memoryIds: [repoA.id],
			scores: [0.9],
			tokenEstimate: 100,
			agentRole: 'coder',
			runId: 'session-a',
			timestamp: '2026-05-24T12:00:00.000Z',
		});

		const audit = await fs.readFile(
			path.join(tmpDir, '.swarm', 'memory', 'audit.jsonl'),
			'utf-8',
		);
		const usage = await provider.listRecallUsage();
		expect(audit).toContain('"operation":"recall"');
		expect(audit).toContain(repoA.id);
		expect(audit).toContain('bundle_20260524_abcd');
		expect(usage).toEqual([
			expect.objectContaining({
				bundleId: 'bundle_20260524_abcd',
				memoryIds: [repoA.id],
				agentRole: 'coder',
			}),
		]);
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

// ---------------------------------------------------------------------------
// C.1 reviewer fix — maxItems-additive exploration slicing (Fix 1 / Fix 3)
// ---------------------------------------------------------------------------
//
// `explorationRate: 1` makes the C.1 exploration draw fire on every recall
// deterministically (any `Math.random()` draw in [0,1) is < 1), so this test
// does not need an injectable RNG seam — LocalJsonlMemoryProvider does not
// expose one for `recall`/`recallWithDiagnostics`.
describe('C.1 reviewer fix — maxItems-additive exploration slicing', () => {
	function makeExplorableRecord(
		text: string,
		overrides: Partial<MemoryRecord> = {},
	): MemoryRecord {
		const base = {
			scope: {
				type: 'repository' as const,
				repoId: 'repo-explore',
				repoRoot: path.join(tmpDir, 'repo-explore'),
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
			source: { type: 'file', filePath: 'package.json' },
			createdAt: '2026-05-24T12:00:00.000Z',
			updatedAt: '2026-05-24T12:00:00.000Z',
			contentHash: computeMemoryContentHash(base),
			metadata: {},
			...overrides,
		};
	}

	test('explored item is appended additively beyond maxItems — never evicts a normal hit (falsifiable: pre-fix slice(0,maxItems) drops one)', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, {
			enabled: true,
			qLearning: { ...DEFAULT_QLEARNING_CONFIG, explorationRate: 1 },
		});

		// Two normal (non-suppressed) hits with an EQUAL, LOWER baseScore than
		// the suppressed candidate below (no tag overlap: baseScore ≈ 0.578).
		const normal1 = makeExplorableRecord(
			'The database pool timeout configuration is documented here in module one.',
		);
		const normal2 = makeExplorableRecord(
			'The database pool timeout configuration is documented here in module two.',
		);
		// Suppressed candidate with a deliberately HIGHER baseScore (tag overlap
		// on all 3 query tokens: baseScore ≈ 0.738) than both normal hits, so a
		// naive `[...items].sort(scoreDesc).slice(0, maxItems)` would rank it
		// ABOVE one of the normal hits and evict it — exactly the regression
		// this additive fix prevents.
		const suppressed = makeExplorableRecord(
			'The database pool timeout configuration is documented here for exploration.',
			{ tags: ['database', 'pool', 'timeout'], metadata: { qValue: 0.05 } },
		);

		await provider.upsert(normal1);
		await provider.upsert(normal2);
		await provider.upsert(suppressed);

		const { items, diagnostics } = await provider.recallWithDiagnostics({
			query: 'database pool timeout',
			scopes: [normal1.scope],
			maxItems: 2,
			tokenBudget: 1000,
			minScore: 0,
		});

		// Additive result: 2 normal hits (the maxItems cap) + 1 explored item.
		expect(items).toHaveLength(3);
		const ids = items.map((item) => item.record.id);
		expect(ids).toContain(normal1.id);
		expect(ids).toContain(normal2.id);
		expect(ids).toContain(suppressed.id);

		const exploredItems = items.filter((item) => item.explored === true);
		expect(exploredItems).toHaveLength(1);
		expect(exploredItems[0].record.id).toBe(suppressed.id);

		// Diagnostics reflect what is actually present in the returned bundle
		// (Fix 3).
		expect(diagnostics.exploredCount).toBe(1);
		expect(diagnostics.returnedCount).toBe(3);
	});

	test('no explored candidate: maxItems still caps normal hits exactly (unchanged behavior)', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, {
			enabled: true,
			qLearning: { ...DEFAULT_QLEARNING_CONFIG, explorationRate: 1 },
		});

		const normal1 = makeExplorableRecord(
			'The database pool timeout configuration is documented here in module one.',
		);
		const normal2 = makeExplorableRecord(
			'The database pool timeout configuration is documented here in module two.',
		);
		const normal3 = makeExplorableRecord(
			'The database pool timeout configuration is documented here in module three.',
		);
		await provider.upsert(normal1);
		await provider.upsert(normal2);
		await provider.upsert(normal3);

		const { items, diagnostics } = await provider.recallWithDiagnostics({
			query: 'database pool timeout',
			scopes: [normal1.scope],
			maxItems: 2,
			tokenBudget: 1000,
			minScore: 0,
		});

		// Nothing was suppressed, so exploration is a no-op regardless of the
		// forced explorationRate: 1 — plain maxItems capping applies.
		expect(items).toHaveLength(2);
		expect(items.every((item) => item.explored === undefined)).toBe(true);
		expect(diagnostics.exploredCount).toBe(0);
		expect(diagnostics.returnedCount).toBe(2);
	});
});
