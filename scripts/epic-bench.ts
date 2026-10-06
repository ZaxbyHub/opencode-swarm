/**
 * `bun scripts/epic-bench.ts` — print the Epic PLANNER REGRESSION HARNESS table
 * (scripts/lib/epic-sim.ts over tests/fixtures/epic-bench/*.json).
 *
 * NOT a real-speed benchmark: it compares the real Balanced / Lean / Epic
 * planners under a fixed simulated cost model (see epic-sim.ts) to catch
 * planner regressions. The regression gate is the normal unit test
 * tests/unit/epic/epic-bench.test.ts (no separate CI step).
 *
 *   bun scripts/epic-bench.ts                  # print the table
 *   bun scripts/epic-bench.ts --write-golden   # rewrite golden.json (review the diff!)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type EpicBenchFixture,
	formatEpicBenchTable,
	goldenOf,
	parseEpicBenchFixture,
	simulateEpicBenchFixture,
} from './lib/epic-sim';

export const EPIC_BENCH_FIXTURE_DIR = path.join(
	import.meta.dir,
	'..',
	'tests',
	'fixtures',
	'epic-bench',
);
export const EPIC_BENCH_GOLDEN = 'golden.json';

/** Every fixture (sorted by file name; golden.json excluded). */
export function loadEpicBenchFixtures(
	dir = EPIC_BENCH_FIXTURE_DIR,
): EpicBenchFixture[] {
	return fs
		.readdirSync(dir)
		.filter((name) => name.endsWith('.json') && name !== EPIC_BENCH_GOLDEN)
		.sort()
		.map((name) =>
			parseEpicBenchFixture(
				JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')),
			),
		);
}

if (import.meta.main) {
	const results = loadEpicBenchFixtures().map(simulateEpicBenchFixture);
	console.log(
		'Epic planner regression harness (simulated cost model — NOT real speed)\n',
	);
	console.log(formatEpicBenchTable(results));
	if (process.argv.includes('--write-golden')) {
		const target = path.join(EPIC_BENCH_FIXTURE_DIR, EPIC_BENCH_GOLDEN);
		fs.writeFileSync(target, `${JSON.stringify(goldenOf(results), null, '\t')}\n`);
		console.log(`\nwrote ${target}`);
	}
}
