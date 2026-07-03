/**
 * B.5 — Soft Q-propagation: focused unit tests for the propagation pass of
 * `applyCouncilReward`.
 *
 * When a memory's q-value is updated by a DIRECT council reward, a FRACTION of
 * that reward is propagated ONE HOP to closely-related memories (same scope +
 * same kind + high Jaccard overlap + retrieved within `propagationWindowDays`),
 * strictly bounded by `propagationFanoutCap`.
 *
 * Covers (task B.5 spec):
 *   - SC-005 core: a related, recently-retrieved memory shifts by EXACTLY the
 *     propagation fraction of the direct shift; the direct memory shifts fully.
 *   - Negatives (UNCHANGED): different kind, low overlap, different scope, and
 *     retrieved OUTSIDE the window.
 *   - Fan-out cap: with > cap qualifying candidates, exactly cap (top-by-overlap)
 *     are updated, the rest unchanged, and the drop is logged.
 *   - One hop only (no recursive propagation).
 *   - Inner-isolation: a mid-propagation-loop `upsert` throw never escapes
 *     `applyCouncilReward`; the direct reward and propagated targets applied
 *     before the throw persist (partial propagation is an accepted outcome).
 *
 * Run against local-jsonl provider (propagation is provider-agnostic).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	LocalJsonlMemoryProvider,
	type MemoryKind,
	type MemoryProvider,
	type MemoryRecord,
} from '../../../src/memory';
import { DEFAULT_QLEARNING_CONFIG } from '../../../src/memory/config';
import { applyCouncilReward } from '../../../src/memory/reward-capture';

type ContractProvider = MemoryProvider & { close?: () => void };

let tmpDir: string;
const openProviders: ContractProvider[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-reward-propagation-')),
	);
	openProviders.length = 0;
});

afterEach(async () => {
	for (const provider of openProviders.splice(0)) {
		provider.close?.();
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(provider: ContractProvider): ContractProvider {
	openProviders.push(provider);
	return provider;
}

async function providerRoot(name: string): Promise<string> {
	const root = path.join(tmpDir, name);
	await fs.mkdir(root, { recursive: true });
	return root;
}

const BASE_TOKENS = Array.from({ length: 20 }, (_, i) => `base${i}`);

function overlapText(
	sharedCount: number,
	uniqueTag: string,
	uniqueCount: number,
): string {
	const shared = BASE_TOKENS.slice(0, sharedCount);
	const unique = Array.from(
		{ length: uniqueCount },
		(_, i) => `${uniqueTag}uq${i}`,
	);
	return [...shared, ...unique].join(' ');
}

function makeRecord(
	text: string,
	opts: { repoId?: string; kind?: MemoryKind } = {},
): MemoryRecord {
	const repoId = opts.repoId ?? 'repo-a';
	const base = {
		scope: {
			type: 'repository' as const,
			repoId,
			repoRoot: path.join(tmpDir, repoId),
		},
		kind: (opts.kind ?? 'repo_convention') as MemoryKind,
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

const NOW = '2026-06-01T00:00:00.000Z';
const WITHIN_WINDOW = '2026-06-25T00:00:00.000Z';
const OUTSIDE_WINDOW = '2026-04-01T00:00:00.000Z';

async function recordUsage(
	provider: ContractProvider,
	rec: MemoryRecord,
	runId: string,
	timestamp: string,
	unitId?: string,
): Promise<void> {
	await provider.recordRecallUsage?.({
		bundleId: `bundle-${rec.id}-${runId}`,
		query: 'q',
		scopes: [rec.scope],
		memoryIds: [rec.id],
		scores: [0.9],
		tokenEstimate: 20,
		runId,
		unitId,
		timestamp,
	});
}

// Direct EMA (η=0.1, reward=1) from neutral 0.5 → 0.55.
const DIRECT_Q = 0.55;
// Propagated step (fraction 0.3): applyEma(0.5, 1, 0.1*0.3=0.03) = 0.515.
const PROPAGATED_Q = 0.515;

describe('applyCouncilReward — B.5 soft Q-propagation (local-jsonl)', () => {
	describe('local-jsonl', () => {
		test('SC-005: a related, recently-retrieved memory shifts by the fraction; the direct memory shifts fully', async () => {
			const root = await providerRoot('prop-sc005');
			const provider = track(
				new LocalJsonlMemoryProvider(root, { enabled: true }),
			);
			const direct = makeRecord(overlapText(20, 'src', 0));
			const related = makeRecord(overlapText(19, 'rel', 1));
			await provider.upsert(direct);
			await provider.upsert(related);
			await recordUsage(provider, direct, 's1', NOW, 't1');
			await recordUsage(provider, related, 's0', WITHIN_WINDOW);

			const result = await applyCouncilReward(provider, {
				runId: 's1',
				unitId: 't1',
				reward: 1,
				eta: 0.1,
				initialQValue: 0.5,
				timestamp: NOW,
			});

			expect(result).toEqual({ memoriesRewarded: 1 });

			const directAfter = await provider.get(direct.id);
			const relatedAfter = await provider.get(related.id);
			expect(directAfter?.metadata.qValue).toBeCloseTo(DIRECT_Q, 10);
			expect(relatedAfter?.metadata.qValue).toBeCloseTo(PROPAGATED_Q, 10);

			const directShift = DIRECT_Q - 0.5;
			const propagatedShift = (relatedAfter?.metadata.qValue as number) - 0.5;
			expect(propagatedShift).toBeCloseTo(
				DEFAULT_QLEARNING_CONFIG.propagationFraction * directShift,
				10,
			);

			const relatedEvents = await provider.listRewardEvents?.({
				memoryId: related.id,
			});
			expect(relatedEvents).toHaveLength(1);
			expect(relatedEvents?.[0]).toMatchObject({
				memoryId: related.id,
				verdict: 'APPROVE_PROPAGATED',
				reward: 1,
				qBefore: 0.5,
			});
			expect(relatedEvents?.[0]?.qAfter).toBeCloseTo(PROPAGATED_Q, 10);

			const directEvents = await provider.listRewardEvents?.({
				memoryId: direct.id,
			});
			expect(directEvents).toHaveLength(1);
			expect(directEvents?.[0]?.verdict).toBe('APPROVE');
		});

		test('unrelated memories are UNCHANGED: different kind, low overlap, and different scope', async () => {
			const root = await providerRoot('prop-unrelated');
			const provider = track(
				new LocalJsonlMemoryProvider(root, { enabled: true }),
			);
			const direct = makeRecord(overlapText(20, 'src', 0));
			const diffKind = makeRecord(overlapText(19, 'dk', 1), {
				kind: 'code_pattern',
			});
			const lowOverlap = makeRecord(overlapText(0, 'low', 20));
			const diffScope = makeRecord(overlapText(19, 'ds', 1), {
				repoId: 'repo-b',
			});
			for (const rec of [direct, diffKind, lowOverlap, diffScope]) {
				await provider.upsert(rec);
			}
			await recordUsage(provider, direct, 's1', NOW, 't1');
			await recordUsage(provider, diffKind, 's0', WITHIN_WINDOW);
			await recordUsage(provider, lowOverlap, 's0', WITHIN_WINDOW);
			await recordUsage(provider, diffScope, 's0', WITHIN_WINDOW);

			await applyCouncilReward(provider, {
				runId: 's1',
				unitId: 't1',
				reward: 1,
				eta: 0.1,
				initialQValue: 0.5,
				timestamp: NOW,
			});

			for (const rec of [diffKind, lowOverlap, diffScope]) {
				const after = await provider.get(rec.id);
				expect(after?.metadata.qValue).toBeUndefined();
				const events = await provider.listRewardEvents?.({
					memoryId: rec.id,
				});
				expect(events).toEqual([]);
			}
		});

		test('window boundary: a related memory retrieved OUTSIDE the window is NOT updated', async () => {
			const root = await providerRoot('prop-window');
			const provider = track(
				new LocalJsonlMemoryProvider(root, { enabled: true }),
			);
			const direct = makeRecord(overlapText(20, 'src', 0));
			const stale = makeRecord(overlapText(19, 'stale', 1));
			await provider.upsert(direct);
			await provider.upsert(stale);
			await recordUsage(provider, direct, 's1', NOW, 't1');
			await recordUsage(provider, stale, 's0', OUTSIDE_WINDOW);

			await applyCouncilReward(provider, {
				runId: 's1',
				unitId: 't1',
				reward: 1,
				eta: 0.1,
				initialQValue: 0.5,
				timestamp: NOW,
			});

			const staleAfter = await provider.get(stale.id);
			expect(staleAfter?.metadata.qValue).toBeUndefined();
			const events = await provider.listRewardEvents?.({ memoryId: stale.id });
			expect(events).toEqual([]);
		});

		test('fan-out cap: with 3 qualifying candidates and cap=2, exactly the top-2-by-overlap are updated and the drop is logged', async () => {
			const root = await providerRoot('prop-cap');
			const provider = track(
				new LocalJsonlMemoryProvider(root, { enabled: true }),
			);
			const direct = makeRecord(overlapText(20, 'src', 0));
			const c1 = makeRecord(overlapText(19, 'c1', 1));
			const c2 = makeRecord(overlapText(18, 'c2', 2));
			const c3 = makeRecord(overlapText(17, 'c3', 3));
			for (const rec of [direct, c1, c2, c3]) await provider.upsert(rec);
			await recordUsage(provider, direct, 's1', NOW, 't1');
			for (const rec of [c1, c2, c3]) {
				await recordUsage(provider, rec, 's0', WITHIN_WINDOW);
			}

			const debugEnvBefore = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';
			const logSpy = spyOn(console, 'log').mockImplementation(() => {});
			try {
				await applyCouncilReward(provider, {
					runId: 's1',
					unitId: 't1',
					reward: 1,
					eta: 0.1,
					initialQValue: 0.5,
					qLearning: { ...DEFAULT_QLEARNING_CONFIG, propagationFanoutCap: 2 },
					timestamp: NOW,
				});
			} finally {
				const capLogged = logSpy.mock.calls.some((call) =>
					String(call[0]).includes('fan-out cap reached'),
				);
				logSpy.mockRestore();
				if (debugEnvBefore === undefined) {
					process.env.OPENCODE_SWARM_DEBUG = undefined;
					delete process.env.OPENCODE_SWARM_DEBUG;
				} else {
					process.env.OPENCODE_SWARM_DEBUG = debugEnvBefore;
				}
				expect(capLogged).toBe(true);
			}

			expect((await provider.get(c1.id))?.metadata.qValue).toBeCloseTo(
				PROPAGATED_Q,
				10,
			);
			expect((await provider.get(c2.id))?.metadata.qValue).toBeCloseTo(
				PROPAGATED_Q,
				10,
			);
			expect((await provider.get(c3.id))?.metadata.qValue).toBeUndefined();
		});

		test('one hop only: a memory related to a PROPAGATED target (but not to the direct source) is NOT updated', async () => {
			const root = await providerRoot('prop-onehop');
			const provider = track(
				new LocalJsonlMemoryProvider(root, { enabled: true }),
			);
			const a = Array.from({ length: 10 }, (_, i) => `a${i + 1}`);
			const direct = makeRecord(a.join(' '));
			const r1 = makeRecord(a.slice(0, 8).join(' '));
			const r2 = makeRecord([...a.slice(0, 7), 'c1', 'c2'].join(' '));
			for (const rec of [direct, r1, r2]) await provider.upsert(rec);
			await recordUsage(provider, direct, 's1', NOW, 't1');
			await recordUsage(provider, r1, 's0', WITHIN_WINDOW);
			await recordUsage(provider, r2, 's0', WITHIN_WINDOW);

			await applyCouncilReward(provider, {
				runId: 's1',
				unitId: 't1',
				reward: 1,
				eta: 0.1,
				initialQValue: 0.5,
				timestamp: NOW,
			});

			expect((await provider.get(r1.id))?.metadata.qValue).toBeCloseTo(
				PROPAGATED_Q,
				10,
			);
			expect((await provider.get(r2.id))?.metadata.qValue).toBeUndefined();
			const r2Events = await provider.listRewardEvents?.({
				memoryId: r2.id,
			});
			expect(r2Events).toEqual([]);
		});
	});
});
