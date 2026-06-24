import { describe, expect, test } from 'bun:test';
import { buildMemoryMaintenanceReport } from '../../../src/memory/maintenance';
import type { MemoryProvider } from '../../../src/memory/provider';
import {
	computeMemoryContentHash,
	createMemoryId,
} from '../../../src/memory/schema';
import type { MemoryListFilter, MemoryRecord } from '../../../src/memory/types';

const DAY = 24 * 60 * 60 * 1000;

function makeRecord(
	text: string,
	confidence: number,
	createdDaysAgo: number,
): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'project_fact' as const,
		text,
	};
	const created = new Date(Date.now() - createdDaysAgo * DAY).toISOString();
	return {
		id: createMemoryId(base),
		scope: base.scope,
		kind: base.kind,
		text,
		tags: [],
		confidence,
		stability: 'durable',
		source: { type: 'file', filePath: 'src/x.ts' },
		createdAt: created,
		updatedAt: created,
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

function fakeProvider(records: MemoryRecord[]): MemoryProvider {
	return {
		name: 'fake',
		async upsert(r) {
			return r;
		},
		async get() {
			return null;
		},
		async delete() {},
		async recall() {
			return [];
		},
		async list(_filter: MemoryListFilter) {
			return records;
		},
	};
}

describe('maintenance low-utility via importance (DD-11)', () => {
	test('high-confidence, never-recalled, aged memory is NOT flagged low-utility', async () => {
		const highConfOld = makeRecord(
			'The build pipeline runs bun test per file.',
			0.9,
			60,
		);
		const report = await buildMemoryMaintenanceReport(
			fakeProvider([highConfOld]),
			{},
		);
		const ids = report.lowUtilityMemories.map((m) => m.id);
		expect(ids).not.toContain(highConfOld.id);
	});

	test('low-confidence, stale, never-recalled memory IS flagged low-utility', async () => {
		const lowConfStale = makeRecord(
			'A vague unverified note about something.',
			0.1,
			200,
		);
		const report = await buildMemoryMaintenanceReport(
			fakeProvider([lowConfStale]),
			{},
		);
		const ids = report.lowUtilityMemories.map((m) => m.id);
		expect(ids).toContain(lowConfStale.id);
	});

	test('report field shape is preserved (lowUtilityMemories is a MemoryRecord[])', async () => {
		const report = await buildMemoryMaintenanceReport(fakeProvider([]), {});
		expect(Array.isArray(report.lowUtilityMemories)).toBe(true);
	});
});
