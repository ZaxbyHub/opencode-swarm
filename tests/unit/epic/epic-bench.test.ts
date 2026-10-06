/**
 * Epic v2 C8 — the Epic PLANNER REGRESSION HARNESS as a normal unit test
 * (no separate CI step: the unit job runs it like any other test).
 *
 * scripts/lib/epic-sim.ts replays tests/fixtures/epic-bench/*.json through
 * the REAL pure planners (serial Balanced, the Lean lane planner, the Epic
 * component planner + learning) under a fixed simulated cost model. It is
 * NOT a real-speed benchmark — it guards planner behaviour:
 *   - Epic's makespan never exceeds Balanced's (or Lean's);
 *   - where co-change / learning matter, Epic ends no worse than Lean on
 *     conflicts (Lean's real planner runs one coder at a time — see the
 *     harness header — so it buys zero conflicts with a serial makespan);
 *   - learning reduces Epic's conflicts across epochs, and each planning
 *     signal is load-bearing — co-change, learning, the hot set and the
 *     serial-component density demotion each have a fixture whose
 *     counterfactual without it is worse — while a single explained
 *     co-write causes no needless serialization;
 *   - no metric regresses more than 5% against golden.json (regenerate it
 *     with `bun scripts/epic-bench.ts --write-golden` and review the diff).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	EPIC_BENCH_FIXTURE_DIR,
	EPIC_BENCH_GOLDEN,
	loadEpicBenchFixtures,
} from '../../../scripts/epic-bench';
import {
	type EpicBenchGolden,
	type EpicBenchResult,
	formatEpicBenchTable,
	goldenOf,
	mulberry32,
	parseEpicBenchFixture,
	simulateEpicBenchFixture,
} from '../../../scripts/lib/epic-sim';

const fixtures = loadEpicBenchFixtures();
const results = new Map<string, EpicBenchResult>(
	fixtures.map((f) => [f.name, simulateEpicBenchFixture(f)]),
);
const golden = JSON.parse(
	fs.readFileSync(
		path.join(EPIC_BENCH_FIXTURE_DIR, EPIC_BENCH_GOLDEN),
		'utf-8',
	),
) as EpicBenchGolden;
const result = (name: string): EpicBenchResult => {
	const r = results.get(name);
	if (!r) throw new Error(`no fixture ${name}`);
	return r;
};
const conflictsPerEpoch = (r: EpicBenchResult['epic']) =>
	r.epochs.map((e) => e.conflicts);

describe('epic-bench fixtures', () => {
	test('a small varied set, all valid and multi-epoch where learning matters', () => {
		expect(fixtures.map((f) => f.name)).toEqual([
			'chain',
			'dense-cochange',
			'dense-ring',
			'hub',
			'independent',
			'learned-cowrites',
			'magnet',
			'onewrite-mixed',
		]);
		for (const f of fixtures.filter((x) => x.learningMatters)) {
			expect(f.epochs).toBeGreaterThanOrEqual(2);
		}
	});

	test('the simulator is deterministic (seeded durations, pure planners)', () => {
		for (const f of fixtures) {
			expect(simulateEpicBenchFixture(f)).toEqual(result(f.name));
		}
		const a = mulberry32(7);
		const b = mulberry32(7);
		expect([a(), a(), a()]).toEqual([b(), b(), b()]);
	});

	test('invalid fixtures are rejected with the offending field', () => {
		const base = {
			name: 'x',
			description: '',
			seed: 1,
			maxParallel: 2,
			epochs: 1,
			learningMatters: false,
			tasks: [{ id: '1.1', phase: 1, declared: ['src/a.ts'], actual: [] }],
		};
		expect(parseEpicBenchFixture(base).name).toBe('x');
		expect(() => parseEpicBenchFixture({ ...base, epochs: 0 })).toThrow(
			'epochs',
		);
		expect(() =>
			parseEpicBenchFixture({
				...base,
				tasks: [{ ...base.tasks[0], declared: [] }],
			}),
		).toThrow('task 1.1 declared');
		expect(() =>
			parseEpicBenchFixture({
				...base,
				tasks: [{ ...base.tasks[0], depends: ['9.9'] }],
			}),
		).toThrow('depends on unknown 9.9');
	});
});

describe('planner properties', () => {
	test.each(
		fixtures.map((f) => f.name),
	)('%s: Epic makespan ≤ Balanced and ≤ Lean in every epoch', (name) => {
		const r = result(name);
		r.epic.epochs.forEach((epoch, i) => {
			expect(epoch.makespan).toBeLessThanOrEqual(r.balanced.epochs[i].makespan);
			expect(epoch.makespan).toBeLessThanOrEqual(r.lean.epochs[i].makespan);
		});
		// Balanced is serial: never concurrent, never conflicting.
		expect(r.balanced.totals.conflicts).toBe(0);
	});

	test('co-change: Epic avoids the conflicts from the first epoch; without the signal it conflicts', () => {
		const r = result('dense-cochange');
		r.epic.epochs.forEach((epoch, i) => {
			expect(epoch.conflicts).toBeLessThanOrEqual(r.lean.epochs[i].conflicts);
		});
		expect(r.epic.totals.conflicts).toBe(0);
		const fixture = fixtures.find((f) => f.name === 'dense-cochange');
		if (!fixture) throw new Error('fixture');
		const blind = simulateEpicBenchFixture(fixture, { cochange: false });
		expect(blind.epic.epochs[0].conflicts).toBeGreaterThan(0);
		// …and learning repairs the blind run in the next epoch.
		expect(blind.epic.epochs[1].conflicts).toBe(0);
	});

	test('learning reduces Epic conflicts across epochs and ends no worse than Lean', () => {
		for (const f of fixtures.filter((x) => x.learningMatters)) {
			const r = result(f.name);
			const perEpoch = conflictsPerEpoch(r.epic);
			for (let i = 1; i < perEpoch.length; i += 1) {
				expect(perEpoch[i]).toBeLessThanOrEqual(perEpoch[i - 1]);
			}
			const last = perEpoch.length - 1;
			expect(perEpoch[last]).toBeLessThanOrEqual(r.lean.epochs[last].conflicts);
			// Lean's zero conflicts cost it a serial makespan.
			expect(r.epic.totals.makespan + r.epic.totals.reworkTime).toBeLessThan(
				r.lean.totals.makespan,
			);
		}
		const r = result('learned-cowrites');
		expect(conflictsPerEpoch(r.epic)[0]).toBeGreaterThan(0);
		expect(conflictsPerEpoch(r.epic).at(-1)).toBe(0);
	});

	test('learning is load-bearing: without it the undeclared co-writes conflict every epoch', () => {
		const fixture = fixtures.find((f) => f.name === 'learned-cowrites');
		if (!fixture) throw new Error('fixture');
		const learned = result('learned-cowrites');
		const blind = simulateEpicBenchFixture(fixture, { learning: false });
		const blindPerEpoch = conflictsPerEpoch(blind.epic);
		expect(new Set(blindPerEpoch).size).toBe(1);
		expect(blindPerEpoch[0]).toBeGreaterThan(0);
		// Within the first epic, later phases already benefit from the wave
		// outcomes of the first one (posterior), not only later epics.
		expect(learned.epic.epochs[0].conflicts).toBeLessThan(blindPerEpoch[0]);
		expect(learned.epic.totals.reworkTime).toBeLessThan(
			blind.epic.totals.reworkTime,
		);
	});
});

describe('each planning signal pays off (counterfactuals)', () => {
	const fixture = (name: string) => {
		const f = fixtures.find((x) => x.name === name);
		if (!f) throw new Error(`no fixture ${name}`);
		return f;
	};

	test('hot set: a file written undeclared by a new declarer each phase must turn hot', () => {
		const learned = result('magnet');
		const hotOff = simulateEpicBenchFixture(fixture('magnet'), { hot: false });
		// No single co-write explains the writes, so only the hot set keeps
		// the next declarer of src/catalog.ts away from the next writer.
		expect(hotOff.epic.epochs[0].conflicts).toBeGreaterThan(
			learned.epic.epochs[0].conflicts,
		);
		expect(hotOff.epic.totals.reworkTime).toBeGreaterThan(
			learned.epic.totals.reworkTime,
		);
	});

	test('no needless serialization: one explained co-write does not make a file hot', () => {
		const r = result('onewrite-mixed');
		const blind = simulateEpicBenchFixture(fixture('onewrite-mixed'), {
			learning: false,
		});
		// Learning changes nothing here: 2.1 (declaring src/shared.ts) still
		// runs with the independent tasks — the co-write a.ts → shared.ts is
		// scope expansion, and 1.1 is not in phase 2.
		expect(r.epic.epochs).toEqual(blind.epic.epochs);
		expect(r.epic.epochs.map((e) => e.waves)).toEqual([2, 2]);
		expect(r.epic.totals.conflicts).toBe(0);
	});

	test('density demotion: a dense cluster runs one task per wave, so hidden writes never meet', () => {
		const r = result('dense-ring');
		const flat = simulateEpicBenchFixture(fixture('dense-ring'), {
			densityDemotion: false,
		});
		expect(r.epic.totals.conflicts).toBe(0);
		expect(flat.epic.totals.conflicts).toBeGreaterThan(0);
		expect(flat.epic.totals.reworkTime).toBeGreaterThan(
			r.epic.totals.reworkTime,
		);
	});
});

describe('golden regression guard (≤ 5%)', () => {
	test('golden.json covers exactly the fixtures', () => {
		expect(Object.keys(golden).sort()).toEqual(
			fixtures.map((f) => f.name).sort(),
		);
	});

	test.each(
		fixtures.map((f) => f.name),
	)('%s: no metric regresses more than 5%', (name) => {
		const current = goldenOf([result(name)])[name];
		for (const strategy of ['balanced', 'lean', 'epic'] as const) {
			for (const metric of ['makespan', 'conflicts', 'reworkTime'] as const) {
				const allowed = golden[name][strategy][metric] * 1.05;
				const actual = current[strategy][metric];
				if (actual > allowed) {
					throw new Error(
						`${name}/${strategy}/${metric} regressed: ${actual} > ${golden[name][strategy][metric]} (+5%). If intended, run \`bun scripts/epic-bench.ts --write-golden\` and justify the diff.`,
					);
				}
				expect(actual).toBeLessThanOrEqual(allowed);
			}
		}
	});

	test('the printed table carries every fixture × strategy', () => {
		const table = formatEpicBenchTable([...results.values()]);
		for (const name of results.keys()) {
			for (const strategy of ['balanced', 'lean', 'epic']) {
				expect(table).toMatch(new RegExp(`^${name}\\s+${strategy}\\s`, 'm'));
			}
		}
	});
});

describe('outside the plugin bundle', () => {
	test('no src/ module imports the harness', () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.ts$/.test(entry.name)) {
					const text = fs.readFileSync(full, 'utf-8');
					if (/epic-sim|epic-bench/.test(text)) offenders.push(full);
				}
			}
		};
		walk(path.join(import.meta.dir, '..', '..', '..', 'src'));
		expect(offenders).toEqual([]);
	});
});
