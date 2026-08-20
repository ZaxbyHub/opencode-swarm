import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { handleMemoryExportCommand } from '../../../src/commands/memory';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { clearPool } from '../../../src/memory/provider-pool';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let root: string;

beforeEach(async () => {
	root = canonicalMkdtemp('memory-outcome-export-');
});

afterEach(async () => {
	clearPool();
	await fs.rm(root, { recursive: true, force: true });
});

function record(): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo' },
		kind: 'evidence' as const,
		text: 'Export canonical outcome history.',
	};
	return {
		...base,
		id: createMemoryId(base),
		tags: ['outcome'],
		confidence: 0.8,
		stability: 'durable',
		source: { type: 'tool', ref: 'test' },
		createdAt: '2026-08-19T10:00:00.000Z',
		updatedAt: '2026-08-19T10:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

test('/swarm memory export includes canonical outcome events', async () => {
	const provider = new SQLiteMemoryProvider(root, {
		enabled: true,
		provider: 'sqlite',
	});
	const memory = record();
	try {
		await provider.upsert(memory);
		await provider.appendOutcome(memory.id, {
			id: 'export-outcome',
			outcome: {
				outcome: 'useful',
				at: '2026-08-19T12:00:00.000Z',
			},
		});
	} finally {
		provider.close();
	}

	const output = await handleMemoryExportCommand(root, []);
	const outcomePath = path.join(
		root,
		'.swarm',
		'memory',
		'export',
		'outcome-events.jsonl',
	);
	expect(output).toContain('Outcomes: `1`');
	expect(await fs.readFile(outcomePath, 'utf-8')).toContain('export-outcome');
});
