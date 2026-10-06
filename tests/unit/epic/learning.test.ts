/**
 * Epic v2 C6 — the learning model (`src/epic/learning.ts`, pure):
 *   - learned scope expansion (undeclared write f by a task declaring D ⇒
 *     w(d → f) += 1; scope* adds f once Σ w ≥ 1);
 *   - the decaying excess-evidence hot set (incident weights, exposures,
 *     prior m0 = 0.1 strength 2, α ≥ 1 ∧ r − m0 > hot_excess);
 *   - neutral cold start (the critic's M6: an empty or clean history has no
 *     hot file, no expansion, so no exclusivity and no extra edges);
 *   - decay per epic and per day, cap / eviction, and `undeclaredFiles`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	boundEpicLearning,
	EPIC_LEARNING_DROP_BELOW,
	type EpicLearningStats,
	emptyEpicLearning,
	epicHotFiles,
	epicHotIncidentMass,
	epicIncidentRate,
	epicLearningFromOutcomes,
	epicTimeDecayFactor,
	expandEpicScope,
	isEpicHotFile,
	mergeEpicLearning,
	scaleEpicLearning,
	undeclaredFiles,
} from '../../../src/epic/learning';
import type { EpicTaskOutcome } from '../../../src/epic/lifecycle';
import {
	clearRetentionCapOverrides,
	setRetentionCapOverrides,
} from '../../../src/retention/caps';
import { normalizePath } from '../../../src/utils/path';

const HOT_EXCESS = 0.25;
const DAY_MS = 24 * 60 * 60 * 1000;

function outcome(overrides: Partial<EpicTaskOutcome> = {}): EpicTaskOutcome {
	return {
		taskId: '1.1',
		phase: 1,
		waveSeq: 1,
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

function edgeWeights(stats: EpicLearningStats): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [from, targets] of stats.edges) {
		for (const [to, weight] of targets) out[`${from}->${to}`] = weight;
	}
	return out;
}

afterEach(() => {
	clearRetentionCapOverrides();
});

describe('increments from outcomes', () => {
	test('undeclared write: incident on the file + a co-write edge from every declared file', () => {
		const stats = epicLearningFromOutcomes([
			outcome({
				declared: ['src/a.ts', 'src/a.test.ts'],
				undeclared: ['src/b.ts'],
			}),
		]);
		expect(stats.files.get('src/b.ts')).toEqual({ alpha: 1, beta: 0 });
		expect(stats.files.get('src/a.ts')).toEqual({ alpha: 0, beta: 1 });
		expect(edgeWeights(stats)).toEqual({
			'src/a.ts->src/b.ts': 1,
			'src/a.test.ts->src/b.ts': 1,
		});
	});

	test('incident weights: merge failure, Stage B, rework (capped), reopen', () => {
		// A merge-back failure is charged 0.5 to every declared file (the
		// merge-status registry records no conflict files).
		const mergeFailed = epicLearningFromOutcomes([
			outcome({ mergeFailure: { outcome: 'failed', stage: 'merge' } }),
		]);
		expect(mergeFailed.files.get('src/a.ts')).toEqual({ alpha: 0.5, beta: 1 });

		// 2 Stage B failures (0.5) + generation 9 ⇒ rework capped at 4 (1.0)
		// + 1 reopen (0.5) = 2.0 on every declared file.
		const rework = epicLearningFromOutcomes([
			outcome({
				declared: ['src/a.ts', 'src/b.ts'],
				stageBFailures: 2,
				generation: 9,
				reopened: 1,
			}),
		]);
		expect(rework.files.get('src/a.ts')).toEqual({ alpha: 2, beta: 1 });
		expect(rework.files.get('src/b.ts')).toEqual({ alpha: 2, beta: 1 });
	});

	test('directory entries are never charged or exposed (exact files only)', () => {
		const troubled = outcome({
			declared: ['src', 'lib/util', 'lib/util/x.ts', 'README'],
			undeclared: ['docs/n.md'],
			generation: 4,
			stageBFailures: 1,
			mergeFailure: { outcome: 'conflict', stage: 'merge' },
		});
		// `src` is a directory on disk; `lib/util` covers another path of the
		// outcome; `README` is a plain file entry.
		const stats = epicLearningFromOutcomes([troubled], {
			isDirectory: (entry) => entry === 'src',
		});
		expect(stats.files.has('src')).toBe(false);
		expect(stats.files.has('lib/util')).toBe(false);
		expect(stats.files.get('lib/util/x.ts')).toEqual({ alpha: 1.5, beta: 1 });
		// Keys are `normalizePath`d, which case-folds on win32.
		expect(stats.files.get(normalizePath('README'))).toEqual({
			alpha: 1.5,
			beta: 1,
		});
		// Co-writes are still learned from every declared entry.
		expect(edgeWeights(stats)['src->docs/n.md']).toBe(1);
		expect(epicHotFiles(stats, HOT_EXCESS)).not.toContain('src');
	});

	test('a re-run task is charged only the delta over its learned previous outcome', () => {
		const rerun = outcome({
			waveSeq: 3,
			generation: 3,
			stageBFailures: 2,
			reopened: 1,
			previous: { waveSeq: 1, generation: 2, stageBFailures: 1, reopened: 0 },
		});
		// Wave 1 already learned: delta = rework 0.25 + Stage B 0.25 + reopen 0.5.
		expect(
			epicLearningFromOutcomes([rerun], { learnedThroughWaveSeq: 2 }).files.get(
				'src/a.ts',
			),
		).toEqual({ alpha: 1, beta: 1 });
		// The previous outcome was never learned (record fallback / lost
		// update): charged in full = rework 0.5 + Stage B 0.5 + reopen 0.5.
		expect(epicLearningFromOutcomes([rerun]).files.get('src/a.ts')).toEqual({
			alpha: 1.5,
			beta: 1,
		});
		expect(
			epicLearningFromOutcomes([rerun], { learnedThroughWaveSeq: 0 }).files.get(
				'src/a.ts',
			),
		).toEqual({ alpha: 1.5, beta: 1 });
	});

	test('removed tasks teach nothing; .swarm and absolute paths are never learned', () => {
		expect(
			epicLearningFromOutcomes([
				outcome({ resolution: 'removed', undeclared: ['src/b.ts'] }),
			]).files.size,
		).toBe(0);
		const stats = epicLearningFromOutcomes([
			outcome({
				undeclared: ['.swarm/plan.json', '/etc/passwd', '../escape.ts'],
			}),
		]);
		expect([...stats.files.keys()]).toEqual(['src/a.ts']);
		expect(stats.edges.size).toBe(0);
	});
});

describe('hot set (excess evidence)', () => {
	test('neutral cold start: empty or clean history has no hot file and no expansion', () => {
		expect(epicHotFiles(emptyEpicLearning(), HOT_EXCESS)).toEqual([]);
		expect(expandEpicScope(['src/a.ts'], emptyEpicLearning().edges)).toEqual([
			'src/a.ts',
		]);
		const clean = epicLearningFromOutcomes(
			Array.from({ length: 20 }, (_, i) =>
				outcome({ taskId: `1.${i}`, declared: ['src/a.ts', 'src/hub.ts'] }),
			),
		);
		expect(epicHotFiles(clean, HOT_EXCESS)).toEqual([]);
		// The prior alone (m0 = 0.1) is never "hot".
		expect(epicIncidentRate({ alpha: 0, beta: 0 })).toBeCloseTo(0.1, 10);
	});

	test('the hot rate: α ≥ 1 and an excess over m0; clean exposures shrink it', () => {
		// α = 1, β = 0 ⇒ r = 1.2 / 3 = 0.4 ⇒ excess 0.3 > 0.25.
		expect(isEpicHotFile({ alpha: 1, beta: 0 }, HOT_EXCESS)).toBe(true);
		// Two clean exposures: r = 1.2 / 5 = 0.24 ⇒ excess 0.14 — not hot.
		expect(isEpicHotFile({ alpha: 1, beta: 2 }, HOT_EXCESS)).toBe(false);
		// Excess rate without a full incident is not hot (α ≥ 1 required).
		expect(isEpicHotFile({ alpha: 0.9, beta: 0 }, 0)).toBe(false);
	});

	test('strongest-co-writer discount: writes one declarer explains are expansion, not heat', () => {
		// One undeclared write from a.ts: α = 1, but w(a → b) = 1 is an active
		// expansion edge ⇒ α' = 0 — not hot (expansion already separates them).
		const one = epicLearningFromOutcomes([
			outcome({ undeclared: ['src/b.ts'] }),
		]);
		expect(edgeWeights(one)).toEqual({ 'src/a.ts->src/b.ts': 1 });
		expect(epicHotIncidentMass({ alpha: 1, beta: 0 }, 1)).toBe(0);
		expect(epicHotFiles(one, HOT_EXCESS)).toEqual([]);
		// The same declarer again: α = 2, m = 2 ⇒ α' = 0 — still not hot.
		const same = mergeEpicLearning(one, one);
		expect(epicHotFiles(same, HOT_EXCESS)).toEqual([]);
		// Two DIFFERENT declarers (a file attracting writes from all over):
		// α = 2, m = 1 ⇒ α' = 1, r = 0.4 ⇒ hot; clean exposures cool it.
		const magnet = mergeEpicLearning(
			one,
			epicLearningFromOutcomes([
				outcome({
					taskId: '1.2',
					declared: ['src/c.ts'],
					undeclared: ['src/b.ts'],
				}),
			]),
		);
		expect(epicHotFiles(magnet, HOT_EXCESS)).toEqual(['src/b.ts']);
		const exposed = mergeEpicLearning(
			magnet,
			epicLearningFromOutcomes([
				outcome({ taskId: '2.1', declared: ['src/b.ts'] }),
				outcome({ taskId: '2.2', declared: ['src/b.ts'] }),
			]),
		);
		expect(epicHotFiles(exposed, HOT_EXCESS)).toEqual([]);
		// Below an active edge (w < 1) nothing is discounted; incidents with
		// no co-writer (merge failure + rework on the declared file) count fully.
		expect(epicHotIncidentMass({ alpha: 1, beta: 0 }, 0.6)).toBe(1);
		const troubled = epicLearningFromOutcomes([
			outcome({
				declared: ['src/r.ts'],
				mergeFailure: { outcome: 'conflict', stage: 'merge' },
				generation: 3,
			}),
		]);
		// α = 0.5 + 0.5 = 1, β = 1 ⇒ r = 1.2 / 4 = 0.3 — excess 0.2 (≤ 0.25).
		expect(epicHotFiles(troubled, 0.19)).toEqual(['src/r.ts']);
	});

	test('hot_excess is the threshold', () => {
		const stats = epicLearningFromOutcomes([
			outcome({ undeclared: ['src/b.ts'] }),
			outcome({
				taskId: '1.2',
				declared: ['src/c.ts'],
				undeclared: ['src/b.ts'],
			}),
		]);
		// α' = 2 − 1 = 1, β = 0 ⇒ r = 0.4, excess 0.3.
		expect(epicHotFiles(stats, 0.29)).toEqual(['src/b.ts']);
		expect(epicHotFiles(stats, 0.31)).toEqual([]);
	});
});

describe('scope expansion', () => {
	const coWrites = new Map([
		['src/a.ts', new Map([['src/b.ts', 1]])],
		['src/c.ts', new Map([['src/d.ts', 0.6]])],
		['src/e.ts', new Map([['src/d.ts', 0.6]])],
	]);

	test('a learned co-write with weight ≥ 1 joins scope*', () => {
		expect(expandEpicScope(['src/a.ts'], coWrites)).toEqual([
			'src/a.ts',
			'src/b.ts',
		]);
	});

	test('weights below 1 expand only when the declared files sum to ≥ 1', () => {
		expect(expandEpicScope(['src/c.ts'], coWrites)).toEqual(['src/c.ts']);
		expect(expandEpicScope(['src/c.ts', 'src/e.ts'], coWrites)).toEqual([
			'src/c.ts',
			'src/e.ts',
			'src/d.ts',
		]);
	});

	test('no co-writes ⇒ the declared scope, normalized and de-duplicated', () => {
		expect(expandEpicScope(['src\\a.ts', 'src/a.ts'], null)).toEqual([
			'src/a.ts',
		]);
	});
});

describe('decay and bounds', () => {
	test('decay per epic scales every mass', () => {
		const stats = epicLearningFromOutcomes([
			outcome({ undeclared: ['src/b.ts'] }),
		]);
		const decayed = scaleEpicLearning(stats, 0.7);
		expect(decayed.files.get('src/b.ts')?.alpha).toBeCloseTo(0.7, 10);
		expect(edgeWeights(decayed)['src/a.ts->src/b.ts']).toBeCloseTo(0.7, 10);
		// After one epic's decay a single co-write no longer expands alone.
		expect(expandEpicScope(['src/a.ts'], decayed.edges)).toEqual(['src/a.ts']);
	});

	test('age decay counts WHOLE half-lives: full weight until a half-life passes', () => {
		const now = Date.parse('2026-10-01T00:00:00.000Z');
		const at = (ms: number) => new Date(now - ms).toISOString();
		for (const ms of [60_000, DAY_MS, 59 * DAY_MS]) {
			expect(epicTimeDecayFactor(at(ms), now, 60)).toBe(1);
		}
		expect(epicTimeDecayFactor(at(61 * DAY_MS), now, 60)).toBe(0.5);
		expect(epicTimeDecayFactor(at(120 * DAY_MS), now, 60)).toBe(0.25);
		expect(epicTimeDecayFactor(at(-DAY_MS), now, 60)).toBe(1);
		expect(epicTimeDecayFactor('not a date', now, 60)).toBe(1);
		// A single co-write keeps expanding scopes for a whole half-life.
		const stats = epicLearningFromOutcomes([
			outcome({ undeclared: ['src/b.ts'] }),
		]);
		for (const ms of [60_000, DAY_MS, 59 * DAY_MS]) {
			const viewed = scaleEpicLearning(
				stats,
				epicTimeDecayFactor(at(ms), now, 60),
			);
			expect(expandEpicScope(['src/a.ts'], viewed.edges)).toEqual([
				'src/a.ts',
				'src/b.ts',
			]);
		}
	});

	test('entries below the drop floor are removed', () => {
		const stats = epicLearningFromOutcomes([
			outcome({ undeclared: ['src/b.ts'] }),
		]);
		const faded = boundEpicLearning(
			scaleEpicLearning(stats, EPIC_LEARNING_DROP_BELOW / 2),
		);
		expect(faded.files.size).toBe(0);
		expect(faded.edges.size).toBe(0);
	});

	test('the cap evicts the lowest α + β (ties by path) and the lightest edges', () => {
		setRetentionCapOverrides({
			MAX_EPIC_LEARNING_FILES: 2,
			MAX_EPIC_LEARNING_EDGES: 1,
		});
		const stats = emptyEpicLearning();
		stats.files.set('src/light.ts', { alpha: 0.1, beta: 0 });
		stats.files.set('src/heavy.ts', { alpha: 3, beta: 2 });
		stats.files.set('src/mid-b.ts', { alpha: 1, beta: 0 });
		stats.files.set('src/mid-a.ts', { alpha: 0, beta: 1 });
		stats.edges.set('src/a.ts', new Map([['src/b.ts', 2]]));
		stats.edges.set('src/c.ts', new Map([['src/d.ts', 1]]));
		const bounded = boundEpicLearning(stats);
		expect([...bounded.files.keys()].sort()).toEqual([
			'src/heavy.ts',
			'src/mid-a.ts',
		]);
		expect(edgeWeights(bounded)).toEqual({ 'src/a.ts->src/b.ts': 2 });
	});
});

describe('undeclaredFiles', () => {
	test('a declared directory covers files beneath it (segment-aware)', () => {
		expect(
			undeclaredFiles(
				['src/auth'],
				['src/auth/login.ts', 'src/authentication.ts', 'src/auth'],
			),
		).toEqual(['src/authentication.ts']);
	});

	test('normalized and de-duplicated; no writes ⇒ nothing undeclared', () => {
		expect(
			undeclaredFiles(['src/a.ts'], ['src\\a.ts', 'src/b.ts', 'src/b.ts']),
		).toEqual(['src/b.ts']);
		expect(undeclaredFiles(['src/a.ts'], [])).toEqual([]);
	});
});
