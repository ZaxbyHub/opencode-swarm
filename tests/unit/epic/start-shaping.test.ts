/**
 * Epic v2 C7 — a `not-epic-sized` `/swarm epic start` refusal carries plan
 * shaping: the suggestions are computed with the start's own inputs (the
 * co-change data it awaited fresh, the same scopes and learned signals),
 * and `/swarm epic start` renders the top ones with their patch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { handleEpicCommand } from '../../../src/commands/epic';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { _internals, startEpic } from '../../../src/epic/start';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { createStartProject, sizedPlan } from './start-fixture';

const realInternals = { ..._internals };
const dirs: string[] = [];
let restoreClock: Restore | null = null;

function hubPlan(): Plan {
	const plan = sizedPlan('Hub Start', 8);
	plan.phases[0].tasks.forEach((task, i) => {
		task.files_touched =
			i < 6 ? ['src/registry.ts', `src/f${i}.ts`] : [`src/solo-${i}.ts`];
	});
	return plan;
}

async function project(
	plan: Plan,
	config?: Record<string, unknown>,
): Promise<string> {
	const dir = await createStartProject('epic-start-shaping-', {
		git: true,
		plan,
		...(config ? { config } : {}),
	});
	dirs.push(dir);
	return dir;
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-10-03T10:00:00.000Z' });
	_internals.hasActiveTurboMode = () => false;
	_internals.countTrackedWorktreeDispatches = () => 0;
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, realInternals);
	closeAllProjectDbs();
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe('not-epic-sized refusal with shaping', () => {
	test('the refusal carries the shaping report (extract-prerequisite first)', async () => {
		const dir = await project(hubPlan());
		const result = await startEpic({
			directory: dir,
			sessionID: 'ses_s',
			force: false,
		});
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'not-epic-sized',
		});
		if (result.status !== 'refused') return;
		expect(result.shaping?.verdict).toBe('improvable');
		expect(result.shaping?.sizing).toEqual(result.sizing);
		expect(result.shaping?.suggestions[0]).toMatchObject({
			type: 'extract-prerequisite',
			file: 'src/registry.ts',
		});
	});

	test('/swarm epic start renders the top suggestions and the reshape hint', async () => {
		const dir = await project(hubPlan());
		const out = await handleEpicCommand(dir, ['start'], 'ses_s');
		expect(out).toContain('Epic not started — **not-epic-sized**');
		expect(out).toContain('Plan shaping: **improvable**');
		expect(out).toContain('1. [extract-prerequisite]');
		expect(out).toContain('Patch: add task 1.9 to phase 1');
		expect(out).toContain('reshape it (above;');
	});

	test('a plan no suggestion rescues keeps the plain Balanced hint', async () => {
		const dir = await project(sizedPlan('Small', 3));
		const out = await handleEpicCommand(dir, ['start'], 'ses_s');
		expect(out).toContain('This plan is not epic-sized — run it in Balanced');
		expect(out).not.toContain('Plan shaping');
	});

	test('co-change: the start awaits fresh data and shapes with it', async () => {
		const pair = (a: string, b: string): CoChangeEntry => ({
			fileA: a,
			fileB: b,
			npmi: 0.95,
			coChangeCount: 20,
			lift: 3,
			hasStaticEdge: false,
			totalCommits: 50,
			commitsA: 20,
			commitsB: 20,
		});
		let calls = 0;
		// Both solo tasks co-change with every hub feature file.
		const pairs = ['src/solo-6.ts', 'src/solo-7.ts'].flatMap((solo) =>
			Array.from({ length: 6 }, (_, i) => pair(`src/f${i}.ts`, solo)),
		);
		_internals.getCoChangeData = async () => {
			calls += 1;
			return { pairs, commitsObserved: 50 };
		};
		const dir = await project(hubPlan(), {
			epic: { mode: { enabled: true }, cochange: { enabled: true } },
		});
		const result = await startEpic({
			directory: dir,
			sessionID: 'ses_s',
			force: false,
		});
		expect(calls).toBe(1);
		if (result.status !== 'refused') throw new Error('expected a refusal');
		// Path-only the hub costs 6 steps (the solo tasks ride along); the
		// co-change edges pull both solo tasks into the serial cluster, so
		// they run once it drains (7) — and shaping saw the same data.
		expect(result.sizing?.serialSteps).toBe(7);
		expect(result.shaping?.sizing?.serialSteps).toBe(7);
	});

	test('a shaping failure still refuses, without suggestions', async () => {
		const dir = await project(hubPlan());
		_internals.shapeEpicPlan = () => {
			throw new Error('shaping exploded');
		};
		const result = await startEpic({
			directory: dir,
			sessionID: 'ses_s',
			force: false,
		});
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'not-epic-sized',
		});
		if (result.status === 'refused') expect(result.shaping).toBeUndefined();
	});

	test('the shaping reuses the start sizing (no second baseline)', async () => {
		const dir = await project(hubPlan());
		let baselinePassed = false;
		_internals.shapeEpicPlan = (input) => {
			baselinePassed = input.baseline !== undefined;
			return realInternals.shapeEpicPlan(input);
		};
		await startEpic({ directory: dir, sessionID: 'ses_s', force: false });
		expect(baselinePassed).toBe(true);
	});

	test('a plan too large to size: pessimistic refusal, skipped-budget note, --force works', async () => {
		const files = Array.from({ length: 500 }, (_, i) => `src/m${i}/f${i}.ts`);
		const plan = sizedPlan('Huge Start', 60);
		for (const t of plan.phases[0].tasks) t.files_touched = files;
		const dir = await project(plan);
		const result = await startEpic({
			directory: dir,
			sessionID: 'ses_s',
			force: false,
		});
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'not-epic-sized',
		});
		if (result.status !== 'refused') return;
		expect(result.details[0]).toContain(
			'too large or densely coupled to size exactly',
		);
		expect(result.sizing?.serialSteps).toBe(60); // every task counted serial
		expect(result.shaping?.verdict).toBe('skipped-budget');
		const out = await handleEpicCommand(dir, ['start'], 'ses_s');
		expect(out).toContain('Plan shaping skipped');
		const forced = await startEpic({
			directory: dir,
			sessionID: 'ses_s',
			force: true,
		});
		expect(forced.status).toBe('started');
	});
});
