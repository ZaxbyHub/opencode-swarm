/**
 * Epic v2 C6 — learning persistence (`src/epic/learning-store.ts`):
 *   - posterior: start copy of the prior, idempotent per closed wave (never
 *     double-counted), caught up after a lost update, rebuilt when foreign;
 *   - close merge: prior := decay_per_epic × prior ⊕ increments, once per
 *     epic instance, posterior removed; nothing written for a non-learning
 *     epic; an unreadable prior is never overwritten;
 *   - planning view: posterior of the open epic instance, else the prior
 *     decayed by age;
 *   - reset keeps the v1 import marker; the v1 import runs once.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	DEFAULT_EPIC_LEARNING_SETTINGS,
	type EpicLearningSettings,
	epicHotFiles,
} from '../../../src/epic/learning';
import {
	applyClosedWavesToPosterior,
	describeEpicPriorMerge,
	EPIC_POSTERIOR_RELATIVE_PATH,
	EPIC_PRIOR_LEARNING_RELATIVE_PATH,
	importLegacyEpicCalibrationOnce,
	initEpicPosterior,
	loadEpicLearningView,
	mergeEpicPosteriorIntoPrior,
	readEpicPosterior,
	readEpicPrior,
	resetEpicPrior,
} from '../../../src/epic/learning-store';
import {
	type EpicRecordV1,
	type EpicTaskOutcome,
	type EpicWaveRecord,
	parseEpicRecord,
} from '../../../src/epic/lifecycle';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ON: EpicLearningSettings = { ...DEFAULT_EPIC_LEARNING_SETTINGS };
let dir: string;

function closedWave(seq: number): EpicWaveRecord {
	return {
		seq,
		phase: 1,
		kind: 'parallel',
		taskIds: [`1.${seq}`],
		files: {},
		cochange: null,
		baseHead: null,
		issuedAt: '2026-10-01T00:00:00.000Z',
		status: 'closed',
	};
}

function outcome(
	taskId: string,
	waveSeq: number,
	overrides: Partial<EpicTaskOutcome> = {},
): EpicTaskOutcome {
	return {
		taskId,
		phase: 1,
		waveSeq,
		resolution: 'completed',
		resolvedAt: '2026-10-01T00:00:00.000Z',
		generation: 1,
		stageAFailures: 0,
		stageBFailures: 0,
		mergeFailure: null,
		declared: ['src/a.ts'],
		undeclared: [],
		attribution: 'session',
		reopened: 0,
		marker: null,
		...overrides,
	};
}

/** An epic whose waves 1..n are closed; wave 1's task co-wrote src/b.ts. */
function epicWithWaves(n: number, token = 'tok-1'): EpicRecordV1 {
	const tasks: Record<string, EpicTaskOutcome> = {};
	for (let seq = 1; seq <= n; seq += 1) {
		tasks[`1.${seq}`] = outcome(
			`1.${seq}`,
			seq,
			seq === 1 ? { undeclared: ['src/b.ts'] } : { declared: ['src/c.ts'] },
		);
	}
	return stubEpicRecord({
		token,
		waves: Array.from({ length: n }, (_, i) => closedWave(i + 1)),
		tasks,
	});
}

function seedPrior(alphaB: number, updatedAt = '2026-10-01T00:00:00.000Z') {
	const target = path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(
		target,
		JSON.stringify({
			schema: 'epic-learning-v1',
			updatedAt,
			importedFrom: null,
			mergedEpics: [],
			files: [{ path: 'src/b.ts', alpha: alphaB, beta: 0 }],
			edges: [{ from: 'src/a.ts', to: 'src/b.ts', weight: alphaB }],
		}),
	);
}

beforeEach(() => {
	dir = canonicalMkdtemp('epic-learning-store-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('posterior', () => {
	test('start copies the prior; each closed wave applies exactly once', () => {
		seedPrior(2);
		const prior = readEpicPrior(dir);
		const record = { ...epicWithWaves(1), priorDigest: prior.digest };
		initEpicPosterior(dir, record, prior);
		expect(readEpicPosterior(dir)?.base.stats.files.get('src/b.ts')).toEqual({
			alpha: 2,
			beta: 0,
		});
		expect(applyClosedWavesToPosterior(dir, record, ON).appliedWaves).toEqual([
			1,
		]);
		// Idempotent: the same wave never counts twice.
		expect(applyClosedWavesToPosterior(dir, record, ON).appliedWaves).toEqual(
			[],
		);
		const posterior = readEpicPosterior(dir);
		expect(posterior?.priorDigest).toBe(prior.digest);
		expect(posterior?.increments.files.get('src/b.ts')).toEqual({
			alpha: 1,
			beta: 0,
		});
		// A later close catches up every wave not applied yet (a lost update).
		const later = epicWithWaves(3);
		expect(applyClosedWavesToPosterior(dir, later, ON).appliedWaves).toEqual([
			2, 3,
		]);
		expect(readEpicPosterior(dir)?.increments.files.get('src/c.ts')).toEqual({
			alpha: 0,
			beta: 2,
		});
	});

	test('a rebuilt posterior stamps the digest of the prior it actually copied', () => {
		seedPrior(2);
		const digest = readEpicPrior(dir).digest;
		const record = { ...epicWithWaves(1), priorDigest: 'stale-digest' };
		applyClosedWavesToPosterior(dir, record, ON);
		expect(readEpicPosterior(dir)?.priorDigest).toBe(digest);
	});

	test('a posterior of another epic instance is rebuilt, never reused', () => {
		applyClosedWavesToPosterior(dir, epicWithWaves(1, 'old-token'), ON);
		const fresh = epicWithWaves(1, 'new-token');
		expect(applyClosedWavesToPosterior(dir, fresh, ON).appliedWaves).toEqual([
			1,
		]);
		expect(readEpicPosterior(dir)?.token).toBe('new-token');
		expect(readEpicPosterior(dir)?.increments.files.get('src/b.ts')).toEqual({
			alpha: 1,
			beta: 0,
		});
	});

	test('a reopened task re-run in a later wave adds only the delta of its counters', () => {
		const first = outcome('1.1', 1, { generation: 2, stageBFailures: 1 });
		const record1 = stubEpicRecord({
			waves: [closedWave(1)],
			tasks: { '1.1': first },
		});
		applyClosedWavesToPosterior(dir, record1, ON);
		// 1 Stage B (0.25) + rework gen 2 (0.25).
		expect(readEpicPosterior(dir)?.increments.files.get('src/a.ts')).toEqual({
			alpha: 0.5,
			beta: 1,
		});
		const record2 = stubEpicRecord({
			waves: [closedWave(1), closedWave(2)],
			tasks: {
				'1.1': outcome('1.1', 2, {
					generation: 3,
					stageBFailures: 2,
					reopened: 1,
					previous: {
						waveSeq: 1,
						generation: 2,
						stageBFailures: 1,
						reopened: 0,
					},
				}),
			},
		});
		applyClosedWavesToPosterior(dir, record2, ON);
		// + delta: Stage B 0.25 + rework 0.25 + reopen 0.5; one more exposure.
		expect(readEpicPosterior(dir)?.increments.files.get('src/a.ts')).toEqual({
			alpha: 1.5,
			beta: 2,
		});
	});

	test('a declared directory on disk is never charged or exposed (dirhot)', () => {
		fs.mkdirSync(path.join(dir, 'src', 'x'), { recursive: true });
		const record = stubEpicRecord({
			waves: [closedWave(1)],
			tasks: {
				'1.1': outcome('1.1', 1, {
					declared: ['src'],
					generation: 4,
					stageBFailures: 1,
					mergeFailure: { outcome: 'conflict', stage: 'merge' },
				}),
			},
		});
		applyClosedWavesToPosterior(dir, record, ON);
		const view = loadEpicLearningView(dir, record, ON, T0);
		expect(view.stats.files.has('src')).toBe(false);
		expect(epicHotFiles(view.stats, ON.hotExcess)).toEqual([]);
	});

	test('learning disabled: nothing written', () => {
		expect(
			applyClosedWavesToPosterior(dir, epicWithWaves(1), {
				...ON,
				enabled: false,
			}).appliedWaves,
		).toEqual([]);
		expect(fs.existsSync(path.join(dir, EPIC_POSTERIOR_RELATIVE_PATH))).toBe(
			false,
		);
	});
});

describe('planning view', () => {
	test('the open epic instance reads its posterior; otherwise the age-decayed prior', () => {
		seedPrior(2, new Date(T0 - 60 * DAY_MS).toISOString());
		const record = epicWithWaves(1);
		applyClosedWavesToPosterior(dir, record, ON);
		const open = loadEpicLearningView(dir, record, ON, T0);
		expect(open.source).toBe('posterior');
		// base α 2 halved by one half-life + increment 1.
		expect(open.stats.files.get('src/b.ts')?.alpha).toBeCloseTo(2, 10);
		const stale = loadEpicLearningView(
			dir,
			{ epicKey: record.epicKey, token: 'other' },
			ON,
			T0,
		);
		expect(stale.source).toBe('prior');
		expect(stale.stats.files.get('src/b.ts')?.alpha).toBeCloseTo(1, 10);
		expect(
			loadEpicLearningView(dir, null, { ...ON, enabled: false }, T0),
		).toMatchObject({ source: 'none' });
	});

	test('no prior: a neutral, empty view', () => {
		const view = loadEpicLearningView(dir, null, ON, T0);
		expect(view.source).toBe('none');
		expect(view.stats.files.size).toBe(0);
		expect(view.stats.edges.size).toBe(0);
	});
});

describe('close merge', () => {
	test('prior := decay × prior ⊕ increments, once per epic instance; posterior removed', () => {
		seedPrior(2);
		const record = epicWithWaves(2);
		applyClosedWavesToPosterior(dir, record, ON);
		const merged = mergeEpicPosteriorIntoPrior(dir, record, 'rk-1', ON, T0);
		expect(merged).toMatchObject({ status: 'merged', learnedEdges: 1 });
		expect(describeEpicPriorMerge(merged)).toContain('Project prior kept');
		const prior = readEpicPrior(dir);
		if (prior.status !== 'ok') throw new Error('prior missing');
		// 2 × 0.7 + 1.
		expect(prior.prior.stats.files.get('src/b.ts')?.alpha).toBeCloseTo(2.4, 10);
		expect(prior.prior.mergedEpics).toEqual(['rk-1']);
		expect(fs.existsSync(path.join(dir, EPIC_POSTERIOR_RELATIVE_PATH))).toBe(
			false,
		);
		// A resumed close never merges twice.
		expect(
			mergeEpicPosteriorIntoPrior(dir, record, 'rk-1', ON, T0).status,
		).toBe('already-merged');
		const again = readEpicPrior(dir);
		if (again.status !== 'ok') throw new Error('prior missing');
		expect(again.prior.stats.files.get('src/b.ts')?.alpha).toBeCloseTo(2.4, 10);
	});

	test('without a posterior the increments come from the record outcomes', () => {
		const merged = mergeEpicPosteriorIntoPrior(
			dir,
			epicWithWaves(1),
			'rk-2',
			ON,
			T0,
		);
		expect(merged.status).toBe('merged');
		const prior = readEpicPrior(dir);
		if (prior.status !== 'ok') throw new Error('prior missing');
		expect(prior.prior.stats.files.get('src/b.ts')?.alpha).toBe(1);
	});

	test('a single observation stays effective for a whole half-life (real elapsed time)', () => {
		mergeEpicPosteriorIntoPrior(dir, epicWithWaves(1), 'rk-1', ON, T0);
		for (const elapsed of [60_000, DAY_MS, 59 * DAY_MS]) {
			const view = loadEpicLearningView(dir, null, ON, T0 + elapsed);
			expect(view.stats.edges.get('src/a.ts')?.get('src/b.ts')).toBe(1);
		}
		const later = loadEpicLearningView(dir, null, ON, T0 + 61 * DAY_MS);
		expect(later.stats.edges.get('src/a.ts')?.get('src/b.ts')).toBe(0.5);
	});

	test('an epic that learned nothing does not decay the prior (marked merged only)', () => {
		seedPrior(2, '2026-09-01T00:00:00.000Z');
		const merged = mergeEpicPosteriorIntoPrior(
			dir,
			stubEpicRecord(),
			'rk-empty',
			ON,
			T0,
		);
		expect(merged.status).toBe('nothing-to-learn');
		const prior = readEpicPrior(dir);
		if (prior.status !== 'ok') throw new Error('prior missing');
		expect(prior.prior.stats.files.get('src/b.ts')?.alpha).toBe(2);
		expect(prior.prior.updatedAt).toBe('2026-09-01T00:00:00.000Z');
		expect(prior.prior.mergedEpics).toEqual(['rk-empty']);
	});

	test('nothing to learn and no prior: no prior file is created', () => {
		const record = stubEpicRecord();
		expect(mergeEpicPosteriorIntoPrior(dir, record, 'rk', ON, T0).status).toBe(
			'nothing-to-learn',
		);
		expect(
			fs.existsSync(path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH)),
		).toBe(false);
	});

	test('disabled ⇒ nothing merged; an unreadable prior is never overwritten', () => {
		expect(
			mergeEpicPosteriorIntoPrior(dir, epicWithWaves(1), 'rk', {
				...ON,
				enabled: false,
			}).status,
		).toBe('disabled');
		const target = path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, '{ not json');
		const merged = mergeEpicPosteriorIntoPrior(
			dir,
			epicWithWaves(1),
			'rk',
			ON,
			T0,
		);
		expect(merged.status).toBe('prior-unreadable');
		expect(describeEpicPriorMerge(merged)).toContain('/swarm epic prior reset');
		expect(fs.readFileSync(target, 'utf-8')).toBe('{ not json');
		expect(loadEpicLearningView(dir, null, ON, T0).source).toBe(
			'prior-unreadable',
		);
	});
});

describe('reset', () => {
	test('clears the statistics and keeps the import + merge markers', () => {
		seedPrior(3);
		const target = path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH);
		const raw = JSON.parse(fs.readFileSync(target, 'utf-8'));
		raw.importedFrom = {
			source: 'epic-v1-import',
			at: '2026-09-01T00:00:00.000Z',
			calibrationHotModules: 1,
			divergenceRecords: 2,
		};
		raw.mergedEpics = ['rk-0'];
		fs.writeFileSync(target, JSON.stringify(raw));
		expect(resetEpicPrior(dir, T0)).toEqual({
			status: 'reset',
			hadPrior: true,
		});
		const prior = readEpicPrior(dir);
		if (prior.status !== 'ok') throw new Error('prior missing');
		expect(prior.prior.stats.files.size).toBe(0);
		expect(prior.prior.stats.edges.size).toBe(0);
		expect(prior.prior.importedFrom?.divergenceRecords).toBe(2);
		expect(prior.prior.mergedEpics).toEqual(['rk-0']);
	});

	test('a reset of an absent or unreadable prior still suppresses any later Epic v1 import', () => {
		for (const variant of ['absent', 'unreadable'] as const) {
			fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
			fs.mkdirSync(path.join(dir, '.swarm', 'epic'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, '.swarm', 'epic', 'calibration.json'),
				JSON.stringify({ version: 1, hotModuleAdditions: ['src/hub.ts'] }),
			);
			if (variant === 'unreadable') {
				const target = path.join(dir, EPIC_PRIOR_LEARNING_RELATIVE_PATH);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, '[]');
				expect(readEpicPrior(dir).status).toBe('unreadable');
			}
			expect(resetEpicPrior(dir, T0)).toEqual({
				status: 'reset',
				hadPrior: variant === 'unreadable',
			});
			expect(importLegacyEpicCalibrationOnce(dir, T0 + 1).status).toBe(
				'already-imported',
			);
			const prior = readEpicPrior(dir);
			if (prior.status !== 'ok') throw new Error(variant);
			expect(prior.prior.stats.files.size).toBe(0);
			expect(prior.prior.importedFrom).toMatchObject({ source: 'reset' });
		}
	});
});

describe('legacy records', () => {
	test("a pre-C6 wave record's exclusive reason 'hot-module' parses as 'hot-file'", () => {
		const record = stubEpicRecord({
			waves: [
				{
					...closedWave(1),
					components: {
						byTask: { '1.1': '1.1' },
						modes: { '1.1': 'exclusive' },
						density: { '1.1': 0 },
						exclusive: { '1.1': 'hot-module' as never },
						threshold: 0.3,
						truncated: false,
					},
				},
			],
		});
		const parsed = parseEpicRecord(JSON.stringify(record));
		expect(parsed.waves[0].components?.exclusive).toEqual({
			'1.1': 'hot-file',
		});
	});
});
