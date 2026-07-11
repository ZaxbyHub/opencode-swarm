import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	appendCuratorRecommendation,
	mergeCuratorPhaseSummary,
	readCuratorSummary,
	writeCuratorSummary,
} from '../../../src/hooks/curator.js';
import type {
	CuratorSummary,
	KnowledgeRecommendation,
} from '../../../src/hooks/curator-types.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

function summary(
	recommendations: KnowledgeRecommendation[] = [],
): CuratorSummary {
	return {
		schema_version: 1,
		session_id: 'recommendation-test',
		last_updated: '2026-07-10T00:00:00.000Z',
		last_phase_covered: 0,
		digest: 'preserve-this-digest',
		phase_digests: [],
		compliance_observations: [],
		knowledge_recommendations: recommendations,
	};
}

function recommendation(index: number): KnowledgeRecommendation {
	return {
		action: 'rewrite',
		entry_id: `entry-${index}`,
		lesson: `lesson-${index}`,
		reason: `reason-${index}`,
	};
}

function rawWrite(directory: string, value: unknown): void {
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'curator-summary.json'),
		JSON.stringify(value, null, 2),
	);
}

describe('curator recommendation persistence — regression: issue #1769', () => {
	let directory: string;
	let cleanup: () => void;
	const realWriteState = _internals.writeCuratorSummaryState;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('curator-recs-'));
		_internals.writeCuratorSummaryState = realWriteState;
	});

	afterEach(() => {
		_internals.writeCuratorSummaryState = realWriteState;
		cleanup();
	});

	test('direct writes enforce the newest 200 unique recommendations', async () => {
		await writeCuratorSummary(
			directory,
			summary(Array.from({ length: 205 }, (_, index) => recommendation(index))),
		);

		const persisted = await readCuratorSummary(directory);
		expect(persisted?.knowledge_recommendations).toHaveLength(200);
		expect(persisted?.knowledge_recommendations[0].entry_id).toBe('entry-5');
		expect(persisted?.knowledge_recommendations.at(-1)?.entry_id).toBe(
			'entry-204',
		);
	});

	test('first read deduplicates before capping and persists the newest hive records', async () => {
		const flooded = Array.from({ length: 5_104 }, (_, index) => {
			const kind = index % 5;
			return {
				action: 'promote' as const,
				lesson: `Hive promotion: ${kind} new, 0 encounters, 0 advancements, 5 total entries`,
				reason: JSON.stringify({
					timestamp: `2026-07-10T00:00:${String(index).padStart(4, '0')}Z`,
					new_promotions: kind,
					encounters_incremented: 0,
					advancements: 0,
					total_hive_entries: 5,
				}),
			};
		});
		rawWrite(directory, summary(flooded));

		const loaded = await readCuratorSummary(directory);
		expect(loaded?.knowledge_recommendations).toHaveLength(5);
		const persisted = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'curator-summary.json'),
				'utf-8',
			),
		) as CuratorSummary;
		expect(persisted.knowledge_recommendations).toHaveLength(5);
		expect(persisted.digest).toBe('preserve-this-digest');
	});

	test('canonical key ordering deduplicates equivalents but preserves distinct same-target directives', async () => {
		const first = {
			action: 'rewrite' as const,
			entry_id: 'shared-entry',
			lesson: 'same lesson',
			reason: 'same reason',
			triggers: ['one'],
		};
		const reordered = {
			triggers: ['one'],
			reason: 'same reason',
			lesson: 'same lesson',
			entry_id: 'shared-entry',
			action: 'rewrite' as const,
		};
		const distinct = { ...first, reason: 'different reason' };
		await writeCuratorSummary(directory, summary([first, reordered, distinct]));

		const loaded = await readCuratorSummary(directory);
		expect(loaded?.knowledge_recommendations).toHaveLength(2);
		expect(
			loaded?.knowledge_recommendations.map((entry) => entry.reason),
		).toEqual(['same reason', 'different reason']);
	});

	test('newest-wins duplicate replacement returns true and persists the newest representative', async () => {
		const hive = (timestamp: string): KnowledgeRecommendation => ({
			action: 'promote',
			lesson:
				'Hive promotion: 1 new, 0 encounters, 0 advancements, 1 total entries',
			reason: JSON.stringify({
				timestamp,
				new_promotions: 1,
				encounters_incremented: 0,
				advancements: 0,
				total_hive_entries: 1,
			}),
		});
		await writeCuratorSummary(
			directory,
			summary([hive('2026-07-10T00:00:00Z')]),
		);

		const changed = await appendCuratorRecommendation(
			directory,
			hive('2026-07-10T01:00:00Z'),
		);

		expect(changed).toBe(true);
		const loaded = await readCuratorSummary(directory);
		expect(loaded?.knowledge_recommendations).toHaveLength(1);
		expect(loaded?.knowledge_recommendations[0].reason).toContain(
			'2026-07-10T01:00:00Z',
		);
	});

	test('already-normalized reads do not rewrite the file', async () => {
		await writeCuratorSummary(directory, summary([recommendation(1)]));
		const writeState = mock(realWriteState);
		_internals.writeCuratorSummaryState = writeState;

		const loaded = await readCuratorSummary(directory);
		expect(loaded?.knowledge_recommendations).toHaveLength(1);
		expect(writeState).not.toHaveBeenCalled();
	});

	test('missing or non-array containers normalize non-destructively', async () => {
		rawWrite(directory, { ...summary(), knowledge_recommendations: null });
		const loaded = await readCuratorSummary(directory);
		expect(loaded?.knowledge_recommendations).toEqual([]);
		expect(loaded?.digest).toBe('preserve-this-digest');
	});

	test('migration write failure returns normalized state and leaves the original file', async () => {
		const duplicate = recommendation(1);
		rawWrite(directory, summary([duplicate, { ...duplicate }]));
		_internals.writeCuratorSummaryState = mock(async () => {
			throw new Error('simulated read-only filesystem');
		});

		const loaded = await readCuratorSummary(directory);
		expect(loaded?.knowledge_recommendations).toHaveLength(1);
		const raw = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'curator-summary.json'),
				'utf-8',
			),
		) as CuratorSummary;
		expect(raw.knowledge_recommendations).toHaveLength(2);
	});

	test('direct writes still report an inaccessible summary directory', async () => {
		fs.writeFileSync(path.join(directory, '.swarm'), 'blocking file');

		await expect(writeCuratorSummary(directory, summary())).rejects.toThrow(
			'Failed to persist curator summary',
		);
	});

	test('concurrent appends preserve every unique recommendation and deduplicate equivalents', async () => {
		await writeCuratorSummary(directory, summary());
		await Promise.all([
			...Array.from({ length: 3 }, (_, index) =>
				appendCuratorRecommendation(directory, recommendation(index)),
			),
			appendCuratorRecommendation(directory, { ...recommendation(1) }),
		]);

		const loaded = await readCuratorSummary(directory);
		expect(loaded?.knowledge_recommendations).toHaveLength(3);
		expect(
			loaded?.knowledge_recommendations.map((entry) => entry.entry_id),
		).toEqual(expect.arrayContaining(['entry-0', 'entry-2']));
	});

	test('a concurrent phase merge and hive append both survive', async () => {
		await writeCuratorSummary(directory, summary());
		const hive = {
			action: 'promote' as const,
			lesson:
				'Hive promotion: 1 new, 0 encounters, 0 advancements, 1 total entries',
			reason: JSON.stringify({ timestamp: new Date().toISOString() }),
		};
		await Promise.all([
			appendCuratorRecommendation(directory, hive),
			mergeCuratorPhaseSummary(directory, {
				phase: 1,
				phaseDigest: {
					phase: 1,
					timestamp: '2026-07-10T01:00:00.000Z',
					summary: 'phase one',
					agents_used: [],
					tasks_completed: 1,
					tasks_total: 1,
					key_decisions: [],
					blockers_resolved: [],
				},
				complianceObservations: [],
				knowledgeRecommendations: [recommendation(99)],
				sessionId: 'phase-session',
				timestamp: '2026-07-10T01:00:00.000Z',
			}),
		]);

		const loaded = await readCuratorSummary(directory);
		expect(loaded?.phase_digests.map((entry) => entry.phase)).toEqual([1]);
		expect(
			loaded?.knowledge_recommendations.map((entry) => entry.lesson),
		).toEqual(expect.arrayContaining([hive.lesson, 'lesson-99']));
	});
});
