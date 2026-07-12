import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readCuratorSummary,
	writeCuratorSummary,
} from '../../../src/hooks/curator.js';
import type { CuratorSummary } from '../../../src/hooks/curator-types.js';
import {
	_internals,
	createHivePromoterHook,
	type HivePromotionSummary,
} from '../../../src/hooks/hive-promoter.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const config = {
	enabled: true,
	hive_enabled: true,
} as KnowledgeConfig;

function summary(
	recommendations: CuratorSummary['knowledge_recommendations'] = [],
): CuratorSummary {
	return {
		schema_version: 1,
		session_id: 'hive-hook-test',
		last_updated: '2026-07-10T00:00:00.000Z',
		last_phase_covered: 0,
		digest: 'digest',
		phase_digests: [],
		compliance_observations: [],
		knowledge_recommendations: recommendations,
	};
}

function promotion(
	overrides: Partial<HivePromotionSummary> = {},
): HivePromotionSummary {
	return {
		timestamp: new Date().toISOString(),
		new_promotions: 0,
		encounters_incremented: 0,
		advancements: 0,
		total_hive_entries: 5,
		...overrides,
	};
}

describe('hive promoter recommendations — regression: issue #1769', () => {
	let directory: string;
	let cleanup: () => void;
	const realReadEntries = _internals.readSwarmEntries;
	const realCheck = _internals.checkHivePromotions;
	const realReadSummary = _internals.readCuratorSummary;
	const realAppend = _internals.appendCuratorRecommendation;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('hive-recs-'));
		_internals.readSwarmEntries = mock(async () => []);
		_internals.readCuratorSummary = readCuratorSummary;
		_internals.appendCuratorRecommendation = realAppend;
	});

	afterEach(() => {
		_internals.readSwarmEntries = realReadEntries;
		_internals.checkHivePromotions = realCheck;
		_internals.readCuratorSummary = realReadSummary;
		_internals.appendCuratorRecommendation = realAppend;
		cleanup();
	});

	test('zero activity adds no recommendation but still migrates a bloated summary', async () => {
		const duplicate = {
			action: 'promote' as const,
			lesson:
				'Hive promotion: 0 new, 0 encounters, 0 advancements, 5 total entries',
			reason: JSON.stringify({ timestamp: '2026-07-10T00:00:00.000Z' }),
		};
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'curator-summary.json'),
			JSON.stringify(
				summary(Array.from({ length: 500 }, () => ({ ...duplicate }))),
			),
		);
		_internals.checkHivePromotions = mock(async () => promotion());

		await createHivePromoterHook(directory, config)({}, {});

		const loaded = await readCuratorSummary(directory);
		expect(loaded?.knowledge_recommendations).toHaveLength(1);
	});

	test('total hive entries alone is ambient state, not recommendation activity', async () => {
		await writeCuratorSummary(directory, summary());
		_internals.checkHivePromotions = mock(async () =>
			promotion({ total_hive_entries: 999 }),
		);

		await createHivePromoterHook(directory, config)({}, {});

		expect(
			(await readCuratorSummary(directory))?.knowledge_recommendations,
		).toEqual([]);
	});

	test('repeated semantic activity keeps one newest recommendation', async () => {
		await writeCuratorSummary(directory, summary());
		let invocation = 0;
		_internals.checkHivePromotions = mock(async () =>
			promotion({
				timestamp: `2026-07-10T00:00:0${invocation++}.000Z`,
				new_promotions: 1,
				total_hive_entries: 1,
			}),
		);
		const hook = createHivePromoterHook(directory, config);

		await hook({}, {});
		await hook({}, {});

		const recommendations = (await readCuratorSummary(directory))
			?.knowledge_recommendations;
		expect(recommendations).toHaveLength(1);
		expect(JSON.parse(recommendations?.[0].reason ?? '{}').timestamp).toBe(
			'2026-07-10T00:00:01.000Z',
		);
	});

	test('active promotion does not create a curator summary when none exists', async () => {
		_internals.checkHivePromotions = mock(async () =>
			promotion({ new_promotions: 1 }),
		);

		await createHivePromoterHook(directory, config)({}, {});

		expect(
			fs.existsSync(path.join(directory, '.swarm', 'curator-summary.json')),
		).toBe(false);
	});
});
