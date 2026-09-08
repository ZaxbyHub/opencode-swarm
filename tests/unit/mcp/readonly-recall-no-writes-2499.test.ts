import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { readAuthoritativeKnowledgeCounterRollups } from '../../../src/hooks/knowledge-events';
import {
	knowledgeRecallAdapter,
	swarmMemoryRecallAdapter,
} from '../../../src/mcp/adapters/knowledge-memory';
import { computeSwarmMemoryRecall } from '../../../src/tools/swarm-memory-recall';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * #2499 final-critic hardening: the two recall adapters must leave the
 * project tree byte-identical in the configurations where their writers
 * actually live — a memory-enabled root and a knowledge-present root. The
 * frozen C6 check only exercises a storeless fixture, so these committed
 * tests pin the enabled-configuration no-write contract directly
 * (swarm_memory_recall telemetry + sqlite genesis; knowledge receipts-v2
 * ledger genesis).
 */

function snapshotTree(root: string): Map<string, number> {
	const files = new Map<string, number>();
	const walk = (dir: string, rel: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs, relPath);
			else files.set(relPath, statSync(abs).size);
		}
	};
	walk(root, '');
	return files;
}

function diffTree(
	before: Map<string, number>,
	after: Map<string, number>,
): string[] {
	const changes: string[] = [];
	for (const [name, size] of after) {
		if (!before.has(name)) changes.push(`new ${name} (${size}b)`);
	}
	for (const [name, size] of before) {
		if (!after.has(name)) changes.push(`gone ${name}`);
		else if (after.get(name) !== size) {
			changes.push(`changed ${name} ${size}b -> ${after.get(name)}b`);
		}
	}
	return changes;
}

function seedKnowledge(root: string) {
	mkdirSync(path.join(root, '.swarm', 'knowledge'), { recursive: true });
	writeFileSync(
		path.join(root, '.swarm', 'knowledge', 'knowledge.json'),
		JSON.stringify({
			version: 2,
			entries: [
				{
					id: 'k1',
					title: 'handles',
					lesson: 'always close file handles after use',
					tags: ['fs'],
					status: 'active',
					tier: 'swarm',
					source: 'manual',
					created: '2026-01-01T00:00:00Z',
					updated: '2026-01-01T00:00:00Z',
					scope: [],
				},
			],
		}),
	);
}

function seedMemoryRoot(root: string) {
	mkdirSync(path.join(root, '.swarm', 'memory'), { recursive: true });
	mkdirSync(path.join(root, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(root, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ memory: { enabled: true } }),
	);
}

describe('MCP recall adapters never write (#2499 final-critic hardening)', () => {
	test('knowledge_recall never materializes the receipts-v2 ledger', async () => {
		const root = canonicalMkdtemp('mcp-know-nowrite-2499-');
		seedKnowledge(root);
		const before = snapshotTree(root);
		const result = (await knowledgeRecallAdapter.execute(
			{ query: 'file handles' },
			root,
		)) as { results: unknown[]; total: number };
		expect(result.total).toBe(result.results.length);
		expect(
			existsSync(path.join(root, '.swarm', 'knowledge-receipts-v2.jsonl')),
		).toBe(false);
		expect(diffTree(before, snapshotTree(root))).toEqual([]);
	}, 30000);

	test('knowledge_recall leaves an empty pre-existing journal untouched', async () => {
		const root = canonicalMkdtemp('mcp-know-emptyjournal-2499-');
		seedKnowledge(root);
		const journal = path.join(root, '.swarm', 'knowledge-receipts-v2.jsonl');
		writeFileSync(journal, '');
		const before = snapshotTree(root);
		await knowledgeRecallAdapter.execute({ query: 'file handles' }, root);
		expect(statSync(journal).size).toBe(0);
		expect(diffTree(before, snapshotTree(root))).toEqual([]);
	}, 30000);

	test('skipLedgerGenesis is load-bearing: the rollup read it skips is the genesis writer', async () => {
		// The guarded call is readAuthoritativeKnowledgeCounterRollups: its
		// runLocked open materializes the journal. Driving it directly (the
		// exact call skipLedgerGenesis skips) proves the flag — not some other
		// read-path difference — is what prevents genesis.
		const root = canonicalMkdtemp('mcp-know-flag-2499-');
		await readAuthoritativeKnowledgeCounterRollups(root);
		expect(
			existsSync(path.join(root, '.swarm', 'knowledge-receipts-v2.jsonl')),
		).toBe(true);
	}, 30000);

	test('swarm_memory_recall degrades on a storeless memory-enabled root without genesis', async () => {
		const root = canonicalMkdtemp('mcp-mem-storeless-2499-');
		seedMemoryRoot(root);
		const before = snapshotTree(root);
		const result = (await swarmMemoryRecallAdapter.execute(
			{ query: 'anything' },
			root,
		)) as { available: boolean; reason: string };
		expect(result.available).toBe(false);
		expect(result.reason).toBe('no_store');
		expect(existsSync(path.join(root, '.swarm', 'memory', 'memory.db'))).toBe(
			false,
		);
		expect(diffTree(before, snapshotTree(root))).toEqual([]);
	}, 30000);

	test('swarm_memory_recall reads an initialized store byte-identically (telemetry-free path)', async () => {
		const root = canonicalMkdtemp('mcp-mem-initialized-2499-');
		seedMemoryRoot(root);
		// Setup (allowed to write): one recording recall initializes the store.
		await computeSwarmMemoryRecall({ query: 'seed' }, root, {
			sessionID: 'setup',
		});
		expect(existsSync(path.join(root, '.swarm', 'memory', 'memory.db'))).toBe(
			true,
		);
		const before = snapshotTree(root);
		const result = (await swarmMemoryRecallAdapter.execute(
			{ query: 'anything' },
			root,
		)) as { success: boolean };
		expect(result.success).toBe(true);
		expect(diffTree(before, snapshotTree(root))).toEqual([]);
	}, 60000);

	test('recordUsage is load-bearing: the default (recording) recall mutates the tree', async () => {
		const root = canonicalMkdtemp('mcp-mem-flag-2499-');
		seedMemoryRoot(root);
		await computeSwarmMemoryRecall({ query: 'seed' }, root, {
			sessionID: 'setup',
		});
		const before = snapshotTree(root);
		await computeSwarmMemoryRecall({ query: 'anything' }, root, {
			sessionID: 'setup',
		});
		expect(diffTree(before, snapshotTree(root)).length).toBeGreaterThan(0);
	}, 60000);
});
