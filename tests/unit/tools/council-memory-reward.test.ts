import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { clearPool } from '../../../src/memory/provider-pool';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

let tmpDir: string;
let originalXdgConfigHome: string | undefined;

beforeEach(async () => {
	originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'council-memory-reward-')),
	);
	process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'xdg-config');
	await fs.mkdir(path.join(tmpDir, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(tmpDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			council: { enabled: true, minimumMembers: 1 },
			memory: { enabled: true, provider: 'sqlite' },
		}),
		'utf-8',
	);
});

afterEach(async () => {
	if (originalXdgConfigHome === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	}
	resetSwarmState();
	clearPool();
	await rmWithRetries(tmpDir);
});

describe('council verdict memory reward wiring', () => {
	test('submit_council_verdicts rewards recalled memories by session id', async () => {
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const record = await seedRecall('session-council');

		const raw = await submit_council_verdicts.execute(
			{
				taskId: '1.1',
				swarmId: 'session-council',
				roundNumber: 1,
				verdicts: [memberVerdict('critic', 'APPROVE')],
				working_directory: tmpDir,
			},
			{ directory: tmpDir, sessionID: 'session-council' } as unknown as any,
		);
		const parsed = JSON.parse(raw as string) as {
			success: boolean;
			memoryReward?: { success: boolean; updatedMemoryIds: string[] };
		};
		const updated = await readMemory(record.id);

		expect(parsed).toMatchObject({ success: true });
		expect(parsed.memoryReward).toMatchObject({
			success: true,
			updatedMemoryIds: [record.id],
		});
		expect(updated.qValue).toBeCloseTo(0.55, 5);
	});

	test('submit_phase_council_verdicts rewards recalled memories by provenance session id, when that session id is real/tracked', async () => {
		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const record = await seedRecall('session-phase');
		await writePassingMutationGate(2);
		// provenanceSessionId is caller-supplied and unvalidated by itself — the
		// reward path must confirm it resolves to a real, tracked session (via
		// getAgentSession) before trusting it. Simulate that tracking here, the
		// way the plugin runtime's tool-call hooks would in real usage.
		ensureAgentSession('session-phase', 'reviewer', tmpDir);

		const raw = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 2,
				swarmId: 'mega',
				phaseSummary: 'Phase completed the memory learning loop.',
				roundNumber: 1,
				verdicts: [memberVerdict('reviewer', 'APPROVE')],
				provenanceSessionId: 'session-phase',
				working_directory: tmpDir,
			},
			{ directory: tmpDir } as unknown as any,
		);
		const parsed = JSON.parse(raw as string) as {
			success: boolean;
			memoryReward?: { success: boolean; updatedMemoryIds: string[] };
		};
		const updated = await readMemory(record.id);

		expect(parsed).toMatchObject({ success: true });
		expect(parsed.memoryReward).toMatchObject({
			success: true,
			updatedMemoryIds: [record.id],
		});
		expect(updated.qValue).toBeCloseTo(0.55, 5);
	});

	// Trust-boundary fix (PR #1636 review F-001): an unvalidated provenanceSessionId
	// must NOT act as an unscoped "grab whatever's recent" fallback. An id that
	// does not resolve to a real, currently-tracked session is dropped, and a
	// genuinely mismatched/unknown session returns no_recall_usage_for_run —
	// it must never silently reward an unrelated recall bundle.
	test('an unregistered/spoofed provenanceSessionId is dropped, not trusted as a fallback match', async () => {
		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const record = await seedRecall('task-agent-run-abc');
		await writePassingMutationGate(1);

		// architect-session-xyz was never registered via ensureAgentSession —
		// it must be treated as unverifiable, not as a valid reward target.
		const raw = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 1,
				swarmId: 'mega',
				phaseSummary: 'Phase with an unregistered provenance session id.',
				roundNumber: 1,
				verdicts: [memberVerdict('reviewer', 'APPROVE')],
				provenanceSessionId: 'architect-session-xyz',
				working_directory: tmpDir,
			},
			{ directory: tmpDir } as unknown as any,
		);
		const parsed = JSON.parse(raw as string) as {
			success: boolean;
			memoryReward?: {
				success: boolean;
				updatedMemoryIds: string[];
				reason?: string;
			};
		};
		const unchanged = await readMemory(record.id);

		expect(parsed).toMatchObject({ success: true });
		expect(parsed.memoryReward).toMatchObject({
			success: false,
			reason: 'no_recall_usage_for_run',
		});
		// The unrelated bundle recalled under task-agent-run-abc must be
		// completely untouched — no cross-session reward leakage.
		expect(unchanged.qValue).toBeUndefined();
	});

	test('applyRecallRewardForCouncil returns no_recall_usage_for_run for a stale/unrelated runId', async () => {
		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const record = await seedRecallWithTimestamp(
			'stale-run',
			new Date(Date.now() - 31 * 60 * 1000).toISOString(),
		);
		await writePassingMutationGate(1);

		const raw = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 1,
				swarmId: 'mega',
				phaseSummary: 'No matching recall for this run.',
				roundNumber: 1,
				verdicts: [memberVerdict('reviewer', 'APPROVE')],
				provenanceSessionId: 'completely-unknown-session',
				working_directory: tmpDir,
			},
			{ directory: tmpDir } as unknown as any,
		);
		const parsed = JSON.parse(raw as string) as {
			success: boolean;
			memoryReward?: { success: boolean; reason?: string };
		};

		expect(parsed).toMatchObject({ success: true });
		expect(parsed.memoryReward).toMatchObject({
			success: false,
			reason: 'no_recall_usage_for_run',
		});
		const unchanged = await readMemory(record.id);
		expect(unchanged.qValue).toBeUndefined();
	});

	// Sub-agent/architect session mismatch fix (PR #1636 review F-003): when the
	// architect reports each dispatched council member's own session id via the
	// per-verdict `sessionId` field, that member's own recall bundle is rewarded
	// too, not just the architect's own session.
	test('rewards a dispatched council member recall bundle via the per-verdict sessionId field', async () => {
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const architectRecord = await seedRecall('session-arch-multi');
		const criticRecord = await seedRecall('session-critic-multi');
		ensureAgentSession('session-critic-multi', 'critic', tmpDir);

		const raw = await submit_council_verdicts.execute(
			{
				taskId: '1.1',
				swarmId: 'multi-session-swarm',
				roundNumber: 1,
				verdicts: [
					{
						...memberVerdict('critic', 'APPROVE'),
						sessionId: 'session-critic-multi',
					},
				],
				working_directory: tmpDir,
			},
			{
				directory: tmpDir,
				sessionID: 'session-arch-multi',
			} as unknown as any,
		);
		const parsed = JSON.parse(raw as string) as {
			success: boolean;
			memoryReward?: { success: boolean; updatedMemoryIds: string[] };
		};
		const architectUpdated = await readMemory(architectRecord.id);
		const criticUpdated = await readMemory(criticRecord.id);

		expect(parsed).toMatchObject({ success: true });
		expect(parsed.memoryReward?.success).toBe(true);
		expect(parsed.memoryReward?.updatedMemoryIds?.sort()).toEqual(
			[architectRecord.id, criticRecord.id].sort(),
		);
		expect(architectUpdated.qValue).toBeCloseTo(0.55, 5);
		expect(criticUpdated.qValue).toBeCloseTo(0.55, 5);
	});

	// Idempotency fix (PR #1636 review F-004): resubmitting the identical
	// taskId+swarmId+round verdict does not re-apply the EMA update.
	test('resubmitting the same task/round verdict does not double-apply the reward', async () => {
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const record = await seedRecall('session-idempotent');
		const args = {
			taskId: '2.1',
			swarmId: 'idempotent-swarm',
			roundNumber: 1,
			verdicts: [memberVerdict('critic', 'APPROVE')],
			working_directory: tmpDir,
		};
		const ctx = {
			directory: tmpDir,
			sessionID: 'session-idempotent',
		} as unknown as any;

		await submit_council_verdicts.execute(args, ctx);
		const secondRaw = await submit_council_verdicts.execute(args, ctx);
		const secondParsed = JSON.parse(secondRaw as string) as {
			memoryReward?: { success: boolean; reason?: string };
		};
		const updated = await readMemory(record.id);

		expect(secondParsed.memoryReward?.reason).toBe('already_rewarded');
		// EMA applied exactly once (0.5 -> 0.55), not twice.
		expect(updated.qValue).toBeCloseTo(0.55, 5);
	});
});

async function writePassingMutationGate(phaseNumber: number): Promise<void> {
	const evidenceDir = path.join(
		tmpDir,
		'.swarm',
		'evidence',
		String(phaseNumber),
	);
	await fs.mkdir(evidenceDir, { recursive: true });
	await fs.writeFile(
		path.join(evidenceDir, 'mutation-gate.json'),
		JSON.stringify({
			entries: [{ type: 'mutation-gate', verdict: 'pass' }],
		}),
		'utf-8',
	);
}

async function seedRecallWithTimestamp(
	runId: string,
	timestamp: string,
): Promise<MemoryRecord> {
	const provider = new SQLiteMemoryProvider(tmpDir, {
		enabled: true,
		provider: 'sqlite',
	});
	try {
		const record = await provider.upsert(
			makeRecord(`Memory reward record for ${runId}.`),
		);
		await provider.recordRecallUsage?.({
			bundleId: `bundle-${runId}`,
			query: 'memory reward',
			scopes: [{ type: 'repository', repoId: 'repo-a' }],
			kinds: ['repo_convention'],
			memoryIds: [record.id],
			scores: [0.8],
			tokenEstimate: 12,
			agentRole: 'architect',
			runId,
			timestamp,
		});
		return record;
	} finally {
		provider.close();
	}
}

async function seedRecall(runId: string): Promise<MemoryRecord> {
	const provider = new SQLiteMemoryProvider(tmpDir, {
		enabled: true,
		provider: 'sqlite',
	});
	try {
		const record = await provider.upsert(
			makeRecord(`Memory reward record for ${runId}.`),
		);
		await provider.recordRecallUsage?.({
			bundleId: `bundle-${runId}`,
			query: 'memory reward',
			scopes: [{ type: 'repository', repoId: 'repo-a' }],
			kinds: ['repo_convention'],
			memoryIds: [record.id],
			scores: [0.8],
			tokenEstimate: 12,
			agentRole: 'architect',
			runId,
			timestamp: new Date().toISOString(),
		});
		return record;
	} finally {
		provider.close();
	}
}

async function readMemory(id: string): Promise<MemoryRecord> {
	const provider = new SQLiteMemoryProvider(tmpDir, {
		enabled: true,
		provider: 'sqlite',
	});
	try {
		const record = await provider.get(id);
		if (!record) throw new Error(`missing memory ${id}`);
		return record;
	} finally {
		provider.close();
	}
}

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

function memberVerdict(
	agent: 'critic' | 'reviewer',
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT',
) {
	return {
		agent,
		verdict,
		confidence: 0.9,
		findings: [],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 10,
	};
}

async function rmWithRetries(target: string): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			await fs.rm(target, { recursive: true, force: true });
			return;
		} catch (err) {
			if (attempt === 9) throw err;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}
