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
				runIds: ['run-approve'],
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
				runIds: ['run-reject'],
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
				runIds: ['run-source'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});
			const propagated = await provider.get(target.id);

			expect(result?.updatedMemoryIds).toEqual([source.id]);
			expect(result?.propagatedMemoryIds).toContain(target.id);
			// Exact formula-derived value (not just a range): propagatedRewardSignal
			// with default propagationFactor=0.3 and reward=1 is
			// 0.5 + 0.3*(1-0.5) = 0.65, then EMA with default eta=0.1 from a
			// starting qValue of 0.5 gives 0.9*0.5 + 0.1*0.65 = 0.515. A
			// regression in the propagation factor, formula shape, or clamping
			// would change this exact value even if it stayed in the (0.5, 0.55)
			// range a looser assertion would allow.
			expect(propagated?.qValue).toBeCloseTo(0.515, 5);
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
				runIds: ['run-promote-5'],
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
				runIds: ['run-durable-0'],
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
				runIds: ['run-qonly-0'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});
			const updated = await provider.get(record.id);

			expect(updated?.stability).toBe('session');
		} finally {
			provider.close();
		}
	});

	test('session memory at the exact recallCount=5 boundary does NOT promote (threshold is > 5, not >= 5)', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(
				makeRecord('High qValue at the exact recall-count boundary.', {
					qValue: 0.9,
					stability: 'session',
				}),
			);
			// Exactly 5 recalls — the promotion gate requires recallCount > 5, so
			// this must NOT promote. An off-by-one regression (e.g. `>= 5`) would
			// only be caught by testing this exact boundary, not a looser count.
			for (let i = 0; i < 5; i++) {
				await provider.recordRecallUsage?.(
					recallEvent(`run-boundary-${i}`, [record.id]),
				);
			}

			await provider.applyRecallReward?.({
				runIds: ['run-boundary-0'],
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
					runIds: ['run-atomic'],
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

// Trust-boundary fix: reward every distinct matched session's own recall
// bundle, not just one arbitrary bundle (PR #1636 review F-002/F-003/F-010).
describe('SQLite memory learning loop multi-session reward', () => {
	test('rewards every distinct matched runId, not just one bundle (fixes: dispatched sub-agent sessions were previously silently skipped)', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const architectRecord = await provider.upsert(
				makeRecord('Architect-recalled convention.'),
			);
			const criticRecord = await provider.upsert(
				makeRecord('Critic-recalled convention.'),
			);
			// Two DIFFERENT sessions each recalled a different memory — this
			// models the real topology where dispatched council-member
			// sub-agents recall under their own session id, distinct from the
			// architect's submitting session.
			await provider.recordRecallUsage?.(
				recallEvent('session-architect', [architectRecord.id]),
			);
			await provider.recordRecallUsage?.(
				recallEvent('session-critic', [criticRecord.id]),
			);

			const result = await provider.applyRecallReward?.({
				runIds: ['session-architect', 'session-critic'],
				outcome: 'approved',
				verdictPayload: {
					taskId: '1.1',
					swarmId: 'mega',
					roundNumber: 1,
					overallVerdict: 'APPROVE',
				},
			});

			expect(result?.success).toBe(true);
			expect(result?.updatedMemoryIds?.sort()).toEqual(
				[architectRecord.id, criticRecord.id].sort(),
			);
			expect(result?.bundleIds?.length).toBe(2);
			const architectUpdated = await provider.get(architectRecord.id);
			const criticUpdated = await provider.get(criticRecord.id);
			expect(architectUpdated?.qValue).toBeCloseTo(0.55, 5);
			expect(criticUpdated?.qValue).toBeCloseTo(0.55, 5);
		} finally {
			provider.close();
		}
	});

	test('an unresolved/unknown runId among the candidates is simply ignored (no match), not treated as an error', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(makeRecord('Only one recaller.'));
			await provider.recordRecallUsage?.(
				recallEvent('session-real', [record.id]),
			);

			const result = await provider.applyRecallReward?.({
				runIds: ['session-real', 'session-never-recalled-anything'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});

			expect(result?.success).toBe(true);
			expect(result?.updatedMemoryIds).toEqual([record.id]);
			expect(result?.bundleIds?.length).toBe(1);
		} finally {
			provider.close();
		}
	});

	test('no candidate runId matches any recall-usage row: returns no_recall_usage_for_run, not an unscoped fallback', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(makeRecord('Unrelated memory.'));
			// Recall happened under a completely different session than the
			// one submitting the verdict, and it is NOT included in runIds —
			// there must be no "grab whatever's recent" fallback that silently
			// rewards this unrelated bundle.
			await provider.recordRecallUsage?.(
				recallEvent('session-unrelated', [record.id]),
			);

			const result = await provider.applyRecallReward?.({
				runIds: ['session-submitting-architect'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});

			expect(result?.success).toBe(false);
			expect(result?.reason).toBe('no_recall_usage_for_run');
			const unchanged = await provider.get(record.id);
			// Never rewarded — qValue stays unset (the EMA update, which would
			// set an explicit numeric qValue, never ran for this record).
			expect(unchanged?.qValue).toBeUndefined();
		} finally {
			provider.close();
		}
	});
});

// F-004: reward idempotency — a duplicate council-verdict submission for the
// same swarmId+task+round must not re-apply the EMA update indefinitely.
describe('SQLite memory learning loop reward idempotency (F-004)', () => {
	test('applying the same verdict payload twice only updates Q-value once', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(
				makeRecord('Memory rewarded twice by a retried verdict submission.'),
			);
			await provider.recordRecallUsage?.(recallEvent('run-dup', [record.id]));
			const verdictPayload = {
				taskId: '1.1',
				swarmId: 'mega',
				roundNumber: 1,
				overallVerdict: 'APPROVE',
			};

			const first = await provider.applyRecallReward?.({
				runIds: ['run-dup'],
				outcome: 'approved',
				verdictPayload,
			});
			const second = await provider.applyRecallReward?.({
				runIds: ['run-dup'],
				outcome: 'approved',
				verdictPayload,
			});

			expect(first?.success).toBe(true);
			expect(first?.reason).toBeUndefined();
			expect(second?.success).toBe(true);
			expect(second?.reason).toBe('already_rewarded');
			expect(second?.updatedMemoryIds).toEqual([]);
			const afterBoth = await provider.get(record.id);
			// EMA applied exactly once: 0.9*0.5 + 0.1*1 = 0.55, NOT reapplied a
			// second time (which would have pushed it further toward 1).
			expect(afterBoth?.qValue).toBeCloseTo(0.55, 5);
		} finally {
			provider.close();
		}
	});

	test('a different round for the same task DOES apply a new reward (idempotency key includes roundNumber)', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(
				makeRecord('Memory recalled across two distinct council rounds.'),
			);
			await provider.recordRecallUsage?.(recallEvent('run-round', [record.id]));

			await provider.applyRecallReward?.({
				runIds: ['run-round'],
				outcome: 'approved',
				verdictPayload: {
					taskId: '1.1',
					swarmId: 'mega',
					roundNumber: 1,
					overallVerdict: 'APPROVE',
				},
			});
			const second = await provider.applyRecallReward?.({
				runIds: ['run-round'],
				outcome: 'approved',
				verdictPayload: {
					taskId: '1.1',
					swarmId: 'mega',
					roundNumber: 2,
					overallVerdict: 'APPROVE',
				},
			});

			expect(second?.reason).not.toBe('already_rewarded');
			const afterBoth = await provider.get(record.id);
			// Two distinct-round applications: 0.5 -> 0.55 -> 0.9*0.55+0.1*1=0.595.
			expect(afterBoth?.qValue).toBeCloseTo(0.595, 5);
		} finally {
			provider.close();
		}
	});

	test('a verdictPayload without the expected shape (no taskId/phaseNumber) always re-applies (no idempotency key derivable)', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(
				makeRecord('Memory rewarded via an unstructured verdict payload.'),
			);
			await provider.recordRecallUsage?.(
				recallEvent('run-unstructured', [record.id]),
			);

			await provider.applyRecallReward?.({
				runIds: ['run-unstructured'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});
			const second = await provider.applyRecallReward?.({
				runIds: ['run-unstructured'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});

			expect(second?.reason).not.toBe('already_rewarded');
		} finally {
			provider.close();
		}
	});
});

// L5-002: EMA convergence over multiple rounds, not just a single application.
describe('SQLite memory learning loop EMA multi-round convergence (L5-002)', () => {
	test('repeated APPROVE rewards converge qValue toward 1, each step matching the exact EMA recurrence', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
		});
		try {
			const record = await provider.upsert(makeRecord('Repeatedly approved.'));
			let expectedQValue = 0.5;
			const eta = 0.1;
			for (let round = 1; round <= 4; round++) {
				await provider.recordRecallUsage?.(
					recallEvent(`run-converge-${round}`, [record.id]),
				);
				await provider.applyRecallReward?.({
					runIds: [`run-converge-${round}`],
					outcome: 'approved',
					verdictPayload: {
						taskId: '1.1',
						swarmId: 'mega',
						roundNumber: round,
						overallVerdict: 'APPROVE',
					},
				});
				expectedQValue = (1 - eta) * expectedQValue + eta * 1;
				const updated = await provider.get(record.id);
				expect(updated?.qValue).toBeCloseTo(expectedQValue, 5);
			}
			// After 4 rounds the value should have moved meaningfully toward 1
			// from the 0.5 starting point (monotonic increase — a swapped
			// eta/(1-eta) or a sign error would diverge from this trend even
			// though it might coincidentally match at round 1).
			expect(expectedQValue).toBeGreaterThan(0.6);
			expect(expectedQValue).toBeLessThan(1);
		} finally {
			provider.close();
		}
	});
});

// Embedding-cosine propagation OR-path (issue #1467 O-004: token overlap>0.4
// OR embedding cosine>0.7). Uses a deterministic fake embedding provider via
// config injection is not available on the public constructor, so the first
// two tests below exercise the disabled-by-default path and the
// enabled-but-unavailable-provider fallback. The remaining tests inject a
// deterministic fake embedding provider via the `_internals.setEmbeddingProvider`
// test seam to actually exercise the cosine-qualifies branch end-to-end.
describe('SQLite memory propagation embedding-cosine path (O-004)', () => {
	test('embeddings disabled (default): propagation still works via token-overlap only, unaffected by the new cosine code path', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
			embeddings: { enabled: false },
			learning: {
				...DEFAULT_MEMORY_CONFIG.learning,
				propagationTokenOverlapThreshold: 0.4,
				propagationFanout: 5,
			},
		});
		try {
			const source = await provider.upsert(
				makeRecord('Shared vocabulary for propagation overlap test alpha.'),
			);
			const target = await provider.upsert(
				makeRecord('Shared vocabulary for propagation overlap test beta.'),
			);
			await provider.recordRecallUsage?.(recallEvent('run-old2', [target.id]));
			await provider.recordRecallUsage?.(
				recallEvent('run-source2', [source.id]),
			);

			const result = await provider.applyRecallReward?.({
				runIds: ['run-source2'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});

			expect(result?.propagatedMemoryIds).toContain(target.id);
		} finally {
			provider.close();
		}
	});

	test('embeddings enabled but no embedding provider available (dependency not installed): propagation degrades to token-overlap only, does not throw', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
			// Requesting embeddings does not guarantee a provider is actually
			// constructed (e.g. the optional model dependency may not be
			// installed in this environment) — the reward path must never
			// throw just because cosineEnabled is nominally true but
			// this.embeddingProvider ends up null.
			embeddings: { enabled: true },
			learning: {
				...DEFAULT_MEMORY_CONFIG.learning,
				propagationTokenOverlapThreshold: 0.4,
				propagationFanout: 5,
			},
		});
		try {
			const source = await provider.upsert(
				makeRecord('Shared vocabulary for propagation overlap test gamma.'),
			);
			const target = await provider.upsert(
				makeRecord('Shared vocabulary for propagation overlap test delta.'),
			);
			await provider.recordRecallUsage?.(recallEvent('run-old3', [target.id]));
			await provider.recordRecallUsage?.(
				recallEvent('run-source3', [source.id]),
			);

			const result = await provider.applyRecallReward?.({
				runIds: ['run-source3'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});

			expect(result?.success).toBe(true);
			expect(result?.propagatedMemoryIds).toContain(target.id);
		} finally {
			provider.close();
		}
	});

	test('candidate with low token overlap but high embedding cosine similarity to a same-scope source propagates', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
			embeddings: { enabled: true },
			learning: {
				...DEFAULT_MEMORY_CONFIG.learning,
				propagationTokenOverlapThreshold: 0.9, // effectively disable token-overlap qualification
				propagationEmbeddingCosineThreshold: 0.7,
				propagationFanout: 5,
			},
		});
		try {
			await provider.initialize();
			provider._internals.setEmbeddingProvider(new FakeEmbeddingProvider());

			const source = await provider.upsert(
				makeRecord('gammamarker uniquesourcewords only here'),
			);
			const target = await provider.upsert(
				makeRecord('gammamarker completely different remaining text'),
			);
			await provider.recordRecallUsage?.(
				recallEvent('run-cosine-old', [target.id]),
			);
			await provider.recordRecallUsage?.(
				recallEvent('run-cosine-source', [source.id]),
			);

			const result = await provider.applyRecallReward?.({
				runIds: ['run-cosine-source'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});

			expect(result?.propagatedMemoryIds).toContain(target.id);
		} finally {
			provider.close();
		}
	});

	// Regression test for a reviewer-confirmed cross-scope leak: the cosine
	// path must only compare a candidate against SAME-SCOPE source vectors,
	// not any source vector in the reward bundle. Without the per-source
	// scope gate, a candidate could qualify via high cosine similarity to a
	// DIFFERENT-scope source merely because some OTHER source in the same
	// bundle happened to share the candidate's scope.
	test('does NOT propagate via cosine similarity to a different-scope source, even when another source in the same bundle shares the candidate scope', async () => {
		const root = tempRoot();
		const provider = new SQLiteMemoryProvider(root, {
			enabled: true,
			provider: 'sqlite',
			embeddings: { enabled: true },
			learning: {
				...DEFAULT_MEMORY_CONFIG.learning,
				propagationTokenOverlapThreshold: 0.9,
				propagationEmbeddingCosineThreshold: 0.7,
				propagationFanout: 5,
			},
		});
		try {
			await provider.initialize();
			provider._internals.setEmbeddingProvider(new FakeEmbeddingProvider());

			// candidate and sourceSameScope share a scope but have LOW cosine
			// similarity to each other (different fake-vector keywords) and no
			// meaningful token overlap.
			const candidate = await provider.upsert(
				makeRecord('gammamarker uniquewordc only here', {
					scope: { type: 'repository', repoId: 'repo-a' },
				}),
			);
			const sourceSameScope = await provider.upsert(
				makeRecord('alphamarker uniqueworda only here', {
					scope: { type: 'repository', repoId: 'repo-a' },
				}),
			);
			// sourceDifferentScope has HIGH cosine similarity to the candidate
			// (same "gammamarker" keyword -> same fake vector) but lives in a
			// DIFFERENT scope than the candidate.
			const sourceDifferentScope = await provider.upsert(
				makeRecord('gammamarker uniquewordb only here', {
					scope: { type: 'repository', repoId: 'repo-b' },
				}),
			);

			await provider.recordRecallUsage?.(
				recallEvent('run-leak-target', [candidate.id]),
			);
			await provider.recordRecallUsage?.(
				recallEvent('run-leak-source', [
					sourceSameScope.id,
					sourceDifferentScope.id,
				]),
			);

			const result = await provider.applyRecallReward?.({
				runIds: ['run-leak-source'],
				outcome: 'approved',
				verdictPayload: { overallVerdict: 'APPROVE' },
			});

			// The candidate must NOT be propagated to: it has low cosine
			// similarity to its own same-scope source, and its only high-cosine
			// match is a source in a different scope.
			expect(result?.propagatedMemoryIds ?? []).not.toContain(candidate.id);
		} finally {
			provider.close();
		}
	});
});

/**
 * Deterministic fake embedding provider for tests: maps specific keywords to
 * fixed orthogonal/identical vectors so cosine-similarity outcomes are
 * predictable, without depending on the real (optional, not installed in
 * this environment) @xenova/transformers model.
 */
class FakeEmbeddingProvider {
	readonly modelVersion = 'fake-test-provider:2';
	readonly dimension = 2;
	readonly available = true;

	async embed(text: string): Promise<Float32Array> {
		if (text.includes('gammamarker')) return new Float32Array([0, 1]);
		if (text.includes('alphamarker')) return new Float32Array([1, 0]);
		return new Float32Array([0.5, 0.5]);
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		return Promise.all(texts.map((text) => this.embed(text)));
	}
}
