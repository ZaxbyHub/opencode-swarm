/**
 * Epic v2 C5 — the sizing dry-run (`computeEpicSizing`, `/swarm epic
 * start`) runs the component planner with the SAME planning signals as
 * `epic_next_wave` (`loadEpicPlanningSignals`): learned hot files and
 * co-writes, co-change and the density threshold all change the serial
 * step count L.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../../../src/config/schema';
import { emptyEpicLearning } from '../../../src/epic/learning';
import type { EpicLearningView } from '../../../src/epic/learning-store';
import {
	type EpicPlanningSignals,
	loadEpicPlanningSignals,
} from '../../../src/epic/planning-signals';
import {
	computeEpicSizing,
	_internals as startInternals,
} from '../../../src/epic/start';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer';
import { phasePlan, type TaskSpec } from './next-wave-fixture';

const realStart = { ...startInternals };

afterEach(() => {
	Object.assign(startInternals, realStart);
});

const NO_SIGNALS: EpicPlanningSignals = {
	hotFiles: [],
	coWrites: null,
	cochange: null,
	densityThreshold: 0.3,
};

function entry(fileA: string, fileB: string): CoChangeEntry {
	return {
		fileA,
		fileB,
		npmi: 0.9,
		coChangeCount: 9,
		lift: 0,
		hasStaticEdge: false,
		totalCommits: 0,
		commitsA: 0,
		commitsB: 0,
	};
}

function sizing(
	phases: TaskSpec[][],
	signals: EpicPlanningSignals,
	maxParallel = 4,
) {
	startInternals.resolveEpicDeclaredScopes = (() => ({})) as never;
	return computeEpicSizing(
		'/project',
		phasePlan(phases),
		{} as PluginConfig,
		maxParallel,
		signals,
	);
}

const SIX = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'].map((id) => ({ id }));

describe('computeEpicSizing — component planner dry-run', () => {
	test('6 disjoint tasks, width 4 ⇒ 2 serial steps; per phase, summed', () => {
		expect(sizing([SIX], NO_SIGNALS).serialSteps).toBe(2);
		expect(
			sizing(
				[
					[{ id: '1.1' }, { id: '1.2' }],
					[{ id: '2.1', depends: ['1.1'] }, { id: '2.2' }],
				],
				NO_SIGNALS,
			).serialSteps,
		).toBe(2);
	});

	test('a hub cluster serializes only within itself', () => {
		const hub = (id: string) => ({ id, files: ['src/hub.ts', `src/${id}.ts`] });
		const verdict = sizing(
			[[hub('1.1'), hub('1.2'), hub('1.3'), { id: '1.4' }, { id: '1.5' }]],
			NO_SIGNALS,
		);
		expect(verdict.serialSteps).toBe(3);
	});

	test('co-change edges (same signal as epic_next_wave) serialize the plan', () => {
		const files = SIX.map((t) => `src/t${t.id.replace('.', '_')}.ts`);
		const pairs = files.flatMap((a, i) =>
			files.slice(i + 1).map((b) => entry(a, b)),
		);
		const verdict = sizing([SIX], {
			...NO_SIGNALS,
			cochange: { pairs, threshold: { npmi: 0.6, minCoChanges: 5 } },
		});
		expect(verdict.serialSteps).toBe(6);
		expect(verdict.reasons).toContain('insufficient-parallelism');
	});

	test('hot files make tasks exclusive (one step each)', () => {
		expect(
			sizing([SIX], {
				...NO_SIGNALS,
				hotFiles: ['src/t1_1.ts', 'src/t1_2.ts'],
			}).serialSteps,
		).toBe(3);
	});

	test('learned co-writes add conflict edges (expanded scopes)', () => {
		// 1.1 was learned to co-write 1.2's file: they conflict (a 2-task
		// component of density 1 ⇒ serial), so at width 6 the six otherwise
		// disjoint tasks need 2 steps instead of 1.
		const coWrites = new Map([['src/t1_1.ts', new Map([['src/t1_2.ts', 1]])]]);
		expect(sizing([SIX], { ...NO_SIGNALS, coWrites }, 6).serialSteps).toBe(2);
		expect(sizing([SIX], NO_SIGNALS, 6).serialSteps).toBe(1);
	});

	test('the density threshold decides serial components', () => {
		// Chain 1.1—1.2—1.3: d = 2/3. Serial at 0.3 (3 steps); parallel at
		// 0.7, so the non-adjacent ends share a wave (2 steps).
		const chain: TaskSpec[] = [
			{ id: '1.1', files: ['src/a.ts'] },
			{ id: '1.2', files: ['src/a.ts', 'src/b.ts'] },
			{ id: '1.3', files: ['src/b.ts'] },
		];
		expect(sizing([chain], NO_SIGNALS).serialSteps).toBe(3);
		expect(
			sizing([chain], { ...NO_SIGNALS, densityThreshold: 0.7 }).serialSteps,
		).toBe(2);
	});

	test('completed and closed tasks are not planned; a cycle counts per task', () => {
		const verdict = sizing(
			[
				[
					{ id: '1.1', status: 'completed' },
					{ id: '1.2', status: 'closed' },
					{ id: '1.3', depends: ['1.4'] },
					{ id: '1.4', depends: ['1.3'] },
					{ id: '1.5' },
				],
			],
			NO_SIGNALS,
		);
		expect(verdict.pendingTasks).toBe(3);
		expect(verdict.serialSteps).toBe(3);
	});
});

describe('loadEpicPlanningSignals', () => {
	const learned = (): EpicLearningView => {
		const stats = emptyEpicLearning();
		stats.files.set('src/hot.ts', { alpha: 2, beta: 0 });
		stats.files.set('src/cold.ts', { alpha: 0, beta: 9 });
		stats.edges.set('src/a.ts', new Map([['src/b.ts', 1]]));
		return { source: 'prior', stats };
	};
	const calls: Array<{ epic: unknown; now: number }> = [];
	const sources = {
		loadLearningView: (
			_directory: string,
			epic: unknown,
			_settings: unknown,
			now: number,
		) => {
			calls.push({ epic, now });
			return learned();
		},
		getCoChangeData: async () => ({
			pairs: [entry('src/a.ts', 'src/b.ts')],
			commitsObserved: 30,
		}),
		now: () => 1234,
	};

	test('defaults: learning on (hot files + co-writes), co-change off, threshold 0.3', async () => {
		calls.length = 0;
		const epic = { epicKey: 'k', token: 't' };
		const signals = await loadEpicPlanningSignals('/p', {}, sources, epic);
		expect(signals.hotFiles).toEqual(['src/hot.ts']);
		expect(signals.coWrites?.get('src/a.ts')?.get('src/b.ts')).toBe(1);
		expect(signals.cochange).toBeNull();
		expect(signals.densityThreshold).toBe(0.3);
		// The open epic's identity and the injected clock reach the source.
		expect(calls).toEqual([{ epic, now: 1234 }]);
	});

	test('config: co-change on with its thresholds, learning off, threshold', async () => {
		calls.length = 0;
		const config = {
			epic: {
				mode: { enabled: true, activation_threshold: 0.6 },
				cochange: { enabled: true, threshold: 0.7, min_co_changes: 4 },
				learning: { enabled: false },
			},
		} as unknown as PluginConfig;
		expect(await loadEpicPlanningSignals('/p', config, sources, null)).toEqual({
			hotFiles: [],
			coWrites: null,
			cochange: {
				pairs: [entry('src/a.ts', 'src/b.ts')],
				threshold: { npmi: 0.7, minCoChanges: 4 },
			},
			densityThreshold: 0.6,
		});
		// Learning off ⇒ the learning source is never read.
		expect(calls).toEqual([]);
	});

	test('hot_excess decides which files are hot', async () => {
		const config = {
			epic: { learning: { hot_excess: 0.9 } },
		} as unknown as PluginConfig;
		expect(
			(await loadEpicPlanningSignals('/p', config, sources, null)).hotFiles,
		).toEqual([]);
	});

	test('a failed source degrades to no signal', async () => {
		const config = {
			epic: { cochange: { enabled: true } },
		} as unknown as PluginConfig;
		const signals = await loadEpicPlanningSignals(
			'/p',
			config,
			{
				loadLearningView: () => {
					throw new Error('unreadable');
				},
				getCoChangeData: async () => {
					throw new Error('git failed');
				},
				now: () => 0,
			},
			null,
		);
		expect(signals).toEqual({
			hotFiles: [],
			coWrites: null,
			cochange: null,
			densityThreshold: 0.3,
		});
	});
});
