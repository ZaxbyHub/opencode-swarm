import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createMemoryGateway,
	LocalJsonlMemoryProvider,
	type MemoryProvider,
	SQLiteMemoryProvider,
} from '../../../src/memory';

// ---------------------------------------------------------------------------
// B.1 JOIN-CONSISTENCY (advisor-required) + cross-provider parity.
//
// SCOPE OF THIS TEST: it drives the REAL recording site
// (MemoryGateway.recall → recordRecallUsage) with a unitId ALREADY on the
// context, then proves the reward-side lookup (listRecallUsage({ unitId }))
// finds exactly those bundles by unitId ALONE — independent of the recorded
// runId (session). That is the join-key contract B.2 will rely on: attribution
// can join on the unit of work rather than the session, so the confirmed
// session-mismatch (recalls recorded under one session, rewards resolving from
// another) no longer loses the bundles.
//
// It does NOT exercise HOW unitId gets onto the context — the production
// resolvers (index.ts getActiveTaskId / the swarm_memory_recall tool reading
// its own session's currentTaskId) are covered by
// swarm-memory-recall-unit-id.test.ts. Session ids below are deliberately
// generic ('sess-recall' vs a non-recording 'sess-other') to avoid implying the
// resolver produced the id on a subagent session (in production it would be
// undefined there — the intended NULL degrade).
//
// Parametrized across both providers so the additive column, the write path,
// and the filter behave identically on sqlite and local-jsonl.
// ---------------------------------------------------------------------------

interface ProviderCase {
	name: 'local-jsonl' | 'sqlite';
	create(root: string): MemoryProvider & { close?: () => void | Promise<void> };
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
const openProviders: Array<{ close?: () => void | Promise<void> }> = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-join-')),
	);
	openProviders.length = 0;
});

afterEach(async () => {
	for (const provider of openProviders.splice(0)) {
		try {
			await provider.close?.();
		} catch {
			// already closed
		}
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track<T extends { close?: () => void | Promise<void> }>(
	provider: T,
): T {
	openProviders.push(provider);
	return provider;
}

async function providerRoot(name: string): Promise<string> {
	const root = path.join(tmpDir, name);
	await fs.mkdir(root, { recursive: true });
	return root;
}

const QUERY = 'always run bun test before pushing';
const MEMORY_TEXT = 'convention: always run bun test before pushing changes';

for (const providerCase of providerCases) {
	describe(`recall unit_id join — ${providerCase.name}`, () => {
		test('a recorded recall is joined by unitId alone, independent of the recorded session', async () => {
			const root = await providerRoot(`${providerCase.name}-join`);
			const provider = track(providerCase.create(root));

			// Recording site as it exists in production: the gateway carries the
			// recall session's id as runId and a resolved unit (task) id. (How the
			// unitId is resolved onto the context is tested separately; here it is
			// supplied to isolate the join-key contract.)
			const gateway = createMemoryGateway(
				{
					directory: root,
					sessionID: 'sess-recall',
					agentRole: 'coder',
					agentId: 'coder',
					runId: 'sess-recall',
					unitId: '1.1',
				},
				{ provider, config: { enabled: true, provider: providerCase.name } },
			);

			// Seed a memory in the gateway's own repository scope so recall returns it.
			const record = gateway.createRecord({
				kind: 'repo_convention',
				text: MEMORY_TEXT,
				// Durable repo memories require source evidence (schema rule).
				evidenceRefs: ['src/testing/conventions.ts'],
			});
			await provider.upsert(record);

			const bundle = await gateway.recall({ query: QUERY, minScore: 0 });
			// Falsifiability: the recall must actually surface the seeded memory,
			// otherwise the join below would be vacuous.
			expect(bundle.items.map((i) => i.record.id)).toContain(record.id);

			// Reward-side join by unitId finds the bundle regardless of session.
			const byUnit = await provider.listRecallUsage!({ unitId: '1.1' });
			expect(byUnit).toHaveLength(1);
			expect(byUnit[0]?.bundleId).toBe(bundle.id);
			expect(byUnit[0]?.memoryIds).toContain(record.id);
			// The join key is independent of session: the row still carries the
			// recall session's runId, but unitId is what made it discoverable.
			expect(byUnit[0]?.runId).toBe('sess-recall');
			expect(byUnit[0]?.unitId).toBe('1.1');

			// THE session-mismatch guard: a DIFFERENT session (e.g. where the
			// reward resolves) does NOT match the recorded runId — a run_id-only
			// join would miss this bundle entirely...
			const byOtherRun = await provider.listRecallUsage!({
				runId: 'sess-other',
			});
			expect(byOtherRun).toHaveLength(0);
			// ...while the unitId join (same taskId the reward uses) still finds it.
			const byUnitAgain = await provider.listRecallUsage!({
				unitId: '1.1',
			});
			expect(byUnitAgain).toHaveLength(1);

			// A different unit must not collide.
			const byOtherUnit = await provider.listRecallUsage!({ unitId: '9.9' });
			expect(byOtherUnit).toHaveLength(0);

			await gateway.dispose();
		});

		test('graceful degrade: recall with no resolvable unitId persists absent and is still found by runId', async () => {
			const root = await providerRoot(`${providerCase.name}-degrade`);
			const provider = track(providerCase.create(root));

			// No unitId on the context — the dominant subagent-injection reality.
			const gateway = createMemoryGateway(
				{
					directory: root,
					sessionID: 'sess-only',
					agentRole: 'coder',
					agentId: 'coder',
					runId: 'sess-only',
				},
				{ provider, config: { enabled: true, provider: providerCase.name } },
			);
			const record = gateway.createRecord({
				kind: 'repo_convention',
				text: MEMORY_TEXT,
				// Durable repo memories require source evidence (schema rule).
				evidenceRefs: ['src/testing/conventions.ts'],
			});
			await provider.upsert(record);

			const bundle = await gateway.recall({ query: QUERY, minScore: 0 });
			expect(bundle.items.map((i) => i.record.id)).toContain(record.id);

			// Legacy session-scoped path is unchanged.
			const byRun = await provider.listRecallUsage!({ runId: 'sess-only' });
			expect(byRun).toHaveLength(1);
			expect(byRun[0]?.bundleId).toBe(bundle.id);
			expect(byRun[0]?.unitId).toBeUndefined();

			// No unit filter can reach a row that was recorded without one.
			const byUnit = await provider.listRecallUsage!({ unitId: '1.1' });
			expect(byUnit).toHaveLength(0);

			await gateway.dispose();
		});
	});
}
