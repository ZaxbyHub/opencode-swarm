import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_QLEARNING_CONFIG } from '../../../src/memory/config';
import { LocalJsonlMemoryProvider } from '../../../src/memory/local-jsonl-provider';
import { buildMemoryMaintenanceReport } from '../../../src/memory/maintenance';
import {
	computeMemoryContentHash,
	createMemoryId,
} from '../../../src/memory/schema';
import type { MemoryRecord } from '../../../src/memory/types';

// A.7: buildMemoryMaintenanceReport gains lowQValueMemories / promotionCandidates,
// driven by MemoryRecallUsageEvent-derived retrieval counts and metadata.qValue.

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-qlearning-')),
	);
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRecord(
	text: string,
	options: {
		confidence?: number;
		createdDaysAgo?: number;
		qValue?: number;
	} = {},
): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'project_fact' as const,
		text,
	};
	const createdDaysAgo = options.createdDaysAgo ?? 0;
	const created = new Date(
		Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000,
	).toISOString();
	return {
		id: createMemoryId(base),
		scope: base.scope,
		kind: base.kind,
		text,
		tags: [],
		confidence: options.confidence ?? 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'src/x.ts' },
		createdAt: created,
		updatedAt: created,
		contentHash: computeMemoryContentHash(base),
		metadata: options.qValue === undefined ? {} : { qValue: options.qValue },
	};
}

/** Record `count` recall events for `memoryId` so usageByMemory.count === count. */
async function recallTimes(
	provider: LocalJsonlMemoryProvider,
	record: MemoryRecord,
	count: number,
): Promise<void> {
	for (let i = 0; i < count; i++) {
		await provider.recordRecallUsage({
			bundleId: `bundle_${record.id}_${i}`,
			query: 'q-learning maintenance test',
			scopes: [record.scope],
			memoryIds: [record.id],
			scores: [0.8],
			tokenEstimate: 50,
			agentRole: 'coder',
			runId: `run-${i}`,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
		});
	}
}

describe('buildMemoryMaintenanceReport — lowQValueMemories (A.7)', () => {
	test('memory with qValue below suppressionThreshold (0.1 < 0.15) is flagged', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const lowQ = makeRecord('Low learned-utility memory.', { qValue: 0.1 });
		await provider.upsert(lowQ);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.lowQValueMemories.map((m) => m.id)).toContain(lowQ.id);
	});

	test('neutral memory (no qValue, defaults to 0.5) is NOT flagged', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const neutral = makeRecord('Neutral learned-utility memory.');
		await provider.upsert(neutral);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.lowQValueMemories.map((m) => m.id)).not.toContain(neutral.id);
	});

	test('lowQValueMemories is distinct from lowUtilityMemories (different axes)', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		// High confidence + freshly created => high importance => NOT lowUtility,
		// but a suppressed qValue => IS lowQValueMemories.
		const lowQHighImportance = makeRecord(
			'High-importance memory with suppressed learned utility.',
			{ confidence: 0.95, createdDaysAgo: 0, qValue: 0.05 },
		);
		// Low confidence + very stale + never recalled => IS lowUtility, but a
		// neutral (default) qValue => NOT lowQValueMemories.
		const lowUtilityHighQ = makeRecord(
			'Stale low-confidence memory with neutral learned utility.',
			{ confidence: 0.1, createdDaysAgo: 200 },
		);
		await provider.upsert(lowQHighImportance);
		await provider.upsert(lowUtilityHighQ);

		const report = await buildMemoryMaintenanceReport(provider, {});

		const lowQIds = report.lowQValueMemories.map((m) => m.id);
		const lowUtilIds = report.lowUtilityMemories.map((m) => m.id);

		expect(lowQIds).toContain(lowQHighImportance.id);
		expect(lowUtilIds).not.toContain(lowQHighImportance.id);

		expect(lowUtilIds).toContain(lowUtilityHighQ.id);
		expect(lowQIds).not.toContain(lowUtilityHighQ.id);
	});

	test('boundary: qValue exactly at suppressionThreshold (0.15) is NOT suppressed (strict <)', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const atThreshold = makeRecord('Exactly at the suppression threshold.', {
			qValue: 0.15,
		});
		await provider.upsert(atThreshold);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.lowQValueMemories.map((m) => m.id)).not.toContain(
			atThreshold.id,
		);
	});
});

describe('buildMemoryMaintenanceReport — promotionCandidates (A.7, SC-008 both-conditions)', () => {
	test('high qValue (>0.85) AND recalled more than 5 times IS a candidate', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const candidate = makeRecord('Frequently recalled high-utility memory.', {
			qValue: 0.9,
		});
		await provider.upsert(candidate);
		await recallTimes(provider, candidate, 6);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.promotionCandidates.map((m) => m.id)).toContain(candidate.id);
	});

	test('high qValue (0.9) but recalled only 3 times (<=5) is NOT a candidate', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const notEnoughRecalls = makeRecord(
			'High-utility memory recalled too rarely.',
			{ qValue: 0.9 },
		);
		await provider.upsert(notEnoughRecalls);
		await recallTimes(provider, notEnoughRecalls, 3);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.promotionCandidates.map((m) => m.id)).not.toContain(
			notEnoughRecalls.id,
		);
	});

	test('qValue 0.6 (<=0.85) but recalled 10 times is NOT a candidate', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const notHighEnoughQ = makeRecord(
			'Frequently recalled but only moderately useful memory.',
			{ qValue: 0.6 },
		);
		await provider.upsert(notHighEnoughQ);
		await recallTimes(provider, notHighEnoughQ, 10);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.promotionCandidates.map((m) => m.id)).not.toContain(
			notHighEnoughQ.id,
		);
	});

	test('boundary: qValue exactly 0.85 (not >0.85) with 6 recalls is NOT a candidate (strict >)', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const atThreshold = makeRecord(
			'Exactly at the promotion q-value threshold.',
			{
				qValue: 0.85,
			},
		);
		await provider.upsert(atThreshold);
		await recallTimes(provider, atThreshold, 6);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.promotionCandidates.map((m) => m.id)).not.toContain(
			atThreshold.id,
		);
	});

	test('boundary: qValue 0.9 with exactly 5 recalls (not >5) is NOT a candidate (strict >)', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const atThreshold = makeRecord(
			'High-utility memory recalled exactly the minimum count.',
			{ qValue: 0.9 },
		);
		await provider.upsert(atThreshold);
		await recallTimes(provider, atThreshold, 5);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.promotionCandidates.map((m) => m.id)).not.toContain(
			atThreshold.id,
		);
	});
});

describe('buildMemoryMaintenanceReport — qLearning config override (A.7)', () => {
	test('custom suppressionThreshold changes which memories qualify as low-Q', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const midQ = makeRecord('Mid-range learned utility memory.', {
			qValue: 0.3,
		});
		await provider.upsert(midQ);

		const defaultReport = await buildMemoryMaintenanceReport(provider, {});
		expect(defaultReport.lowQValueMemories.map((m) => m.id)).not.toContain(
			midQ.id,
		);

		const overriddenReport = await buildMemoryMaintenanceReport(provider, {
			qLearning: { ...DEFAULT_QLEARNING_CONFIG, suppressionThreshold: 0.4 },
		});
		expect(overriddenReport.lowQValueMemories.map((m) => m.id)).toContain(
			midQ.id,
		);
	});

	test('custom promotionThreshold/promotionMinRetrievals changes promotion candidates', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const modest = makeRecord(
			'Modestly useful, occasionally recalled memory.',
			{
				qValue: 0.5,
			},
		);
		await provider.upsert(modest);
		await recallTimes(provider, modest, 2);

		const defaultReport = await buildMemoryMaintenanceReport(provider, {});
		expect(defaultReport.promotionCandidates.map((m) => m.id)).not.toContain(
			modest.id,
		);

		const relaxedReport = await buildMemoryMaintenanceReport(provider, {
			qLearning: {
				...DEFAULT_QLEARNING_CONFIG,
				promotionThreshold: 0.4,
				promotionMinRetrievals: 1,
			},
		});
		expect(relaxedReport.promotionCandidates.map((m) => m.id)).toContain(
			modest.id,
		);
	});
});

describe('buildMemoryMaintenanceReport — defaults (A.7)', () => {
	test('omitting options.qLearning applies DEFAULT_QLEARNING_CONFIG thresholds', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		// Just inside the default suppression threshold (0.15).
		const lowQ = makeRecord('Just below the default suppression threshold.', {
			qValue: 0.14,
		});
		// Just inside the default promotion threshold (0.85), recalled enough
		// times to cross the default promotionMinRetrievals (5).
		const promotable = makeRecord(
			'Just above the default promotion threshold, recalled enough.',
			{ qValue: 0.86 },
		);
		await provider.upsert(lowQ);
		await provider.upsert(promotable);
		await recallTimes(provider, promotable, 6);

		const report = await buildMemoryMaintenanceReport(provider, {});

		expect(report.lowQValueMemories.map((m) => m.id)).toContain(lowQ.id);
		expect(report.promotionCandidates.map((m) => m.id)).toContain(
			promotable.id,
		);
	});

	test('report field shape is preserved (arrays of MemoryRecord)', async () => {
		const provider = new LocalJsonlMemoryProvider(tmpDir, { enabled: true });
		const report = await buildMemoryMaintenanceReport(provider, {});
		expect(Array.isArray(report.lowQValueMemories)).toBe(true);
		expect(Array.isArray(report.promotionCandidates)).toBe(true);
	});
});
