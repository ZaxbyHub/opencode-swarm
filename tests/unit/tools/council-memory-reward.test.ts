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
import { resetSwarmState } from '../../../src/state';
import { seedCouncilLaunch } from '../../helpers/task-workflow-evidence';

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

describe('phase council memory reward wiring', () => {
	test('submit_phase_council_verdicts rewards memories recalled by trusted ctx.sessionID', async () => {
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
				provenanceSessionId: 'untrusted-model-supplied-id',
				working_directory: tmpDir,
			},
			{ directory: tmpDir, sessionID: 'session-phase' } as unknown as any,
		);
		const parsed = JSON.parse(raw as string) as { success: boolean };
		const updated = await readMemory(record.id);

		expect(parsed).toMatchObject({ success: true });
		expect(updated.metadata.qValue).toBeCloseTo(0.55, 5);
	});

	test('submit_phase_council_verdicts does not trust provenanceSessionId as a reward join key', async () => {
		const { submit_phase_council_verdicts } = await import(
			'../../../src/tools/submit-phase-council-verdicts'
		);
		const record = await seedRecall('provenance-only-session');
		await writePassingMutationGate(1);

		const raw = await submit_phase_council_verdicts.execute(
			{
				phaseNumber: 1,
				swarmId: 'mega',
				phaseSummary: 'Phase with only caller supplied provenance.',
				roundNumber: 1,
				verdicts: [memberVerdict('reviewer', 'APPROVE')],
				provenanceSessionId: 'provenance-only-session',
				working_directory: tmpDir,
			},
			{ directory: tmpDir } as unknown as any,
		);
		const parsed = JSON.parse(raw as string) as { success: boolean };
		const unchanged = await readMemory(record.id);

		expect(parsed).toMatchObject({ success: true });
		expect(unchanged.metadata.qValue).toBeUndefined();
	});

	test('submit_council_verdicts returns tool synthesis only; A.4 reward is hook-owned', async () => {
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const record = await seedRecall('session-council');
		await seedCouncilLaunch(tmpDir, '1.1', 'session-council');

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
			memoryReward?: unknown;
		};
		const unchanged = await readMemory(record.id);

		expect(parsed).toMatchObject({ success: true });
		expect(parsed.memoryReward).toBeUndefined();
		expect(unchanged.metadata.qValue).toBeUndefined();
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
