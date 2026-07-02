/**
 * B.5 — Soft Q-propagation: direct unit tests for the propagation pass of
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
 *   - No self / no double-update of a directly-rewarded memory (falsifiable).
 *   - One hop only (no recursive propagation).
 *   - Cross-source dedup: two distinct directly-rewarded sources that both
 *     reach the same target produce exactly ONE propagated event for it.
 *   - Never-retrieved candidate excluded (no recall-usage row at all).
 *   - Propagation-disabled config (fraction/cap/window each ≤ 0) propagates
 *     nothing while the direct reward is unaffected.
 *   - Inner-isolation: a mid-propagation-loop `upsert` throw never escapes
 *     `applyCouncilReward`; the direct reward and any propagated targets
 *     already applied before the throw persist (partial propagation is an
 *     accepted outcome — see the reward-capture.ts module header).
 *
 * Run against BOTH real providers (local-jsonl and sqlite): propagation is
 * provider-agnostic and only relies on list / listRecallUsage / upsert / get /
 * appendRewardEvent, which both providers implement.
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
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { DEFAULT_QLEARNING_CONFIG } from '../../../src/memory/config';
import { applyCouncilReward } from '../../../src/memory/reward-capture';

type ContractProvider = MemoryProvider & { close?: () => void };

interface ProviderCase {
	name: 'local-jsonl' | 'sqlite';
	create(root: string): ContractProvider;
}

const providerCases: ProviderCase[] = [
	{
		name: 'local-jsonl',
		create: (root) => new LocalJsonlMemoryProvider(root, { enabled: true }),
	},
	{
		name: 'sqlite',
		create: (root) =>
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
	},
];

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

// 20 base tokens shared by the "source" text; candidates share a controlled
// prefix of these to produce a KNOWN, orderable Jaccard overlap.
const BASE_TOKENS = Array.from({ length: 20 }, (_, i) => `base${i}`);

/** Text sharing the first `sharedCount` base tokens + `uniqueCount` unique. */
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

// Reward reference "now"; recall usage inside/outside the 30-day window.
const NOW = '2026-06-01T00:00:00.000Z';
const WITHIN_WINDOW = '2026-05-25T00:00:00.000Z'; // 7 days before NOW
const OUTSIDE_WINDOW = '2026-04-01T00:00:00.000Z'; // 61 days before NOW

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

describe('applyCouncilReward — B.5 soft Q-propagation', () => {
	for (const providerCase of providerCases) {
		describe(providerCase.name, () => {
			test('SC-005: a related, recently-retrieved memory shifts by the fraction; the direct memory shifts fully', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				// Direct source (all 20 base tokens) recalled for the rewarded unit.
				const direct = makeRecord(overlapText(20, 'src', 0));
				// Related: shares 19/20 base tokens → Jaccard 19/21 ≈ 0.905 ≥ 0.70.
				// Retrieved in an EARLIER session (not this reward's batch) but
				// within the window, so it is a propagation target, not a direct one.
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

				// memoriesRewarded counts DIRECT rewards only (contract unchanged).
				expect(result).toEqual({ memoriesRewarded: 1 });

				const directAfter = await provider.get(direct.id);
				const relatedAfter = await provider.get(related.id);
				expect(directAfter?.metadata.qValue).toBeCloseTo(DIRECT_Q, 10);
				expect(relatedAfter?.metadata.qValue).toBeCloseTo(PROPAGATED_Q, 10);

				// The related shift is EXACTLY the fraction of the direct shift.
				const directShift = DIRECT_Q - 0.5;
				const propagatedShift = (relatedAfter?.metadata.qValue as number) - 0.5;
				expect(propagatedShift).toBeCloseTo(
					DEFAULT_QLEARNING_CONFIG.propagationFraction * directShift,
					10,
				);

				// The propagated reward event is tagged distinctly from direct.
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
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const direct = makeRecord(overlapText(20, 'src', 0));
				// Same scope+kind text, high overlap, BUT different KIND → filtered
				// out by list(kinds) and the explicit kind re-check.
				const diffKind = makeRecord(overlapText(19, 'dk', 1), {
					kind: 'code_pattern',
				});
				// Same scope+kind, retrieved within window, but ZERO base-token
				// overlap → below the relatedness threshold.
				const lowOverlap = makeRecord(overlapText(0, 'low', 20));
				// High overlap + recent, but DIFFERENT scope (repo-b).
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
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const direct = makeRecord(overlapText(20, 'src', 0));
				// High overlap (0.905) but last retrieved 61 days ago → outside the
				// 30-day propagation window.
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
				const events = await provider.listRewardEvents?.({
					memoryId: stale.id,
				});
				expect(events).toEqual([]);
			});

			test('fan-out cap: with 3 qualifying candidates and cap=2, exactly the top-2-by-overlap are updated and the drop is logged', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const direct = makeRecord(overlapText(20, 'src', 0));
				// Overlaps: c1 19/21≈0.905, c2 18/22≈0.818, c3 17/23≈0.739 (all ≥0.70).
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
						qLearning: {
							...DEFAULT_QLEARNING_CONFIG,
							propagationFanoutCap: 2,
						},
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
					// no silent truncation — the cap-limited drop is surfaced.
					expect(capLogged).toBe(true);
				}

				// Top-2 by overlap (c1, c2) updated; c3 (lowest) dropped by cap.
				expect((await provider.get(c1.id))?.metadata.qValue).toBeCloseTo(
					PROPAGATED_Q,
					10,
				);
				expect((await provider.get(c2.id))?.metadata.qValue).toBeCloseTo(
					PROPAGATED_Q,
					10,
				);
				// Falsifiable: removing the cap would also update c3.
				expect((await provider.get(c3.id))?.metadata.qValue).toBeUndefined();
			});

			test('no self / no double-update: two directly-rewarded related memories each get exactly ONE direct step (no propagated second step)', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				// d1 and d2 are near-duplicates (overlap ≈ 0.818 ≥ 0.70) AND both are
				// directly rewarded (same session + unit). Neither may receive a
				// propagated step from the other.
				const d1 = makeRecord(overlapText(20, 'd1', 0));
				const d2 = makeRecord(overlapText(18, 'd2', 2));
				await provider.upsert(d1);
				await provider.upsert(d2);
				await provider.recordRecallUsage?.({
					bundleId: 'bundle-both',
					query: 'q',
					scopes: [d1.scope],
					memoryIds: [d1.id, d2.id],
					scores: [0.9, 0.8],
					tokenEstimate: 40,
					runId: 's1',
					unitId: 't1',
					timestamp: NOW,
				});

				const result = await applyCouncilReward(provider, {
					runId: 's1',
					unitId: 't1',
					reward: 1,
					eta: 0.1,
					initialQValue: 0.5,
					timestamp: NOW,
				});

				expect(result).toEqual({ memoriesRewarded: 2 });

				for (const rec of [d1, d2]) {
					const after = await provider.get(rec.id);
					// Exactly one direct EMA step — NOT a compounded second
					// (propagated) step (which would land ≈ 0.5635). Falsifiable
					// against removing the directly-rewarded exclusion.
					expect(after?.metadata.qValue).toBeCloseTo(DIRECT_Q, 10);
					expect(after?.metadata.qValue).not.toBeCloseTo(0.5635, 6);
					const events = await provider.listRewardEvents?.({
						memoryId: rec.id,
					});
					expect(events).toHaveLength(1);
					expect(events?.[0]?.verdict).toBe('APPROVE');
				}
			});

			test('one hop only: a memory related to a PROPAGATED target (but not to the direct source) is NOT updated', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				// A "bridge" construction so r2 is related to r1 but NOT to direct
				// (Jaccard 0.70 is high, so this needs r1 to be only moderately
				// similar to direct):
				//   direct = {a1..a10}
				//   r1     = {a1..a8}          → J(direct,r1) = 8/10  = 0.80  (≥0.70)
				//   r2     = {a1..a7, c1, c2}  → J(r1,r2)     = 7/10  = 0.70  (≥0.70)
				//                                J(direct,r2) = 7/12 ≈ 0.583 (<0.70)
				// So r2 is reachable ONLY through r1. One-hop propagation (source =
				// direct only) must leave r2 untouched; a recursive impl would not.
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

				// r1 is one hop from the direct source → updated.
				expect((await provider.get(r1.id))?.metadata.qValue).toBeCloseTo(
					PROPAGATED_Q,
					10,
				);
				// r2 is only reachable THROUGH r1 (overlap with direct < 0.70).
				// One-hop propagation must NOT touch it.
				expect((await provider.get(r2.id))?.metadata.qValue).toBeUndefined();
				const r2Events = await provider.listRewardEvents?.({
					memoryId: r2.id,
				});
				expect(r2Events).toEqual([]);
			});

			test('cross-source dedup: two distinct directly-rewarded sources that both reach the same target produce exactly ONE propagated event', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				// d1 and d2 are BOTH directly rewarded this session/unit. Target
				// shares high overlap with BOTH (reachable from two sources).
				const d1 = makeRecord(overlapText(20, 'd1', 0));
				const d2 = makeRecord(overlapText(19, 'd2', 1));
				const target = makeRecord(overlapText(18, 'tg', 2));
				for (const rec of [d1, d2, target]) await provider.upsert(rec);
				await provider.recordRecallUsage?.({
					bundleId: 'bundle-both-direct',
					query: 'q',
					scopes: [d1.scope],
					memoryIds: [d1.id, d2.id],
					scores: [0.9, 0.8],
					tokenEstimate: 40,
					runId: 's1',
					unitId: 't1',
					timestamp: NOW,
				});
				await recordUsage(provider, target, 's0', WITHIN_WINDOW);

				const result = await applyCouncilReward(provider, {
					runId: 's1',
					unitId: 't1',
					reward: 1,
					eta: 0.1,
					initialQValue: 0.5,
					timestamp: NOW,
				});

				// Both sources were directly rewarded.
				expect(result).toEqual({ memoriesRewarded: 2 });

				// Exactly ONE propagated step landed on the shared target — a
				// broken implementation without cross-source dedup would apply
				// the propagated step TWICE (compounding past PROPAGATED_Q).
				const targetAfter = await provider.get(target.id);
				expect(targetAfter?.metadata.qValue).toBeCloseTo(PROPAGATED_Q, 10);
				const targetEvents = await provider.listRewardEvents?.({
					memoryId: target.id,
				});
				expect(targetEvents).toHaveLength(1);
				expect(targetEvents?.[0]?.verdict).toBe('APPROVE_PROPAGATED');
			});

			test('never-retrieved candidate excluded: a high-overlap memory with NO recall-usage row is not a propagation target', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const direct = makeRecord(overlapText(20, 'src', 0));
				// High overlap (0.905) but NEVER recorded via recordRecallUsage —
				// absent from the retrieval-recency map entirely.
				const neverRetrieved = makeRecord(overlapText(19, 'nr', 1));
				await provider.upsert(direct);
				await provider.upsert(neverRetrieved);
				await recordUsage(provider, direct, 's1', NOW, 't1');

				await applyCouncilReward(provider, {
					runId: 's1',
					unitId: 't1',
					reward: 1,
					eta: 0.1,
					initialQValue: 0.5,
					timestamp: NOW,
				});

				const after = await provider.get(neverRetrieved.id);
				expect(after?.metadata.qValue).toBeUndefined();
				const events = await provider.listRewardEvents?.({
					memoryId: neverRetrieved.id,
				});
				expect(events).toEqual([]);
			});

			test('propagation-disabled config (fraction/cap/window each ≤ 0) propagates nothing while the direct reward is unaffected', async () => {
				const disablingOverrides: Array<
					[string, Partial<typeof DEFAULT_QLEARNING_CONFIG>]
				> = [
					['fraction', { propagationFraction: 0 }],
					['fanoutCap', { propagationFanoutCap: 0 }],
					['windowDays', { propagationWindowDays: 0 }],
				];
				for (const [label, override] of disablingOverrides) {
					const root = await providerRoot(
						`${providerCase.name}-disabled-${label}`,
					);
					const provider = track(providerCase.create(root));
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
						qLearning: { ...DEFAULT_QLEARNING_CONFIG, ...override },
						timestamp: NOW,
					});

					// The direct reward is unaffected by a disabled propagation knob.
					expect(result).toEqual({ memoriesRewarded: 1 });
					expect((await provider.get(direct.id))?.metadata.qValue).toBeCloseTo(
						DIRECT_Q,
						10,
					);
					// Nothing propagated.
					expect(
						(await provider.get(related.id))?.metadata.qValue,
					).toBeUndefined();
					const relatedEvents = await provider.listRewardEvents?.({
						memoryId: related.id,
					});
					expect(relatedEvents).toEqual([]);
				}
			});

			test('inner-isolation: a mid-propagation-loop upsert throw never escapes applyCouncilReward; the direct reward and earlier-applied propagated targets persist (partial propagation is an accepted outcome)', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const direct = makeRecord(overlapText(20, 'src', 0));
				// rel1 has the HIGHEST overlap (0.905) so it is propagated FIRST
				// (deterministic top-by-overlap ordering); rel2 (0.818) is SECOND.
				const rel1 = makeRecord(overlapText(19, 'r1', 1));
				const rel2 = makeRecord(overlapText(18, 'r2', 2));
				for (const rec of [direct, rel1, rel2]) await provider.upsert(rec);
				await recordUsage(provider, direct, 's1', NOW, 't1');
				await recordUsage(provider, rel1, 's0', WITHIN_WINDOW);
				await recordUsage(provider, rel2, 's0', WITHIN_WINDOW);

				const originalUpsert = provider.upsert.bind(provider);
				let upsertCalls = 0;
				provider.upsert = (async (record: MemoryRecord) => {
					upsertCalls++;
					// Call 1 = the direct reward's upsert; call 2 = rel1's propagated
					// upsert (highest overlap, applied first); call 3 = rel2's
					// propagated upsert — THIS call throws, simulating a mid-loop
					// provider failure strictly AFTER rel1 already persisted.
					if (upsertCalls === 3) {
						throw new Error('propagation upsert boom');
					}
					return originalUpsert(record);
				}) as typeof provider.upsert;

				let thrown: unknown;
				let result: Awaited<ReturnType<typeof applyCouncilReward>> | undefined;
				try {
					result = await applyCouncilReward(provider, {
						runId: 's1',
						unitId: 't1',
						reward: 1,
						eta: 0.1,
						initialQValue: 0.5,
						timestamp: NOW,
					});
				} catch (err) {
					thrown = err;
				}

				// The propagation-time throw is caught by propagateReward's own
				// best-effort guard — it NEVER escapes applyCouncilReward.
				expect(thrown).toBeUndefined();
				// The direct reward and its count are entirely unaffected — it was
				// persisted and counted BEFORE propagation ran at all.
				expect(result).toEqual({ memoriesRewarded: 1 });
				expect((await provider.get(direct.id))?.metadata.qValue).toBeCloseTo(
					DIRECT_Q,
					10,
				);
				// Partial propagation IS the accepted outcome: rel1's step, applied
				// BEFORE the throw, persists...
				expect((await provider.get(rel1.id))?.metadata.qValue).toBeCloseTo(
					PROPAGATED_Q,
					10,
				);
				// ...but rel2, whose upsert threw, is untouched.
				expect((await provider.get(rel2.id))?.metadata.qValue).toBeUndefined();
			});
		});
	}
});
