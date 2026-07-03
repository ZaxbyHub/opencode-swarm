/**
 * B.2/B.3 — Council reward capture: verdict labeling, Q-value updates,
 * and reward event formatting for `applyCouncilReward`.
 *
 * Coverage:
 *   1. APPROVE verdict (reward=1.0) → q increases, verdict='APPROVE' on event.
 *   2. REJECT verdict (reward=0.0) → q decreases, verdict='REJECT' on event.
 *   3. CONCERNS verdict (reward=0.5) → q changes moderately,
 *      verdict='CONCERNS' on event.
 *   4. Distinct-memory dedup: a memory recalled in several bundles gets exactly
 *      ONE direct EMA step (not one per bundle).
 *   5. Reward event formatting: qBefore/qAfter/verdictSynthesisJson/unitId/runId
 *      all correctly threaded through to appendRewardEvent.
 *   6. Propagated verdict gets _PROPAGATED suffix appended to verdictLabel.
 *
 * Run against local-jsonl provider.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { applyCouncilReward } from '../../../src/memory/reward-capture';

type P = MemoryProvider & { close?: () => void };

let tmpDir: string;
const open: P[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-council-')),
	);
	open.length = 0;
});

afterEach(async () => {
	for (const p of open.splice(0)) p.close?.();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

const p = (pr: P): P => {
	open.push(pr);
	return pr;
};
const r = async (n: string) => {
	const root = path.join(tmpDir, n);
	await fs.mkdir(root, { recursive: true });
	return root;
};

function rec(
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

const TS = '2026-06-01T00:00:00.000Z';

async function use(
	pr: P,
	r: MemoryRecord,
	runId: string,
	ts: string,
	unitId?: string,
) {
	await pr.recordRecallUsage?.({
		bundleId: `b-${r.id}-${runId}`,
		query: 'q',
		scopes: [r.scope],
		memoryIds: [r.id],
		scores: [0.9],
		tokenEstimate: 20,
		runId,
		unitId,
		timestamp: ts,
	});
}

describe('applyCouncilReward — verdict types and Q-value updates', () => {
	test('APPROVE (reward=1.0): q 0.5→0.55, verdict=APPROVE', async () => {
		const root = await r('ap');
		const pr = p(new LocalJsonlMemoryProvider(root, { enabled: true }));
		const m = rec('Convention for the approved task.');
		await pr.upsert(m);
		await use(pr, m, 's1', TS, 't1');
		await applyCouncilReward(pr, {
			runId: 's1',
			unitId: 't1',
			reward: 1,
			eta: 0.1,
			initialQValue: 0.5,
			verdictLabel: 'APPROVE',
			timestamp: TS,
		});
		const a = await pr.get(m.id);
		expect(a?.metadata.qValue).toBeCloseTo(0.55, 10);
		const ev = await pr.listRewardEvents?.({ memoryId: m.id });
		expect(ev).toHaveLength(1);
		expect(ev?.[0]).toMatchObject({
			memoryId: m.id,
			unitId: 't1',
			reward: 1,
			verdict: 'APPROVE',
			qBefore: 0.5,
		});
		expect(ev?.[0]?.qAfter).toBeCloseTo(0.55, 10);
	});

	test('REJECT (reward=0.0): q 0.5→0.45, verdict=REJECT', async () => {
		const root = await r('rj');
		const pr = p(new LocalJsonlMemoryProvider(root, { enabled: true }));
		const m = rec('Convention for the rejected task.');
		await pr.upsert(m);
		await use(pr, m, 's1', TS, 't1');
		await applyCouncilReward(pr, {
			runId: 's1',
			unitId: 't1',
			reward: 0,
			eta: 0.1,
			initialQValue: 0.5,
			verdictLabel: 'REJECT',
			timestamp: TS,
		});
		const a = await pr.get(m.id);
		expect(a?.metadata.qValue).toBeCloseTo(0.45, 10);
		const ev = await pr.listRewardEvents?.({ memoryId: m.id });
		expect(ev).toHaveLength(1);
		expect(ev?.[0]).toMatchObject({
			memoryId: m.id,
			unitId: 't1',
			reward: 0,
			verdict: 'REJECT',
			qBefore: 0.5,
		});
		expect(ev?.[0]?.qAfter).toBeCloseTo(0.45, 10);
	});

	test('CONCERNS (reward=0.75): q 0.5→0.525, verdict=CONCERNS', async () => {
		const root = await r('cn');
		const pr = p(new LocalJsonlMemoryProvider(root, { enabled: true }));
		const m = rec('Convention with partial concerns.');
		await pr.upsert(m);
		await use(pr, m, 's1', TS, 't1');
		// eta=0.1, reward=0.75, initialQ=0.5 → qAfter = 0.5 + 0.1*(0.75-0.5) = 0.525
		await applyCouncilReward(pr, {
			runId: 's1',
			unitId: 't1',
			reward: 0.75,
			eta: 0.1,
			initialQValue: 0.5,
			verdictLabel: 'CONCERNS',
			timestamp: TS,
		});
		const a = await pr.get(m.id);
		expect(a?.metadata.qValue).toBeCloseTo(0.525, 10);
		const ev = await pr.listRewardEvents?.({ memoryId: m.id });
		expect(ev).toHaveLength(1);
		expect(ev?.[0]).toMatchObject({
			memoryId: m.id,
			unitId: 't1',
			reward: 0.75,
			verdict: 'CONCERNS',
			qBefore: 0.5,
		});
		expect(ev?.[0]?.qAfter).toBeCloseTo(0.525, 10);
	});

	test('distinct-memory dedup: one memory in three bundles → exactly ONE EMA step', async () => {
		const root = await r('dd');
		const pr = p(new LocalJsonlMemoryProvider(root, { enabled: true }));
		const m = rec('Convention recalled in multiple bundles.');
		await pr.upsert(m);
		for (let i = 1; i <= 3; i++) {
			await pr.recordRecallUsage?.({
				bundleId: `bundle-${i}`,
				query: 'q',
				scopes: [m.scope],
				memoryIds: [m.id],
				scores: [0.9],
				tokenEstimate: 20,
				runId: 's1',
				unitId: 't1',
				timestamp: TS,
			});
		}
		const result = await applyCouncilReward(pr, {
			runId: 's1',
			unitId: 't1',
			reward: 1,
			eta: 0.1,
			initialQValue: 0.5,
			verdictLabel: 'APPROVE',
			timestamp: TS,
		});
		expect(result).toEqual({ memoriesRewarded: 1 });
		expect((await pr.get(m.id))?.metadata.qValue).toBeCloseTo(0.55, 10);
		expect(await pr.listRewardEvents?.({ memoryId: m.id })).toHaveLength(1);
	});

	test('reward event formatting: qBefore/qAfter/unitId/runId/verdictSynthesisJson threaded', async () => {
		const root = await r('fm');
		const pr = p(new LocalJsonlMemoryProvider(root, { enabled: true }));
		const m = rec('Convention with rich event formatting.');
		await pr.upsert(m);
		await use(pr, m, 's1', TS, 't1');
		const syn = JSON.stringify({ summary: 'approved with note' });
		await applyCouncilReward(pr, {
			runId: 's1',
			unitId: 't1',
			reward: 1,
			eta: 0.1,
			initialQValue: 0.5,
			verdictLabel: 'APPROVE',
			verdictSynthesisJson: syn,
			timestamp: TS,
		});
		const ev = await pr.listRewardEvents?.({ memoryId: m.id });
		expect(ev).toHaveLength(1);
		expect(ev?.[0]).toMatchObject({
			memoryId: m.id,
			unitId: 't1',
			runId: 's1',
			reward: 1,
			verdict: 'APPROVE',
			qBefore: 0.5,
			qAfter: 0.55,
			verdictSynthesisJson: syn,
		});
	});

	test('propagated verdict has _PROPAGATED suffix appended to verdictLabel', async () => {
		const root = await r('pvsfx');
		const pr = p(new LocalJsonlMemoryProvider(root, { enabled: true }));
		const direct = rec(
			Array.from({ length: 20 }, (_, i) => `base${i}`).join(' '),
		);
		const related = rec(
			[...Array.from({ length: 19 }, (_, i) => `base${i}`), 'rel1'].join(' '),
		);
		await pr.upsert(direct);
		await pr.upsert(related);
		await use(pr, direct, 's1', TS, 't1');
		await use(pr, related, 's0', '2026-06-20T00:00:00.000Z');
		await applyCouncilReward(pr, {
			runId: 's1',
			unitId: 't1',
			reward: 1,
			eta: 0.1,
			initialQValue: 0.5,
			verdictLabel: 'APPROVE',
			timestamp: TS,
		});
		expect(
			(await pr.listRewardEvents?.({ memoryId: direct.id }))?.[0]?.verdict,
		).toBe('APPROVE');
		const relEv = await pr.listRewardEvents?.({ memoryId: related.id });
		expect(relEv).toHaveLength(1);
		expect(relEv?.[0]?.verdict).toBe('APPROVE_PROPAGATED');
	});
});
