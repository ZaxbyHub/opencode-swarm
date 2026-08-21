import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	DEFAULT_MEMORY_CONFIG,
	LocalJsonlMemoryProvider,
	type MemoryProvider,
	type MemoryRecord,
} from '../../../src/memory';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
const openProviders: MemoryProvider[] = [];

beforeEach(() => {
	tmpDir = canonicalMkdtemp('swarm-outcome-provider-jsonl-');
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

test('JSONL reopen applies the current durable-secret policy to canonical outcomes', async () => {
	const root = path.join(tmpDir, 'jsonl-reopen-secret-policy');
	await fs.mkdir(root, { recursive: true });
	const permissive = track(
		new LocalJsonlMemoryProvider(root, {
			...DEFAULT_MEMORY_CONFIG,
			enabled: true,
			redaction: { rejectDurableSecrets: false },
		}),
	);
	const base = memory('Policy-sensitive canonical outcome.');
	await permissive.upsert(base);
	await permissive.appendOutcome?.(base.id, {
		id: 'permissive-secret',
		outcome: {
			outcome: 'corrected',
			at: '2026-08-19T11:00:00.000Z',
			correction: 'Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz12345',
		},
	});
	await permissive.close?.();

	const strict = track(
		new LocalJsonlMemoryProvider(root, {
			...DEFAULT_MEMORY_CONFIG,
			enabled: true,
			redaction: { rejectDurableSecrets: true },
		}),
	);
	expect(await strict.get(base.id)).toBeNull();
	expect(
		(await strict.list({ includeInactive: true })).map((item) => item.id),
	).not.toContain(base.id);
});

test('JSONL invalid newest base row cannot resurrect an older valid row', async () => {
	const root = path.join(tmpDir, 'jsonl-invalid-newest-row');
	await fs.mkdir(root, { recursive: true });
	const provider = track(new LocalJsonlMemoryProvider(root, { enabled: true }));
	const base = memory('Last row owns this memory identity.');
	await provider.upsert(base);
	await provider.close?.();
	await fs.appendFile(
		memoryFile(root, 'memories.jsonl'),
		`${JSON.stringify({ ...base, contentHash: 'invalid-newest-row' })}\n`,
		'utf-8',
	);

	const reopened = track(new LocalJsonlMemoryProvider(root, { enabled: true }));
	expect(await reopened.get(base.id)).toBeNull();
	expect(
		(await reopened.list({ includeInactive: true })).map((item) => item.id),
	).not.toContain(base.id);
});

test('JSONL readers ignore and the next append repairs an incomplete tail', async () => {
	const root = path.join(tmpDir, 'jsonl-incomplete-tail');
	await fs.mkdir(root, { recursive: true });
	const provider = track(new LocalJsonlMemoryProvider(root, { enabled: true }));
	const base = memory();
	await provider.upsert(base);
	const first = await provider.appendOutcome?.(base.id, {
		id: 'complete-event',
		outcome: { outcome: 'useful', at: '2026-08-19T11:00:00.000Z' },
	});
	const outcomePath = memoryFile(root, 'outcome-events.jsonl');
	await fs.appendFile(
		outcomePath,
		JSON.stringify({
			id: 'unterminated-event',
			memoryId: base.id,
			generation: first?.metadata.outcomeGeneration,
			outcome: { outcome: 'useful', at: '2026-08-19T11:00:01.000Z' },
			anchors: [],
		}),
		'utf-8',
	);

	expect((await provider.get(base.id))?.metadata.outcomeEventIds).toEqual([
		'complete-event',
	]);
	await provider.appendOutcome?.(base.id, {
		id: 'after-repair',
		outcome: { outcome: 'dead_end', at: '2026-08-19T11:00:02.000Z' },
	});
	expect((await provider.get(base.id))?.metadata.outcomeEventIds).toEqual([
		'complete-event',
		'after-repair',
	]);
});

test('JSONL rejects a materialized anchor union above the schema cap before persisting it', async () => {
	const root = path.join(tmpDir, 'jsonl-anchor-overflow');
	await fs.mkdir(root, { recursive: true });
	const provider = track(new LocalJsonlMemoryProvider(root, { enabled: true }));
	const base = memory('Anchor-overflow guard.');
	await provider.upsert(base);
	const initialAnchors = Array.from({ length: 20 }, (_, index) => ({
		file: `src/anchor-${index.toString().padStart(2, '0')}.ts`,
	}));
	await provider.appendOutcome?.(
		base.id,
		{
			id: 'anchor-cap-base',
			outcome: { outcome: 'useful', at: '2026-08-19T11:00:00.000Z' },
		},
		initialAnchors,
	);
	const memoryPath = memoryFile(root, 'memories.jsonl');
	const outcomePath = memoryFile(root, 'outcome-events.jsonl');
	const beforeMemoryLines = await readJsonlLines(memoryPath);
	const beforeOutcomeLines = await readJsonlLines(outcomePath);

	await expect(
		provider.appendOutcome?.(
			base.id,
			{
				id: 'anchor-cap-overflow',
				outcome: { outcome: 'dead_end', at: '2026-08-19T11:00:01.000Z' },
			},
			[{ file: 'src/anchor-overflow.ts' }],
		),
	).rejects.toThrow();
	expect(await readJsonlLines(memoryPath)).toEqual(beforeMemoryLines);
	expect(await readJsonlLines(outcomePath)).toEqual(beforeOutcomeLines);
	expect((await provider.get(base.id))?.anchors).toEqual(initialAnchors);
});

test('JSONL repairs a base-row-only partial outcome append and exact replays stay no-op', async () => {
	const root = path.join(tmpDir, 'jsonl-outcome-replay-repair');
	await fs.mkdir(root, { recursive: true });
	const provider = track(new LocalJsonlMemoryProvider(root, { enabled: true }));
	const base = memory('Replay repair guard.');
	await provider.upsert(base);
	const memoryPath = memoryFile(root, 'memories.jsonl');
	const outcomePath = memoryFile(root, 'outcome-events.jsonl');
	const partialBase = {
		...base,
		metadata: { ...base.metadata, outcomeGeneration: 'partial-generation' },
	};
	await fs.appendFile(memoryPath, `${JSON.stringify(partialBase)}\n`, 'utf-8');

	expect(await readJsonlLines(memoryPath)).toHaveLength(2);
	expect(await readJsonlLines(outcomePath)).toHaveLength(0);
	const repaired = await provider.appendOutcome?.(base.id, {
		id: 'repair-event',
		outcome: { outcome: 'useful', at: '2026-08-19T11:00:00.000Z' },
	});
	expect(repaired?.metadata.outcomeEventIds).toEqual(['repair-event']);
	expect(await readJsonlLines(memoryPath)).toHaveLength(2);
	expect(await readJsonlLines(outcomePath)).toHaveLength(1);

	await provider.appendOutcome?.(base.id, {
		id: 'repair-event',
		outcome: { outcome: 'useful', at: '2026-08-19T11:00:01.000Z' },
	});
	expect(await readJsonlLines(memoryPath)).toHaveLength(2);
	expect(await readJsonlLines(outcomePath)).toHaveLength(1);
	expect((await provider.get(base.id))?.metadata.outcomeEventIds).toEqual([
		'repair-event',
	]);
});
