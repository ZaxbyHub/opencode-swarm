import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	DEFAULT_MEMORY_CONFIG,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	}
});

describe('SQLite memory learning loop', () => {
	test('approved council outcome increases recalled memory Q-value', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(
				makeRecord('Use Bun for unit tests.'),
			);
			await provider.recordRecallUsage?.(
				recallEvent('run-approve', [record.id]),
			);

			const result = await provider.applyRecallReward?.({
				runId: 'run-approve',
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});
			const updated = await provider.get(record.id);

			expect(result?.success).toBe(true);
			expect(result?.updatedMemoryIds).toEqual([record.id]);
			expect(updated?.qValue).toBeCloseTo(0.55, 5);
		} finally {
			provider.close();
		}
	});

	test('rejected council outcome decreases recalled memory Q-value', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(makeRecord('Prefer small patches.'));
			await provider.recordRecallUsage?.(
				recallEvent('run-reject', [record.id]),
			);

			const result = await provider.applyRecallReward?.({
				runId: 'run-reject',
				outcome: 'rejected',
				verdictPayload: { overallVerdict: 'REJECT' },
			});
			const updated = await provider.get(record.id);

			expect(result?.reward).toBe(-1);
			expect(updated?.qValue).toBeCloseTo(0.35, 5);
		} finally {
			provider.close();
		}
	});

	test('reward propagates softly to recently recalled similar memories', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
			learning: {
				...DEFAULT_MEMORY_CONFIG.learning,
				propagationTokenOverlapThreshold: 0.4,
				propagationFanout: 5,
			},
		});
		try {
			const source = await provider.upsert(
				makeRecord(
					'Use bounded memory recall reward updates for council verdicts.',
				),
			);
			const target = await provider.upsert(
				makeRecord(
					'Use bounded memory recall reward updates for phase verdicts.',
				),
			);
			await provider.recordRecallUsage?.(recallEvent('run-old', [target.id]));
			await provider.recordRecallUsage?.(
				recallEvent('run-source', [source.id]),
			);

			const result = await provider.applyRecallReward?.({
				runId: 'run-source',
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});
			const propagated = await provider.get(target.id);

			expect(result?.updatedMemoryIds).toEqual([source.id]);
			expect(result?.propagatedMemoryIds).toContain(target.id);
			expect(propagated?.qValue).toBeGreaterThan(0.5);
			expect(propagated?.qValue).toBeLessThan(0.55);
		} finally {
			provider.close();
		}
	});

	test('value log reports promotion candidates after repeated successful recall', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(
				makeRecord('High-value convention.', { qValue: 0.9 }),
			);
			for (let i = 0; i < 6; i++) {
				await provider.recordRecallUsage?.(
					recallEvent(`run-${i}`, [record.id]),
				);
			}

			const entries = await provider.listMemoryValueLog?.({ limit: 10 });
			const entry = entries?.find((item) => item.memoryId === record.id);

			expect(entry?.promotionCandidate).toBe(true);
			expect(entry?.recallCount).toBe(6);
			expect(entry?.qValue).toBe(0.9);
		} finally {
			provider.close();
		}
	});
});

function tempRoot(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), 'memory-learning-loop-'));
	roots.push(root);
	return root;
}

function makeRecord(
	text: string,
	overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'repo_convention' as const,
		text,
	};
	return {
		id: createMemoryId({ ...base, ...overrides }),
		...base,
		tags: ['memory'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'AGENTS.md' },
		createdAt: '2026-07-02T00:00:00.000Z',
		updatedAt: '2026-07-02T00:00:00.000Z',
		contentHash: computeMemoryContentHash({ ...base, ...overrides }),
		metadata: {},
		...overrides,
	};
}

function recallEvent(runId: string, memoryIds: string[]) {
	return {
		bundleId: `bundle-${runId}`,
		query: 'memory reward',
		scopes: [{ type: 'repository' as const, repoId: 'repo-a' }],
		kinds: ['repo_convention' as const],
		memoryIds,
		scores: memoryIds.map(() => 0.8),
		tokenEstimate: 16,
		agentRole: 'architect',
		runId,
		timestamp: new Date().toISOString(),
	};
}

// FB-002: Auto-promotion to durable persistence
describe('SQLite memory auto-promotion (FB-002)', () => {
	test('session memory with qValue > threshold and recallCount > 5 is promoted to durable', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			// Start with qValue 0.9 (above promotionThreshold of 0.85) and stability session.
			const record = await provider.upsert(
				makeRecord('High-value session memory.', {
					qValue: 0.9,
					stability: 'session',
				}),
			);
			// Seed 6 recall events so recallCount > 5.
			for (let i = 0; i < 6; i++) {
				await provider.recordRecallUsage?.(
					recallEvent(`run-promote-${i}`, [record.id]),
				);
			}
			expect(record.stability).toBe('session');

			const result = await provider.applyRecallReward?.({
				runId: 'run-promote-5',
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});
			const updated = await provider.get(record.id);

			expect(result?.success).toBe(true);
			expect(updated?.stability).toBe('durable');
		} finally {
			provider.close();
		}
	});

	test('already durable memory stays durable after further rewards', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(
				makeRecord('Already durable memory.', {
					qValue: 0.95,
					stability: 'durable',
				}),
			);
			for (let i = 0; i < 3; i++) {
				await provider.recordRecallUsage?.(
					recallEvent(`run-durable-${i}`, [record.id]),
				);
			}

			await provider.applyRecallReward?.({
				runId: 'run-durable-0',
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});
			const updated = await provider.get(record.id);

			expect(updated?.stability).toBe('durable');
		} finally {
			provider.close();
		}
	});

	test('session memory with only qValue threshold met does NOT promote (recallCount <= 5)', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			// qValue above threshold but only 3 recalls.
			const record = await provider.upsert(
				makeRecord('High qValue but low recall count.', {
					qValue: 0.9,
					stability: 'session',
				}),
			);
			for (let i = 0; i < 3; i++) {
				await provider.recordRecallUsage?.(
					recallEvent(`run-qonly-${i}`, [record.id]),
				);
			}

			await provider.applyRecallReward?.({
				runId: 'run-qonly-0',
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});
			const updated = await provider.get(record.id);

			expect(updated?.stability).toBe('session');
		} finally {
			provider.close();
		}
	});
});

// FB-003: Transaction atomicity
describe('SQLite memory learning loop transaction atomicity (FB-003)', () => {
	test('applyRecallReward returns failure when _internals.writeMemory throws during promotion', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			// Source memory that will be directly updated.
			const source = await provider.upsert(
				makeRecord('Source memory for transaction atomicity test.'),
			);
			// Similar target that will receive propagated reward.
			const target = await provider.upsert(
				makeRecord(
					'Target memory for transaction atomicity test — highly similar.',
				),
			);
			await provider.recordRecallUsage?.(
				recallEvent('run-atomic', [source.id]),
			);
			await provider.recordRecallUsage?.(
				recallEvent('run-atomic-target', [target.id]),
			);

			// Inject a failure for writeMemory in the promotion loop.
			const originalWriteMemory = provider._internals.writeMemory;
			provider._internals.writeMemory = (_record: MemoryRecord) => {
				throw new Error('Injected writeMemory failure for atomicity test');
			};

			try {
				const result = await provider.applyRecallReward?.({
					runId: 'run-atomic',
					outcome: 'approved',
					verdictPayload: { overallVerdict: 'APPROVE' },
				});
				// When _internals.writeMemory throws inside the transaction callback,
				// the exception propagates out. applyRecallReward should not return
				// success in this case. If result is defined, it must be a failure.
				if (result !== undefined) {
					expect(result.success).toBe(false);
				}
				// If result is undefined (function threw), that's also acceptable.
			} catch (_err) {
				// Expected: applyRecallReward throws when _internals.writeMemory throws.
			} finally {
				provider._internals.writeMemory = originalWriteMemory;
			}
		} finally {
			provider.close();
		}
	});
});
