import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { DEFAULT_QLEARNING_CONFIG } from '../../../src/memory/config';
import { applyCouncilReward } from '../../../src/memory/reward-capture';

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), 'memory-reward-'));
});

afterEach(() => {
	rmSync(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

describe('applyCouncilReward', () => {
	test('returns zero rewarded memories when the run has no recall usage', async () => {
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const result = await applyCouncilReward(provider, {
				runId: 'session-without-recalls',
				unitId: '1.1',
				reward: 1,
				eta: DEFAULT_QLEARNING_CONFIG.learningRate,
				initialQValue: DEFAULT_QLEARNING_CONFIG.initialQValue,
				qLearning: DEFAULT_QLEARNING_CONFIG,
				timestamp: new Date().toISOString(),
				verdictLabel: 'APPROVE',
			});

			expect(result).toEqual({ memoriesRewarded: 0 });
		} finally {
			provider.close();
		}
	});

	test('rewards every distinct memory recalled by the matching run and unit', async () => {
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(
				makeRecord('Use the shared reward capture path for council verdicts.'),
			);
			await provider.recordRecallUsage?.({
				bundleId: 'bundle-1',
				query: 'memory reward',
				scopes: [{ type: 'repository', repoId: 'repo-a' }],
				kinds: ['repo_convention'],
				memoryIds: [record.id],
				scores: [0.8],
				tokenEstimate: 12,
				agentRole: 'architect',
				runId: 'session-arch',
				unitId: '1.1',
				timestamp: new Date().toISOString(),
			});

			const result = await applyCouncilReward(provider, {
				runId: 'session-arch',
				unitId: '1.1',
				reward: 1,
				eta: DEFAULT_QLEARNING_CONFIG.learningRate,
				initialQValue: DEFAULT_QLEARNING_CONFIG.initialQValue,
				qLearning: DEFAULT_QLEARNING_CONFIG,
				timestamp: new Date().toISOString(),
				verdictLabel: 'APPROVE',
			});

			const updated = await provider.get(record.id);
			expect(result).toEqual({ memoriesRewarded: 1 });
			expect(updated?.metadata.qValue).toBeCloseTo(0.55, 5);
		} finally {
			provider.close();
		}
	});

	test('does not reward a sibling task bundle from the same session', async () => {
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const sibling = await provider.upsert(
				makeRecord('Sibling task memory must not receive this reward.'),
			);
			await provider.recordRecallUsage?.({
				bundleId: 'bundle-sibling',
				query: 'memory reward',
				scopes: [{ type: 'repository', repoId: 'repo-a' }],
				kinds: ['repo_convention'],
				memoryIds: [sibling.id],
				scores: [0.8],
				tokenEstimate: 12,
				agentRole: 'architect',
				runId: 'session-arch',
				unitId: '2.1',
				timestamp: new Date().toISOString(),
			});

			const result = await applyCouncilReward(provider, {
				runId: 'session-arch',
				unitId: '1.1',
				reward: 1,
				eta: DEFAULT_QLEARNING_CONFIG.learningRate,
				initialQValue: DEFAULT_QLEARNING_CONFIG.initialQValue,
				qLearning: DEFAULT_QLEARNING_CONFIG,
				timestamp: new Date().toISOString(),
				verdictLabel: 'APPROVE',
			});

			const unchanged = await provider.get(sibling.id);
			expect(result).toEqual({ memoriesRewarded: 0 });
			expect(unchanged?.metadata.qValue).toBeUndefined();
		} finally {
			provider.close();
		}
	});
});

function makeRecord(text: string): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'repo_convention' as const,
		text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['memory'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'AGENTS.md' },
		createdAt: '2026-07-02T00:00:00.000Z',
		updatedAt: '2026-07-02T00:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}
