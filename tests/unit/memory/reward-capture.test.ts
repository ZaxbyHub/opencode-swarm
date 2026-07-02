/**
 * A.4/B.2 — Council reward capture: direct unit tests for
 * `applyCouncilReward`.
 *
 * Covers (see task A.4 spec):
 *   1. Upward EMA reward on all distinct recalled memories of a session.
 *   2. Distinct-id dedup: a memory recalled in TWO bundles of the same runId
 *      gets exactly ONE EMA step (not one step per bundle appearance).
 *   3. Empty session (no recall usage) → { memoriesRewarded: 0 }, no throw.
 *   4. A recall bundle referencing a memory id that no longer exists is
 *      skipped without throwing; other valid ids are still rewarded.
 *   5. Upsert-in-place: reward never creates a new memory id/row.
 *
 * B.2 (SC-014) — unitId-narrowed attribution with run_id fallback:
 *   6. Two tagged bundles (unitId 'A' vs 'B') in the same session — only the
 *      matching unit's memories are rewarded; sibling-task memories are
 *      untouched.
 *   7. An untagged bundle (unitId undefined) in the same session as a
 *      matching tagged bundle IS rewarded (run_id fallback preserves signal
 *      for unattributable bundles).
 *   8. A null/undefined verdict unitId degrades to full session-scoped
 *      reward (today's pre-B.2 behavior) — all bundles rewarded regardless
 *      of tagging.
 *   9. Dedup holds across a matching-tagged bundle and an untagged bundle:
 *      a memory id present in both is rewarded exactly once.
 *
 * Run against BOTH real providers (local-jsonl and sqlite) — this module is
 * provider-agnostic and both providers implement listRecallUsage/upsert/get/
 * appendRewardEvent/listRewardEvents per the MemoryProvider contract
 * (tests/unit/memory/provider-contract.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	LocalJsonlMemoryProvider,
	type MemoryProvider,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
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
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-reward-capture-')),
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

function makeRecord(text: string, repoId = 'repo-a'): MemoryRecord {
	const base = {
		scope: {
			type: 'repository' as const,
			repoId,
			repoRoot: path.join(tmpDir, repoId),
		},
		kind: 'repo_convention' as const,
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

const TIMESTAMP = '2026-06-01T00:00:00.000Z';

describe('applyCouncilReward', () => {
	for (const providerCase of providerCases) {
		describe(providerCase.name, () => {
			test('rewards every distinct recalled memory with one EMA step and appends a matching reward event', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const mem1 = makeRecord('Repo convention #1.');
				const mem2 = makeRecord('Repo convention #2.');
				await provider.upsert(mem1);
				await provider.upsert(mem2);

				await provider.recordRecallUsage?.({
					bundleId: 'bundle-1',
					query: 'q',
					scopes: [mem1.scope],
					memoryIds: [mem1.id, mem2.id],
					scores: [0.8, 0.7],
					tokenEstimate: 50,
					runId: 's1',
					timestamp: TIMESTAMP,
				});

				const result = await applyCouncilReward(provider, {
					runId: 's1',
					unitId: 't1',
					reward: 1,
					eta: 0.1,
					initialQValue: 0.5,
					timestamp: TIMESTAMP,
				});

				expect(result).toEqual({ memoriesRewarded: 2 });

				const rec1After = await provider.get(mem1.id);
				const rec2After = await provider.get(mem2.id);
				// (1-0.1)*0.5 + 0.1*1 = 0.55 exactly.
				expect(rec1After?.metadata.qValue).toBeCloseTo(0.55, 10);
				expect(rec2After?.metadata.qValue).toBeCloseTo(0.55, 10);

				const events1 = await provider.listRewardEvents?.({
					memoryId: mem1.id,
				});
				expect(events1).toHaveLength(1);
				expect(events1?.[0]).toMatchObject({
					memoryId: mem1.id,
					unitId: 't1',
					verdict: 'APPROVE',
					reward: 1,
					qBefore: 0.5,
					qAfter: 0.55,
				});
			});

			test('distinct-id dedup: a memory recalled in TWO bundles of the same runId gets exactly ONE EMA step', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const mem = makeRecord('Recalled twice this session.');
				await provider.upsert(mem);

				await provider.recordRecallUsage?.({
					bundleId: 'bundle-1',
					query: 'q1',
					scopes: [mem.scope],
					memoryIds: [mem.id],
					scores: [0.9],
					tokenEstimate: 20,
					runId: 's-dedup',
					timestamp: TIMESTAMP,
				});
				await provider.recordRecallUsage?.({
					bundleId: 'bundle-2',
					query: 'q2',
					scopes: [mem.scope],
					memoryIds: [mem.id],
					scores: [0.6],
					tokenEstimate: 20,
					runId: 's-dedup',
					timestamp: '2026-06-01T00:00:01.000Z',
				});

				const result = await applyCouncilReward(provider, {
					runId: 's-dedup',
					unitId: 't-dedup',
					reward: 1,
					eta: 0.1,
					initialQValue: 0.5,
					timestamp: TIMESTAMP,
				});

				// A broken implementation that rewards once PER BUNDLE APPEARANCE
				// (rather than per distinct id) would report memoriesRewarded: 2
				// and drive q to two compounded EMA steps:
				//   step1: 0.5 -> 0.55; step2: 0.55 -> 0.595 (NOT 0.55).
				expect(result).toEqual({ memoriesRewarded: 1 });

				const recAfter = await provider.get(mem.id);
				expect(recAfter?.metadata.qValue).toBeCloseTo(0.55, 10);
				// Falsifiable against the compounded-step bug: 0.595 !== 0.55.
				expect(recAfter?.metadata.qValue).not.toBeCloseTo(0.595, 6);

				const events = await provider.listRewardEvents?.({
					memoryId: mem.id,
				});
				expect(events).toHaveLength(1);
			});

			test('empty session (no recall usage for runId) returns zero rewarded and does not throw', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));

				const result = await applyCouncilReward(provider, {
					runId: 'no-such-session',
					unitId: 't-empty',
					reward: 1,
					eta: 0.1,
					initialQValue: 0.5,
					timestamp: TIMESTAMP,
				});

				expect(result).toEqual({ memoriesRewarded: 0 });
				const events = await provider.listRewardEvents?.({});
				expect(events).toEqual([]);
			});

			test('a recall bundle referencing a memory id that no longer exists is skipped without throwing; valid ids are still rewarded', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const survivor = makeRecord('This memory still exists.');
				await provider.upsert(survivor);

				await provider.recordRecallUsage?.({
					bundleId: 'bundle-missing',
					query: 'q',
					scopes: [survivor.scope],
					// 'mem_does_not_exist' was never upserted (or was deleted+purged
					// out-of-band) — provider.get() must return null for it.
					memoryIds: ['mem_does_not_exist', survivor.id],
					scores: [0.5, 0.9],
					tokenEstimate: 30,
					runId: 's-missing',
					timestamp: TIMESTAMP,
				});

				let thrown: unknown;
				let result: Awaited<ReturnType<typeof applyCouncilReward>> | undefined;
				try {
					result = await applyCouncilReward(provider, {
						runId: 's-missing',
						unitId: 't-missing',
						reward: 1,
						eta: 0.1,
						initialQValue: 0.5,
						timestamp: TIMESTAMP,
					});
				} catch (err) {
					thrown = err;
				}

				expect(thrown).toBeUndefined();
				// Only the surviving id counts — the missing id must not be counted
				// or crash the loop for the ids that come after/before it.
				expect(result).toEqual({ memoriesRewarded: 1 });

				const survivorAfter = await provider.get(survivor.id);
				expect(survivorAfter?.metadata.qValue).toBeCloseTo(0.55, 10);

				const missingEvents = await provider.listRewardEvents?.({
					memoryId: 'mem_does_not_exist',
				});
				expect(missingEvents).toEqual([]);
			});

			test('upsert-in-place: the record id is unchanged after reward, only qValue differs', async () => {
				const root = await providerRoot(providerCase.name);
				const provider = track(providerCase.create(root));
				const mem = makeRecord('Record identity must survive reward.');
				await provider.upsert(mem);

				await provider.recordRecallUsage?.({
					bundleId: 'bundle-identity',
					query: 'q',
					scopes: [mem.scope],
					memoryIds: [mem.id],
					scores: [0.9],
					tokenEstimate: 20,
					runId: 's-identity',
					timestamp: TIMESTAMP,
				});

				await applyCouncilReward(provider, {
					runId: 's-identity',
					unitId: 't-identity',
					reward: 1,
					eta: 0.1,
					initialQValue: 0.5,
					timestamp: TIMESTAMP,
				});

				const after = await provider.get(mem.id);
				expect(after?.id).toBe(mem.id);
				expect(after?.text).toBe(mem.text);
				expect(after?.contentHash).toBe(mem.contentHash);
				// No duplicate row was created for the same scope/kind — list()
				// still returns exactly one record.
				const all = await provider.list({});
				expect(all).toHaveLength(1);
				expect(all[0]?.id).toBe(mem.id);
				expect(after?.metadata.qValue).toBeCloseTo(0.55, 10);
			});

			describe('B.2 — unitId-narrowed attribution (SC-014)', () => {
				test('sibling-task bundles in the same session are NOT rewarded: only the matching unitId is rewarded', async () => {
					const root = await providerRoot(providerCase.name);
					const provider = track(providerCase.create(root));
					const memA = makeRecord('Recalled by task A.');
					const memB = makeRecord('Recalled by task B.');
					await provider.upsert(memA);
					await provider.upsert(memB);

					await provider.recordRecallUsage?.({
						bundleId: 'bundle-a',
						query: 'qa',
						scopes: [memA.scope],
						memoryIds: [memA.id],
						scores: [0.9],
						tokenEstimate: 20,
						runId: 's-siblings',
						unitId: 'A',
						timestamp: TIMESTAMP,
					});
					await provider.recordRecallUsage?.({
						bundleId: 'bundle-b',
						query: 'qb',
						scopes: [memB.scope],
						memoryIds: [memB.id],
						scores: [0.8],
						tokenEstimate: 20,
						runId: 's-siblings',
						unitId: 'B',
						timestamp: TIMESTAMP,
					});

					const result = await applyCouncilReward(provider, {
						runId: 's-siblings',
						unitId: 'A',
						reward: 1,
						eta: 0.1,
						initialQValue: 0.5,
						timestamp: TIMESTAMP,
					});

					// Falsifiability: if the filter were inverted or dropped, this
					// would report 2 (or reward memB) instead of exactly 1 (memA).
					expect(result).toEqual({ memoriesRewarded: 1 });

					const memAAfter = await provider.get(memA.id);
					const memBAfter = await provider.get(memB.id);
					expect(memAAfter?.metadata.qValue).toBeCloseTo(0.55, 10);
					// Sibling task's memory must be untouched — no qValue set at all.
					expect(memBAfter?.metadata.qValue).toBeUndefined();

					const eventsB = await provider.listRewardEvents?.({
						memoryId: memB.id,
					});
					expect(eventsB).toEqual([]);
				});

				test('run_id fallback: an untagged bundle is rewarded alongside the matching tagged bundle', async () => {
					const root = await providerRoot(providerCase.name);
					const provider = track(providerCase.create(root));
					const memA = makeRecord('Recalled by task A.');
					const memUntagged = makeRecord('Recalled with no unitId.');
					await provider.upsert(memA);
					await provider.upsert(memUntagged);

					await provider.recordRecallUsage?.({
						bundleId: 'bundle-a',
						query: 'qa',
						scopes: [memA.scope],
						memoryIds: [memA.id],
						scores: [0.9],
						tokenEstimate: 20,
						runId: 's-fallback',
						unitId: 'A',
						timestamp: TIMESTAMP,
					});
					await provider.recordRecallUsage?.({
						bundleId: 'bundle-untagged',
						query: 'qu',
						scopes: [memUntagged.scope],
						memoryIds: [memUntagged.id],
						scores: [0.7],
						tokenEstimate: 20,
						runId: 's-fallback',
						// unitId intentionally omitted — legacy/unattributable bundle.
						timestamp: TIMESTAMP,
					});

					const result = await applyCouncilReward(provider, {
						runId: 's-fallback',
						unitId: 'A',
						reward: 1,
						eta: 0.1,
						initialQValue: 0.5,
						timestamp: TIMESTAMP,
					});

					expect(result).toEqual({ memoriesRewarded: 2 });

					const memAAfter = await provider.get(memA.id);
					const memUntaggedAfter = await provider.get(memUntagged.id);
					expect(memAAfter?.metadata.qValue).toBeCloseTo(0.55, 10);
					expect(memUntaggedAfter?.metadata.qValue).toBeCloseTo(0.55, 10);
				});

				test('null verdict unitId degrades to full session-scoped reward (rewards all bundles regardless of tagging)', async () => {
					const root = await providerRoot(providerCase.name);
					const provider = track(providerCase.create(root));
					const memA = makeRecord('Recalled by task A.');
					const memB = makeRecord('Recalled by task B.');
					await provider.upsert(memA);
					await provider.upsert(memB);

					await provider.recordRecallUsage?.({
						bundleId: 'bundle-a',
						query: 'qa',
						scopes: [memA.scope],
						memoryIds: [memA.id],
						scores: [0.9],
						tokenEstimate: 20,
						runId: 's-no-unit',
						unitId: 'A',
						timestamp: TIMESTAMP,
					});
					await provider.recordRecallUsage?.({
						bundleId: 'bundle-b',
						query: 'qb',
						scopes: [memB.scope],
						memoryIds: [memB.id],
						scores: [0.8],
						tokenEstimate: 20,
						runId: 's-no-unit',
						unitId: 'B',
						timestamp: TIMESTAMP,
					});

					const result = await applyCouncilReward(provider, {
						runId: 's-no-unit',
						unitId: undefined,
						reward: 1,
						eta: 0.1,
						initialQValue: 0.5,
						timestamp: TIMESTAMP,
					});

					expect(result).toEqual({ memoriesRewarded: 2 });

					const memAAfter = await provider.get(memA.id);
					const memBAfter = await provider.get(memB.id);
					expect(memAAfter?.metadata.qValue).toBeCloseTo(0.55, 10);
					expect(memBAfter?.metadata.qValue).toBeCloseTo(0.55, 10);
				});

				test('dedup across kept bundles: a memory id in both a matching-tagged bundle and an untagged bundle is rewarded exactly once', async () => {
					const root = await providerRoot(providerCase.name);
					const provider = track(providerCase.create(root));
					const shared = makeRecord(
						'Recalled in both a tagged and untagged bundle.',
					);
					await provider.upsert(shared);

					await provider.recordRecallUsage?.({
						bundleId: 'bundle-tagged',
						query: 'qa',
						scopes: [shared.scope],
						memoryIds: [shared.id],
						scores: [0.9],
						tokenEstimate: 20,
						runId: 's-dedup-attr',
						unitId: 'A',
						timestamp: TIMESTAMP,
					});
					await provider.recordRecallUsage?.({
						bundleId: 'bundle-untagged',
						query: 'qu',
						scopes: [shared.scope],
						memoryIds: [shared.id],
						scores: [0.6],
						tokenEstimate: 20,
						runId: 's-dedup-attr',
						timestamp: '2026-06-01T00:00:01.000Z',
					});

					const result = await applyCouncilReward(provider, {
						runId: 's-dedup-attr',
						unitId: 'A',
						reward: 1,
						eta: 0.1,
						initialQValue: 0.5,
						timestamp: TIMESTAMP,
					});

					// A broken implementation that failed to dedup across kept
					// bundles would report memoriesRewarded: 2 and compound the
					// EMA step to 0.595 instead of a single step to 0.55.
					expect(result).toEqual({ memoriesRewarded: 1 });

					const sharedAfter = await provider.get(shared.id);
					expect(sharedAfter?.metadata.qValue).toBeCloseTo(0.55, 10);
					expect(sharedAfter?.metadata.qValue).not.toBeCloseTo(0.595, 6);

					const events = await provider.listRewardEvents?.({
						memoryId: shared.id,
					});
					expect(events).toHaveLength(1);
				});
			});
		});
	}
});
