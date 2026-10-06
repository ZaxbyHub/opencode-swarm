/**
 * Epic v2 C7 — the save_plan plan-shaping seam, Epic side
 * (`src/epic/plan-shaping-seam.ts`): the `epic_shaping` value, the
 * warm-only co-change read (cold ⇒ path-only, flagged), the iteration
 * counter keyed by plan identity, and nothing while an epic is open.
 * Real temp project + real plan ledger; process inputs via `_internals`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import type { PluginConfig } from '../../../src/config/schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	computeSavePlanEpicShaping,
	EPIC_SHAPING_RELATIVE_PATH,
} from '../../../src/epic/plan-shaping-seam';
import { savePlan } from '../../../src/plan/manager';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realInternals = { ..._internals };
const EPIC_ON = {
	epic: { mode: { enabled: true } },
} as unknown as PluginConfig;
const EPIC_COCHANGE_ON = {
	epic: { mode: { enabled: true }, cochange: { enabled: true } },
} as unknown as PluginConfig;

let dir: string;
let restoreClock: Restore | null = null;

function plan(title: string, files: string[][]): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'shaping-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: files.map((touched, index) => ({
					id: `1.${index + 1}`,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `task ${index + 1}`,
					depends: [],
					files_touched: touched,
				})),
			},
		],
	};
}

/** 6 tasks on a hub + 2 independent: not epic-sized, fixable. */
function hubPlan(title = 'Hub Plan'): Plan {
	return plan(title, [
		...Array.from({ length: 6 }, (_, i) => ['src/registry.ts', `src/f${i}.ts`]),
		['src/solo-1.ts'],
		['src/solo-2.ts'],
	]);
}

async function shapingOf(p: Plan, config: PluginConfig = EPIC_ON) {
	await savePlan(dir, p);
	return computeSavePlanEpicShaping(dir, p, config);
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-10-03T12:00:00.000Z' });
	dir = canonicalMkdtemp('epic-shaping-seam-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	// The project counts as a git work tree (wave width 4) without git.
	_internals.existsSync = (target) =>
		target === path.join(dir, '.git') || fs.existsSync(target);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, realInternals);
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('epic_shaping values', () => {
	test('not epic-sized and unfixable: the one-line Balanced advisory', async () => {
		const shaping = await shapingOf(plan('Tiny', [['src/a.ts'], ['src/b.ts']]));
		expect(shaping).toEqual({
			status: 'not-epic-sized',
			message:
				'Plan is not epic-sized (too-few-tasks: 2 pending task(s) < min_tasks 6) — run it in Balanced',
			cochange: 'disabled',
		});
	});

	test('fixable hub plan: full advisory with the concrete patch', async () => {
		const shaping = await shapingOf(hubPlan());
		expect(shaping).toMatchObject({
			status: 'improvable',
			epic_sized: false,
			pending_tasks: 8,
			serial_steps: 6,
			cochange: 'disabled',
			iteration: 1,
		});
		if (shaping?.status !== 'improvable') throw new Error('not improvable');
		expect(shaping.reasons[0]).toContain('insufficient-parallelism');
		const top = shaping.suggestions[0];
		expect(top).toMatchObject({
			type: 'extract-prerequisite',
			file: 'src/registry.ts',
			what_if: { epic_sized: true },
		});
		expect(top.delta_effective_speedup).toBeGreaterThan(0);
		expect(shaping.next_step).toContain('apply suggestion 1 with save_plan');
		expect(JSON.parse(JSON.stringify(shaping))).toEqual(shaping);
	});

	test('epic-sized plan: acceptable, proceed', async () => {
		const shaping = await shapingOf(
			plan(
				'Wide',
				Array.from({ length: 8 }, (_, i) => [`src/w${i}.ts`]),
			),
		);
		expect(shaping).toMatchObject({
			status: 'acceptable',
			epic_sized: true,
			suggestions: [],
			reasons: [],
		});
		if (shaping?.status !== 'acceptable') throw new Error('not acceptable');
		expect(shaping.next_step).toContain('/swarm epic start');
	});

	test('non-git project (no .git anywhere up): serial width ⇒ not epic-sized', async () => {
		_internals.existsSync = () => false;
		const shaping = await shapingOf(
			plan(
				'Wide',
				Array.from({ length: 8 }, (_, i) => [`src/w${i}.ts`]),
			),
		);
		expect(shaping?.status).toBe('not-epic-sized');
	});

	test('over budget: one-line skipped-budget', async () => {
		const shaping = await shapingOf(
			plan(
				'Huge',
				Array.from({ length: 201 }, (_, i) => [`src/h${i}.ts`]),
			),
		);
		expect(shaping?.status).toBe('skipped-budget');
		if (shaping?.status === 'skipped-budget') {
			expect(shaping.message).toContain('201 pending task(s)');
		}
	});

	test('an open epic: no shaping at all', async () => {
		_internals.isEpicOpenForProject = () => true;
		expect(await shapingOf(hubPlan())).toBeNull();
		expect(fs.existsSync(path.join(dir, EPIC_SHAPING_RELATIVE_PATH))).toBe(
			false,
		);
	});
});

describe('co-change: warm cache only', () => {
	const pair: CoChangeEntry = {
		fileA: 'src/solo-1.ts',
		fileB: 'src/solo-2.ts',
		npmi: 0.95,
		coChangeCount: 20,
		lift: 3,
		hasStaticEdge: false,
		totalCommits: 50,
		commitsA: 20,
		commitsB: 20,
	};

	test('cold cache: path-only, flagged cold', async () => {
		let peeks = 0;
		_internals.peekCoChangeData = () => {
			peeks += 1;
			return null;
		};
		const shaping = await shapingOf(hubPlan(), EPIC_COCHANGE_ON);
		expect(peeks).toBe(1);
		expect(shaping).toMatchObject({ cochange: 'cold', serial_steps: 6 });
	});

	test('warm cache: the cached pairs couple tasks (flagged warm)', async () => {
		const wide = plan(
			'Wide',
			Array.from({ length: 8 }, (_, i) => [`src/w${i}.ts`]),
		);
		const pairs: CoChangeEntry[] = [];
		for (let a = 0; a < 8; a += 1) {
			for (let b = a + 1; b < 8; b += 1) {
				pairs.push({ ...pair, fileA: `src/w${a}.ts`, fileB: `src/w${b}.ts` });
			}
		}
		_internals.peekCoChangeData = () => ({
			pairs: [pair],
			commitsObserved: 50,
		});
		expect(await shapingOf(wide, EPIC_COCHANGE_ON)).toMatchObject({
			status: 'acceptable',
			cochange: 'warm',
		});
		// Every pair co-changes: the cached signal serializes the whole plan.
		_internals.peekCoChangeData = () => ({ pairs, commitsObserved: 50 });
		expect(
			await computeSavePlanEpicShaping(dir, wide, EPIC_COCHANGE_ON),
		).toEqual({
			status: 'not-epic-sized',
			message: expect.stringContaining('insufficient-parallelism'),
			cochange: 'warm',
		});
		// Cold (path-only) the same plan is acceptable.
		_internals.peekCoChangeData = () => null;
		expect(
			await computeSavePlanEpicShaping(dir, wide, EPIC_COCHANGE_ON),
		).toMatchObject({
			status: 'acceptable',
			cochange: 'cold',
		});
	});

	test('co-change disabled by config: never peeked', async () => {
		_internals.peekCoChangeData = () => {
			throw new Error('must not peek');
		};
		expect(await shapingOf(hubPlan(), EPIC_ON)).toMatchObject({
			cochange: 'disabled',
		});
	});
});

describe('iteration counter', () => {
	test('counts saves of one plan; from iteration 3 says accept and proceed', async () => {
		const p = hubPlan();
		await savePlan(dir, p);
		const runs = [];
		for (let i = 0; i < 3; i += 1) {
			runs.push(await computeSavePlanEpicShaping(dir, p, EPIC_ON));
		}
		expect(runs.map((r) => (r && 'iteration' in r ? r.iteration : 0))).toEqual([
			1, 2, 3,
		]);
		const third = runs[2];
		if (third?.status !== 'improvable') throw new Error('not improvable');
		expect(third.next_step).toContain('accept the plan as it is and proceed');
		const state = JSON.parse(
			fs.readFileSync(path.join(dir, EPIC_SHAPING_RELATIVE_PATH), 'utf-8'),
		);
		expect(state).toMatchObject({
			schema: 'epic-shaping-v1',
			iteration: 3,
			updatedAt: '2026-10-03T12:00:00.000Z',
		});
	});

	test('a different plan identity restarts at 1; a corrupt file is ignored', async () => {
		await shapingOf(hubPlan('Plan A'));
		await shapingOf(hubPlan('Plan A'));
		const other = await shapingOf(hubPlan('Plan B'));
		expect(other && 'iteration' in other ? other.iteration : 0).toBe(1);
		fs.writeFileSync(path.join(dir, EPIC_SHAPING_RELATIVE_PATH), '{oops');
		const again = await shapingOf(hubPlan('Plan B'));
		expect(again && 'iteration' in again ? again.iteration : 0).toBe(1);
	});

	test('a re-rooted plan ledger (new plan epoch) restarts at 1', async () => {
		const p = hubPlan('Epoch Plan');
		await shapingOf(p);
		expect(await computeSavePlanEpicShaping(dir, p, EPIC_ON)).toMatchObject({
			iteration: 2,
		});
		// Start the plan over from scratch (ledger store + projections).
		closeAllProjectDbs();
		for (const name of fs.readdirSync(path.join(dir, '.swarm'))) {
			if (name.startsWith('swarm.db') || name.startsWith('plan')) {
				fs.rmSync(path.join(dir, '.swarm', name), { force: true });
			}
		}
		// A later save mints a new ledger root (its timestamp differs).
		restoreClock?.();
		restoreClock = freezeClock({ isoNow: '2026-10-04T12:00:00.000Z' });
		await savePlan(dir, p);
		expect(await computeSavePlanEpicShaping(dir, p, EPIC_ON)).toMatchObject({
			iteration: 1,
		});
	});
});

describe('shapes the persisted plan; cold flag in one-liners', () => {
	test('the plan.json save_plan wrote is shaped, not the in-memory argument', async () => {
		const persisted = hubPlan('Persisted');
		await savePlan(dir, persisted);
		// The caller's object differs (e.g. statuses the save preserved).
		const argument = plan('Persisted', [['src/a.ts'], ['src/b.ts']]);
		const shaping = await computeSavePlanEpicShaping(dir, argument, EPIC_ON);
		expect(shaping).toMatchObject({ status: 'improvable', pending_tasks: 8 });
		// Unreadable plan.json: the caller's plan is the fallback.
		_internals.loadPlanJsonOnly = async () => null;
		expect(
			await computeSavePlanEpicShaping(dir, argument, EPIC_ON),
		).toMatchObject({
			status: 'not-epic-sized',
		});
	});

	test('a cold co-change cache is flagged in the one-line advisory', async () => {
		_internals.peekCoChangeData = () => null;
		const shaping = await shapingOf(
			plan('Tiny', [['src/a.ts'], ['src/b.ts']]),
			EPIC_COCHANGE_ON,
		);
		expect(shaping).toMatchObject({
			status: 'not-epic-sized',
			cochange: 'cold',
		});
		if (shaping?.status === 'not-epic-sized') {
			expect(shaping.message).toContain(
				'co-change: cold cache — path-only estimate',
			);
		}
	});
});
