/**
 * B.3 — Phase verdict reward capture: HOOK-free unit tests for the
 * `submit_phase_council_verdicts` reward branch added in
 * `src/tools/submit-phase-council-verdicts.ts`.
 *
 * Covers (spec FR-011/FR-012; SC-012/SC-013):
 *   - SC-012: a phase APPROVE with a verified `ctx.sessionID` rewards the
 *     memories recalled under that session via the SAME shared mechanism
 *     (`applyCouncilReward`) A.4 uses — an upward EMA q-move and an
 *     appended reward event.
 *   - SC-013: a phase verdict with NO `ctx.sessionID` is a silent no-op —
 *     zero reward events, no throw, evidence is still written.
 *   - Verdict → reward mapping: REJECT maps to 0.0 (downward EMA move),
 *     CONCERNS maps to 0.5.
 *   - Non-blocking: a reward-path provider failure does not fail the tool;
 *     evidence is still returned/written.
 *   - Trust gate: the reward is keyed on `ctx.sessionID`, never on the
 *     free-form, model-suppliable `provenanceSessionId` argument, even
 *     when both are present and differ.
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

const writeConfig = (
	dir: string,
	council: Record<string, unknown>,
	memory?: Record<string, unknown>,
): void => {
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council, ...(memory ? { memory } : {}) }),
	);
};

const writeMutationGateEvidence = (
	dir: string,
	phaseNumber: number,
	verdict: 'pass' | 'warn' | 'fail' | 'skip' = 'pass',
): void => {
	const evidenceDir = join(dir, '.swarm', 'evidence', String(phaseNumber));
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(
		join(evidenceDir, 'mutation-gate.json'),
		JSON.stringify({
			entries: [
				{ type: 'mutation-gate', verdict, timestamp: '2026-01-01T00:00:00Z' },
			],
		}),
	);
};

const makeVerdict = (
	agent: string,
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

const ALL_5_APPROVE = [
	makeVerdict('critic'),
	makeVerdict('reviewer'),
	makeVerdict('sme'),
	makeVerdict('test_engineer'),
	makeVerdict('explorer'),
];

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
	tempDir = mkdtempSync(join(tmpdir(), 'spcv-reward-'));
});

afterEach(() => {
	try {
		rmSync(tempDir, { recursive: true, force: true });
	} catch {
		/* best effort — Windows may hold locks on JSONL files briefly */
	}
});

/** Seed a memory + a recall-usage bundle tagged with `runId`. Returns the id. */
async function seedRecalledMemory(
	dir: string,
	runId: string,
	text: string,
): Promise<string> {
	const memoryConfig = resolveMemoryConfig(MEMORY_ENABLED_LOCAL_JSONL);
	const memory = makeMemoryRecord(text);
	const provider = new LocalJsonlMemoryProvider(dir, memoryConfig);
	await provider.upsert(memory);
	await provider.recordRecallUsage?.({
		bundleId: `bundle-${runId}`,
		query: 'q',
		scopes: [memory.scope],
		memoryIds: [memory.id],
		scores: [0.9],
		tokenEstimate: 20,
		runId,
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

describe('submit_phase_council_verdicts — B.3 reward capture (SC-012)', () => {
	test('phase APPROVE with a verified ctx.sessionID rewards the session-recalled memory upward', async () => {
		writeConfig(tempDir, { enabled: true }, MEMORY_ENABLED_LOCAL_JSONL);
		writeMutationGateEvidence(tempDir, 1, 'pass');
		const sessionID = 'sess-sc012-approve';
		const memoryId = await seedRecalledMemory(
			tempDir,
			sessionID,
			'SC-012 approve reward memory.',
		);

		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const result = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 1,
				swarmId: 'test',
				phaseSummary: 'Phase 1 complete.',
				verdicts: ALL_5_APPROVE,
				working_directory: tempDir,
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

describe('submit_phase_council_verdicts — B.3 trust gate (SC-013)', () => {
	test('no ctx.sessionID is a silent no-op: no reward events, no throw, evidence still written', async () => {
		writeConfig(tempDir, { enabled: true }, MEMORY_ENABLED_LOCAL_JSONL);
		writeMutationGateEvidence(tempDir, 1, 'pass');
		// Seed under an arbitrary runId — proves the absence of reward events is
		// due to the trust gate, not the absence of anything to reward.
		const memoryId = await seedRecalledMemory(
			tempDir,
			'sess-would-be-rewarded',
			'SC-013 unlinkable memory.',
		);

		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		let thrown: unknown;
		let result = '';
		try {
			result = await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 1,
					swarmId: 'test',
					phaseSummary: 'Phase 1 complete.',
					verdicts: ALL_5_APPROVE,
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.evidencePath).toBe('.swarm/evidence/1/phase-council.json');

		const { events } = await readMemory(tempDir, memoryId);
		expect(events).toEqual([]);
	});

	test('a bogus provenanceSessionId is never used as the reward join key — ctx.sessionID wins', async () => {
		writeConfig(tempDir, { enabled: true }, MEMORY_ENABLED_LOCAL_JSONL);
		writeMutationGateEvidence(tempDir, 1, 'pass');
		const realSessionID = 'sess-real-verified';
		const bogusProvenanceSessionId = 'sess-bogus-model-supplied';
		const memoryUnderRealSession = await seedRecalledMemory(
			tempDir,
			realSessionID,
			'Real-session memory.',
		);
		const memoryUnderBogusSession = await seedRecalledMemory(
			tempDir,
			bogusProvenanceSessionId,
			'Bogus-session memory.',
		);

		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const result = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 1,
				swarmId: 'test',
				phaseSummary: 'Phase 1 complete.',
				verdicts: ALL_5_APPROVE,
				working_directory: tempDir,
				provenanceSessionId: bogusProvenanceSessionId,
			},
			{ directory: tempDir, sessionID: realSessionID },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);

		const real = await readMemory(tempDir, memoryUnderRealSession);
		expect(real.events).toHaveLength(1);
		expect(real.events[0]?.runId).toBe(realSessionID);

		const bogus = await readMemory(tempDir, memoryUnderBogusSession);
		expect(bogus.events).toEqual([]);
	});
});

describe('submit_phase_council_verdicts — B.3 verdict -> reward mapping', () => {
	test('REJECT verdict maps to reward 0.0 (downward EMA move)', async () => {
		writeConfig(
			tempDir,
			{ enabled: true, vetoPriority: true },
			MEMORY_ENABLED_LOCAL_JSONL,
		);
		writeMutationGateEvidence(tempDir, 7, 'pass');
		const sessionID = 'sess-reject-mapping';
		const memoryId = await seedRecalledMemory(
			tempDir,
			sessionID,
			'REJECT mapping memory.',
		);

		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const rejectVerdicts = [
			makeVerdict('critic', 'REJECT'),
			makeVerdict('reviewer'),
			makeVerdict('sme'),
		];
		const result = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 7,
				swarmId: 'test',
				phaseSummary: 'Phase 7 summary.',
				verdicts: rejectVerdicts,
				working_directory: tempDir,
			},
			{ directory: tempDir, sessionID },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.overallVerdict).toBe('REJECT');

		const { record, events } = await readMemory(tempDir, memoryId);
		expect(events).toHaveLength(1);
		expect(events[0]?.reward).toBe(0.0);
		// verdictLabel threading (Fix 2): a phase REJECT must log the true
		// verdict, not the misleading hardcoded 'APPROVE' default.
		expect(events[0]?.verdict).toBe('REJECT');
		// EMA: q0=0.5, eta=0.1, reward=0.0 -> 0.5 + 0.1*(0.0-0.5) = 0.45 (downward)
		expect(record?.metadata.qValue).toBeCloseTo(0.45, 10);
	});

	test('CONCERNS verdict maps to reward 0.5 (neutral, no net EMA move from a 0.5 baseline)', async () => {
		writeConfig(tempDir, { enabled: true }, MEMORY_ENABLED_LOCAL_JSONL);
		writeMutationGateEvidence(tempDir, 8, 'pass');
		const sessionID = 'sess-concerns-mapping';
		const memoryId = await seedRecalledMemory(
			tempDir,
			sessionID,
			'CONCERNS mapping memory.',
		);

		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const concernsVerdicts = [
			makeVerdict('critic'),
			makeVerdict('reviewer', 'CONCERNS'),
			makeVerdict('sme'),
		];
		const result = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 8,
				swarmId: 'test',
				phaseSummary: 'Phase 8 summary.',
				verdicts: concernsVerdicts,
				working_directory: tempDir,
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

describe('submit_phase_council_verdicts — B.3 non-blocking reward path', () => {
	test('a reward-path provider failure does not fail the tool; evidence is still returned', async () => {
		// storageDir escapes .swarm/ so the provider's own lazy initialize()
		// (invoked from listRecallUsage, the first call applyCouncilReward
		// makes) rejects with a real path-traversal error — a genuine
		// provider-level failure, no module mocking required.
		writeConfig(
			tempDir,
			{ enabled: true },
			{
				enabled: true,
				provider: 'local-jsonl',
				storageDir: '../escapes-swarm-root',
			},
		);
		writeMutationGateEvidence(tempDir, 1, 'pass');
		const sessionID = 'sess-isolation';

		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		let thrown: unknown;
		let result = '';
		try {
			result = await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 1,
					swarmId: 'test',
					phaseSummary: 'Phase 1 complete.',
					verdicts: ALL_5_APPROVE,
					working_directory: tempDir,
				},
				{ directory: tempDir, sessionID },
			);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeUndefined();
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);
		expect(parsed.evidencePath).toBe('.swarm/evidence/1/phase-council.json');
	});
});

describe('submit_phase_council_verdicts — B.3 memory-disabled gate', () => {
	test('memory.enabled=false (default) is a no-op even with a verified ctx.sessionID', async () => {
		// No memory config written at all — matches the schema default
		// (enabled: false).
		writeConfig(tempDir, { enabled: true });
		writeMutationGateEvidence(tempDir, 1, 'pass');
		const sessionID = 'sess-memory-disabled';
		const memoryId = await seedRecalledMemory(
			tempDir,
			sessionID,
			'Memory-disabled no-op memory.',
		);

		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const result = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 1,
				swarmId: 'test',
				phaseSummary: 'Phase 1 complete.',
				verdicts: ALL_5_APPROVE,
				working_directory: tempDir,
			},
			{ directory: tempDir, sessionID },
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);

		const { events } = await readMemory(tempDir, memoryId);
		expect(events).toEqual([]);
	});
});
