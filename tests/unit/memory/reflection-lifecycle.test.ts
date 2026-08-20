import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { handleMemoryStaleCommand } from '../../../src/commands/memory';
import {
	computeMemoryContentHash,
	createMemoryId,
	DEFAULT_MEMORY_CONFIG,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { runConsolidationPass } from '../../../src/memory/consolidation';
import { buildMemoryMaintenanceReport } from '../../../src/memory/maintenance';
import { clearPool } from '../../../src/memory/provider-pool';
import {
	_test_exports,
	recordOutcomeWithReflection,
} from '../../../src/memory/reflection-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NOW = new Date('2026-08-19T12:00:00.000Z');
let root: string;
let originalXdgConfigHome: string | undefined;

beforeEach(async () => {
	originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
	root = canonicalMkdtemp('reflection-lifecycle-');
	process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
});

afterEach(async () => {
	clearPool();
	if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	await fs.rm(root, { recursive: true, force: true });
});

function record(label: string): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo' },
		kind: 'code_pattern' as const,
		text: `Reflection lifecycle ${label}`,
	};
	return {
		...base,
		id: createMemoryId(base),
		tags: ['reflection'],
		confidence: 0.8,
		stability: 'durable',
		source: { type: 'file', filePath: `src/${label}.ts` },
		createdAt: '2026-08-18T12:00:00.000Z',
		updatedAt: '2026-08-19T11:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
		anchors: [{ file: `src/${label}.ts` }],
	};
}

describe('reflection stale lifecycle', () => {
	test('selects deterministically and reserves a write-through slot for an old target beyond 2,000', () => {
		const oldTarget = {
			...record('old-target'),
			updatedAt: '2020-01-01T00:00:00.000Z',
		};
		const recent = Array.from({ length: 2000 }, (_, index) => ({
			...record(`recent-${index}`),
			id: `mem_${index.toString(16).padStart(16, '0')}`,
			updatedAt: '2026-08-19T11:00:00.000Z',
		}));
		const all = [...recent, oldTarget];

		const startup = _test_exports.selectReflectionEntries(all);
		const reversed = _test_exports.selectReflectionEntries([...all].reverse());
		const writeThrough = _test_exports.selectReflectionEntries(all, oldTarget);

		expect(startup).toHaveLength(2000);
		expect(startup.map((item) => item.id)).toEqual(
			reversed.map((item) => item.id),
		);
		expect(startup[0]?.id).toBe('mem_0000000000000000');
		expect(startup.some((item) => item.id === oldTarget.id)).toBe(false);
		expect(writeThrough).toHaveLength(2000);
		expect(writeThrough.some((item) => item.id === oldTarget.id)).toBe(true);
	});

	test('write-through digest includes an old target excluded by the normal 2,000-record window', async () => {
		const oldTarget = {
			...record('old-write-target'),
			updatedAt: '2020-01-01T00:00:00.000Z',
			outcomes: [{ outcome: 'useful' as const, at: NOW.toISOString() }],
			metadata: { outcomeEventIds: ['event-old-target'] },
			anchors: undefined,
		};
		const recent = Array.from({ length: 2000 }, (_, index) => ({
			...record(`window-${index}`),
			id: `mem_${index.toString(16).padStart(16, '0')}`,
			updatedAt: '2026-08-19T11:00:00.000Z',
			outcomes: undefined,
		}));
		let requestedLimit: number | undefined;
		const gateway = {
			recordOutcome: async () => oldTarget,
			listMemories: async (filter: { limit?: number }) => {
				requestedLimit = filter.limit;
				return recent.slice(0, filter.limit);
			},
		} as never;

		const result = await recordOutcomeWithReflection(
			root,
			{
				enabled: true,
				provider: 'local-jsonl',
				reflection: { enabled: true, halfLifeDays: 30 },
			},
			gateway,
			{
				memoryId: oldTarget.id,
				outcome: 'useful',
				eventId: 'write-through-old-target',
			},
		);

		expect(result.reflectionUpdated).toBe(true);
		if (!result.reflectionUpdated) throw new Error(result.error);
		expect(requestedLimit).toBe(2000);
		expect(result.digest.generatedFrom.entries).toBe(2000);
		expect(result.digest.tentative.map((item) => item.memoryId)).toContain(
			oldTarget.id,
		);
	});

	test('maintenance reports dead-anchor ids without deleting records', async () => {
		const stale = record('stale');
		const live = record('live');
		const provider = {
			list: async () => [live, stale],
		} as never;

		const report = await buildMemoryMaintenanceReport(provider, {
			now: NOW,
			deadAnchorMemoryIds: new Set([stale.id]),
		});

		expect(report.deadAnchorMemories.map((item) => item.id)).toEqual([
			stale.id,
		]);
		expect(report.totalMemories).toBe(2);
	});

	test('consolidation excludes dead-anchor memories from decay inputs', async () => {
		const stale = record('stale');
		const live = record('live');
		const upserted: string[] = [];
		const gateway = {
			isEnabled: () => true,
			listProposals: async () => [],
			listMemories: async () => [stale, live],
			propose: async () => {
				throw new Error('not reached');
			},
			applyCuratorDecision: async () => {
				throw new Error('not reached');
			},
			upsertCurated: async (memory: MemoryRecord) => {
				upserted.push(memory.id);
				return memory;
			},
		};

		await runConsolidationPass(
			{
				directory: root,
				phaseNumber: 1,
				config: {
					...DEFAULT_MEMORY_CONFIG,
					enabled: true,
					consolidation: {
						...DEFAULT_MEMORY_CONFIG.consolidation,
						enabled: true,
					},
				},
			},
			{
				gateway,
				now: () => NOW,
				logEvent: async () => {},
				readLog: async () => [],
				appendLog: async () => {},
				readDeadAnchorMemoryIds: () => new Set([stale.id]),
			},
		);

		expect(upserted).toEqual([live.id]);
	});

	test('/swarm memory stale consumes the local digest sidecar', async () => {
		const stale = record('command-stale');
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			await provider.upsert(stale);
		} finally {
			provider.close();
		}
		const reflectionDir = path.join(root, '.swarm', 'reflections');
		await fs.mkdir(reflectionDir, { recursive: true });
		await fs.writeFile(
			path.join(reflectionDir, 'lessons.json'),
			JSON.stringify({ deadAnchorMemoryIds: [stale.id] }),
			'utf-8',
		);

		const output = await handleMemoryStaleCommand(root, []);

		expect(output).toContain('Dead-anchor memories shown: `1`');
		expect(output).toContain(stale.id);
		expect(output).toContain('all anchors dead; retained');
		const verificationProvider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			expect(await verificationProvider.get(stale.id)).not.toBeNull();
		} finally {
			verificationProvider.close();
		}
	});
});
