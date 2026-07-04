import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleMemoryValueLogCommand } from '../../../src/commands/memory';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { clearPool } from '../../../src/memory/provider-pool';

let tmpDir: string;
let originalXdgConfigHome: string | undefined;

beforeEach(async () => {
	originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-value-log-')),
	);
	process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg-config');
});

afterEach(async () => {
	if (originalXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	}
	clearPool();
	await rmWithRetries(tmpDir);
});

describe('/swarm memory value-log', () => {
	test('reports Q-value, promotion, and suppression candidates', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, {
			enabled: true,
			provider: 'sqlite',
		});
		const promoted = makeRecord('Frequently approved memory.', { qValue: 0.9 });
		const suppressed = makeRecord('Rejected memory.', { qValue: 0.1 });
		try {
			await provider.upsert(promoted);
			await provider.upsert(suppressed);
			for (let i = 0; i < 6; i++) {
				await provider.recordRecallUsage?.(
					recallEvent(`run-${i}`, [promoted.id]),
				);
			}
			await provider.recordRecallUsage?.(
				recallEvent('run-low', [suppressed.id]),
			);
		} finally {
			provider.close();
		}

		const output = await handleMemoryValueLogCommand(tmpDir, ['--limit', '10']);

		expect(output).toContain('## Swarm Memory Value Log');
		expect(output).toContain('Promotion candidates shown: `1`');
		expect(output).toContain('Suppression candidates shown: `1`');
		expect(output).toContain(promoted.id);
		expect(output).toContain(suppressed.id);
	});
});

function makeRecord(
	text: string,
	overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
	const base = {
		scope: {
			type: 'repository' as const,
			repoId: 'repo-a',
			repoRoot: path.join(tmpDir, 'repo-a'),
		},
		kind: 'repo_convention' as const,
		text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['memory'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'README.md' },
		createdAt: '2026-07-02T12:00:00.000Z',
		updatedAt: '2026-07-02T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
		...overrides,
	};
}

function recallEvent(runId: string, memoryIds: string[]) {
	return {
		bundleId: `bundle-${runId}`,
		query: 'memory value',
		scopes: [{ type: 'repository' as const, repoId: 'repo-a' }],
		kinds: ['repo_convention' as const],
		memoryIds,
		scores: memoryIds.map(() => 0.8),
		tokenEstimate: 12,
		agentRole: 'architect',
		runId,
		timestamp: new Date().toISOString(),
	};
}

async function rmWithRetries(target: string): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			await fs.rm(target, { recursive: true, force: true });
			return;
		} catch (err) {
			if (attempt === 9) throw err;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}
