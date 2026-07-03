/**
 * B.4 — Final verdict reward capture: HOOK-free unit tests for the reward
 * branch added in `src/tools/write-final-council-evidence.ts`.
 *
 * Mirrors `submit-phase-council-verdicts-reward.test.ts` (B.3), applied to the
 * FINAL council verdict tool.
 *
 * Covers (spec FR-011/FR-012; SC-012/SC-013):
 *   - SC-012: a final APPROVE with a verified `ctx.sessionID` rewards the
 *     memories recalled under that session via the SAME shared mechanism
 *     (`applyCouncilReward`) A.4/B.3 use — an upward EMA q-move and an
 *     appended reward event labeled with the overall verdict.
 *   - SC-013: a final verdict with NO `ctx.sessionID` is a silent no-op —
 *     zero reward events, no throw, evidence is still written.
 *   - Verdict -> reward mapping: REJECT maps to 0.0 (downward EMA move).
 *   - Non-blocking: a reward-path provider failure does not fail the tool;
 *     evidence is still returned/written.
 *   - Memory-disabled (default) is a no-op even with a verified sessionID.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	LocalJsonlMemoryProvider,
	type MemoryRecord,
	resolveMemoryConfig,
} from '../../../src/memory';

const writeMemoryConfig = (
	dir: string,
	memory?: Record<string, unknown>,
): void => {
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(memory ? { memory } : {}),
	);
};

const writePlanFixture = (dir: string): void => {
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Final Council Reward Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							description: 'Test task',
						},
					],
				},
			],
		}),
	);
};

const members = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
] as const;

const makeVerdict = (
	agent: (typeof members)[number],
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT' = 'APPROVE',
): Record<string, unknown> => ({
	agent,
	verdict,
	confidence: 0.9,
	findings: [],
	criteriaAssessed: [],
	criteriaUnmet: [],
	durationMs: 10,
});

const ALL_5_APPROVE = members.map((m) => makeVerdict(m));

function makeMemoryRecord(text: string): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
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

const MEMORY_ENABLED_LOCAL_JSONL = { enabled: true, provider: 'local-jsonl' };

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'wfce-reward-'));
	writePlanFixture(tempDir);
});

afterEach(() => {
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		/* best effort — Windows may hold locks on JSONL files briefly */
	}
});

/**
 * Seed a memory + a recall-usage bundle tagged with `runId` (and optionally a
 * per-task `unitId`). The bundleId incorporates `unitId` so distinct-task
 * bundles under the same session do not collide. Returns the memory id.
 */
async function seedRecalledMemory(
	dir: string,
	runId: string,
	text: string,
	unitId?: string,
): Promise<string> {
	const memoryConfig = resolveMemoryConfig(MEMORY_ENABLED_LOCAL_JSONL);
	const memory = makeMemoryRecord(text);
	const provider = new LocalJsonlMemoryProvider(dir, memoryConfig);
	await provider.upsert(memory);
	await provider.recordRecallUsage?.({
		bundleId: `bundle-${runId}-${unitId ?? 'none'}`,
		query: 'q',
		scopes: [memory.scope],
		memoryIds: [memory.id],
		scores: [0.9],
		tokenEstimate: 20,
		runId,
		...(unitId ? { unitId } : {}),
		timestamp: '2026-06-01T00:00:00.000Z',
	});
	return memory.id;
}

async function readMemory(dir: string, memoryId: string) {
	const memoryConfig = resolveMemoryConfig(MEMORY_ENABLED_LOCAL_JSONL);
	const reader = new LocalJsonlMemoryProvider(dir, memoryConfig);
	const record = await reader.get(memoryId);
	const events = await reader.listRewardEvents?.({ memoryId });
	return { record, events: events ?? [] };
}

describe('write_final_council_evidence — B.4 reward capture (SC-012)', () => {
	test('final APPROVE with a verified ctx.sessionID rewards the session-recalled memory upward', async () => {
		writeMemoryConfig(tempDir, MEMORY_ENABLED_LOCAL_JSONL);
		const sessionID = 'sess-final-sc012-approve';
		const memoryId = await seedRecalledMemory(
			tempDir,
			sessionID,
			'SC-012 final approve reward memory.',
		);

		const { write_final_council_evidence } = await import(
			'../../../src/tools/write-final-council-evidence'
		);
		const result = await write_final_council_evidence.execute(
			{
				phase: 3,
				projectSummary: 'All planned project phases are complete.',
				verdicts: ALL_5_APPROVE,
			},
			{ directory: tempDir, sessionID },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.overallVerdict).toBe('APPROVE');

		const { record, events } = await readMemory(tempDir, memoryId);
		expect(events).toHaveLength(1);
		expect(events[0]?.reward).toBe(1.0);
		expect(events[0]?.runId).toBe(sessionID);
		expect(events[0]?.verdict).toBe('APPROVE');
		// EMA: q0=0.5, eta=0.1, reward=1.0 -> 0.5 + 0.1*(1.0-0.5) = 0.55 (upward)
		expect(record?.metadata.qValue).toBeCloseTo(0.55, 10);
	});
});

describe('write_final_council_evidence — B.4 session-scope (unitId: undefined rewards ALL bundles in the session)', () => {
	test('two memories recalled under the same session but DIFFERENT unitIds are BOTH rewarded (session-scope, not task-scope)', async () => {
		// B.4 calls applyCouncilReward with `unitId: undefined` — the final
		// verdict is a project-scope judgment, so it must reward EVERY memory
		// recalled in the session, regardless of which task's bundle tagged it.
		// This locks that semantic: a future refactor narrowing the final
		// reward to a single task's unitId would fail here.
		writeMemoryConfig(tempDir, MEMORY_ENABLED_LOCAL_JSONL);
		const sessionID = 'sess-final-scope-all';
		const idA = await seedRecalledMemory(
			tempDir,
			sessionID,
			'Session-scope reward: bundle tagged task-A.',
			'task-A',
		);
		const idB = await seedRecalledMemory(
			tempDir,
			sessionID,
			'Session-scope reward: bundle tagged task-B.',
			'task-B',
		);

		const { write_final_council_evidence } = await import(
			'../../../src/tools/write-final-council-evidence'
		);
		const result = await write_final_council_evidence.execute(
			{
				phase: 3,
				projectSummary: 'All planned project phases are complete.',
				verdicts: ALL_5_APPROVE,
			},
			{ directory: tempDir, sessionID },
		);
		expect(JSON.parse(result).success).toBe(true);

		// BOTH memories — despite differing unitIds — receive the session-scope
		// reward (single event each, upward EMA move from the 0.5 default).
		const a = await readMemory(tempDir, idA);
		const b = await readMemory(tempDir, idB);
		expect(a.events).toHaveLength(1);
		expect(b.events).toHaveLength(1);
		expect(a.events[0]?.reward).toBe(1.0);
		expect(b.events[0]?.reward).toBe(1.0);
		expect(a.record?.metadata.qValue).toBeCloseTo(0.55, 10);
		expect(b.record?.metadata.qValue).toBeCloseTo(0.55, 10);
	});
});

describe('write_final_council_evidence — B.4 trust gate (SC-013)', () => {
	test('no ctx.sessionID is a silent no-op: no reward events, no throw, evidence still written', async () => {
		writeMemoryConfig(tempDir, MEMORY_ENABLED_LOCAL_JSONL);
		// Seed under an arbitrary runId — proves the absence of reward events is
		// due to the trust gate, not the absence of anything to reward.
		const memoryId = await seedRecalledMemory(
			tempDir,
			'sess-would-be-rewarded',
			'SC-013 final unlinkable memory.',
		);

		const { write_final_council_evidence } = await import(
			'../../../src/tools/write-final-council-evidence'
		);
		let thrown: unknown;
		let result = '';
		try {
			result = await write_final_council_evidence.execute(
				{
					phase: 3,
					projectSummary: 'All planned project phases are complete.',
					verdicts: ALL_5_APPROVE,
				},
				{ directory: tempDir },
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.evidencePath).toBe('.swarm/evidence/final-council.json');

		const { events } = await readMemory(tempDir, memoryId);
		expect(events).toEqual([]);
	});
});

describe('write_final_council_evidence — B.4 verdict -> reward mapping', () => {
	test('REJECT final verdict maps to reward 0.0 (downward EMA move)', async () => {
		writeMemoryConfig(tempDir, MEMORY_ENABLED_LOCAL_JSONL);
		const sessionID = 'sess-final-reject-mapping';
		const memoryId = await seedRecalledMemory(
			tempDir,
			sessionID,
			'REJECT final mapping memory.',
		);

		const rejectVerdicts = [
			makeVerdict('critic', 'REJECT'),
			...members.filter((m) => m !== 'critic').map((m) => makeVerdict(m)),
		];

		const { write_final_council_evidence } = await import(
			'../../../src/tools/write-final-council-evidence'
		);
		const result = await write_final_council_evidence.execute(
			{
				phase: 3,
				projectSummary: 'Project complete pending final review.',
				verdicts: rejectVerdicts,
			},
			{ directory: tempDir, sessionID },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.overallVerdict).toBe('REJECT');

		const { record, events } = await readMemory(tempDir, memoryId);
		expect(events).toHaveLength(1);
		expect(events[0]?.reward).toBe(0.0);
		expect(events[0]?.verdict).toBe('REJECT');
		// EMA: q0=0.5, eta=0.1, reward=0.0 -> 0.5 + 0.1*(0.0-0.5) = 0.45 (downward)
		expect(record?.metadata.qValue).toBeCloseTo(0.45, 10);
	});

	test('CONCERNS final verdict (no blocking findings) maps to reward 0.5 (neutral)', async () => {
		writeMemoryConfig(tempDir, MEMORY_ENABLED_LOCAL_JSONL);
		const sessionID = 'sess-final-concerns-mapping';
		const memoryId = await seedRecalledMemory(
			tempDir,
			sessionID,
			'CONCERNS final mapping memory.',
		);

		const concernsVerdicts = [
			makeVerdict('test_engineer', 'CONCERNS'),
			...members
				.filter((m) => m !== 'test_engineer')
				.map((m) => makeVerdict(m)),
		];

		const { write_final_council_evidence } = await import(
			'../../../src/tools/write-final-council-evidence'
		);
		const result = await write_final_council_evidence.execute(
			{
				phase: 3,
				projectSummary: 'Project complete with advisory concerns only.',
				verdicts: concernsVerdicts,
			},
			{ directory: tempDir, sessionID },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.overallVerdict).toBe('CONCERNS');

		const { record, events } = await readMemory(tempDir, memoryId);
		expect(events).toHaveLength(1);
		expect(events[0]?.reward).toBe(0.5);
		expect(events[0]?.verdict).toBe('CONCERNS');
		// EMA: q0=0.5, eta=0.1, reward=0.5 -> unchanged at 0.5.
		expect(record?.metadata.qValue).toBeCloseTo(0.5, 10);
	});
});

describe('write_final_council_evidence — B.4 non-blocking reward path', () => {
	test('a reward-path provider failure does not fail the tool; evidence is still returned', async () => {
		// storageDir escapes .swarm/ so the provider's own lazy initialize()
		// (invoked from listRecallUsage, the first call applyCouncilReward
		// makes) rejects with a real path-traversal error — a genuine
		// provider-level failure, no module mocking required.
		writeMemoryConfig(tempDir, {
			enabled: true,
			provider: 'local-jsonl',
			storageDir: '../escapes-swarm-root',
		});
		const sessionID = 'sess-final-isolation';

		const { write_final_council_evidence } = await import(
			'../../../src/tools/write-final-council-evidence'
		);
		let thrown: unknown;
		let result = '';
		try {
			result = await write_final_council_evidence.execute(
				{
					phase: 3,
					projectSummary: 'All planned project phases are complete.',
					verdicts: ALL_5_APPROVE,
				},
				{ directory: tempDir, sessionID },
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.evidencePath).toBe('.swarm/evidence/final-council.json');
	});
});

describe('write_final_council_evidence — B.4 memory-disabled gate', () => {
	test('memory.enabled=false (default) is a no-op even with a verified ctx.sessionID', async () => {
		// No memory config written at all — matches the schema default
		// (enabled: false).
		writeMemoryConfig(tempDir);
		const sessionID = 'sess-final-memory-disabled';
		const memoryId = await seedRecalledMemory(
			tempDir,
			sessionID,
			'Final memory-disabled no-op memory.',
		);

		const { write_final_council_evidence } = await import(
			'../../../src/tools/write-final-council-evidence'
		);
		const result = await write_final_council_evidence.execute(
			{
				phase: 3,
				projectSummary: 'All planned project phases are complete.',
				verdicts: ALL_5_APPROVE,
			},
			{ directory: tempDir, sessionID },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);

		const { events } = await readMemory(tempDir, memoryId);
		expect(events).toEqual([]);
	});
});
