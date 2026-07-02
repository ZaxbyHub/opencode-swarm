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
			tmpDir,
			{ sessionID: 'session-council' },
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

	test('submit_phase_council_verdicts rewards recalled memories by provenance session id', async () => {
		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const record = await seedRecall('session-phase');
		await writePassingMutationGate(2);

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
			tmpDir,
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

	// FB-001: runId mismatch — seed with task-agent session, call with architect session.
	// The 30-minute fallback in latestRecallUsageForRun should still find the event.
	test('applyRecallRewardForCouncil falls back to recent recall when runId differs', async () => {
		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const record = await seedRecall('task-agent-run-abc');
		await writePassingMutationGate(1);

		// Call with a completely different runId — no exact match possible.
		// The 30-minute fallback should still match the recent recall.
		const raw = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 1,
				swarmId: 'mega',
				phaseSummary: 'Phase with cross-session recall fallback.',
				roundNumber: 1,
				verdicts: [memberVerdict('reviewer', 'APPROVE')],
				provenanceSessionId: 'architect-session-xyz', // different from task-agent-run-abc
				working_directory: tmpDir,
			},
			tmpDir,
		);
		const parsed = JSON.parse(raw as string) as {
			success: boolean;
			memoryReward?: {
				success: boolean;
				updatedMemoryIds: string[];
				reason?: string;
			};
		};
		const updated = await readMemory(record.id);

		expect(parsed).toMatchObject({ success: true });
		expect(parsed.memoryReward).toMatchObject({
			success: true,
			updatedMemoryIds: [record.id],
		});
		expect(updated.qValue).toBeCloseTo(0.55, 5);
	});

	// FB-001: unknown runId outside the 30-minute window should return no match.
	test('applyRecallRewardForCouncil returns no_recall_usage_for_run for stale runId', async () => {
		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		// Seed a recall with a timestamp older than the 30-minute fallback window.
		const record = await seedRecallWithTimestamp(
			'stale-run',
			new Date(Date.now() - 31 * 60 * 1000).toISOString(),
		);
		await writePassingMutationGate(1);

		// Use a runId that has no recall and is outside the fallback window.
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
			tmpDir,
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
