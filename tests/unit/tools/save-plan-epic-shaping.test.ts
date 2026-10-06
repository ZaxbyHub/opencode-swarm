/**
 * Epic v2 C7 — the save_plan plan-shaping seam (`src/tools/save-plan.ts`).
 *
 * Epic off: the result is exactly the upstream shape (no `epic_shaping`),
 * save_plan reads config once (the read it always made), never calls the
 * Epic seam, and touches no Epic path. Epic on: the result gains
 * `epic_shaping` — the one-line Balanced advisory for a plan that is not
 * epic-sized, the full advisory otherwise — computed after the plan lock is
 * released; a throwing shaper leaves the save successful (fail open).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigLoadResult } from '../../../src/config/loader';
import { PluginConfigSchema } from '../../../src/config/schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { _internals as seamInternals } from '../../../src/epic/plan-shaping-seam';
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { loadPlanJsonOnly } from '../../../src/plan/manager';
import {
	executeSavePlan,
	_internals as savePlanInternals,
} from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realFs = { ...fs };
const realSavePlan = { ...savePlanInternals };
const realSeam = { ...seamInternals };
const EPIC_ON = {
	epic: { mode: { enabled: true } },
};

let dir: string;
let configReads = 0;

function useConfig(raw: Record<string, unknown>): void {
	savePlanInternals.loadPluginConfigWithMeta = (() => {
		configReads += 1;
		return {
			config: PluginConfigSchema.parse(raw),
		} as unknown as ConfigLoadResult;
	}) as typeof savePlanInternals.loadPluginConfigWithMeta;
}

function args(
	title: string,
	files: string[][],
): Parameters<typeof executeSavePlan>[0] {
	return {
		title,
		swarm_id: 'shaping-swarm',
		working_directory: dir,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: files.map((touched, i) => ({
					id: `1.${i + 1}`,
					description: `Implement part ${i + 1}`,
					files_touched: touched,
				})),
			},
		],
	};
}

const HUB_FILES = [
	...Array.from({ length: 6 }, (_, i) => ['src/registry.ts', `src/f${i}.ts`]),
	['src/solo-1.ts'],
	['src/solo-2.ts'],
];

beforeEach(() => {
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
	configReads = 0;
	dir = canonicalMkdtemp('save-plan-epic-shaping-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		'# Spec\nshaping.',
		'utf-8',
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', 'context.md'),
		'## Pending QA Gate Selection\n',
		'utf-8',
	);
	// The temp project counts as a git work tree (wave width 4).
	seamInternals.existsSync = (target) =>
		target === path.join(dir, '.git') || fs.existsSync(target);
});

afterEach(() => {
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	Object.assign(savePlanInternals, realSavePlan);
	Object.assign(seamInternals, realSeam);
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Epic off — upstream-identical', () => {
	test('result shape, one config read, no seam call, no Epic path touched', async () => {
		useConfig({});
		savePlanInternals.computeSavePlanEpicShaping = (async () => {
			throw new Error('the Epic seam must not run with Epic off');
		}) as typeof savePlanInternals.computeSavePlanEpicShaping;
		const touched: string[] = [];
		const record = (p: unknown) => {
			touched.push(String(p));
		};
		const spies = [
			spyOn(fs, 'readFileSync').mockImplementation(((
				p: fs.PathOrFileDescriptor,
				...rest: unknown[]
			) => {
				record(p);
				return (realFs.readFileSync as (...a: unknown[]) => unknown)(
					p,
					...rest,
				);
			}) as typeof fs.readFileSync),
			spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) => {
				record(p);
				return realFs.existsSync(p);
			}) as typeof fs.existsSync),
		];
		let result: Awaited<ReturnType<typeof executeSavePlan>>;
		try {
			result = await executeSavePlan(args('Off Plan', HUB_FILES));
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		const saved = await loadPlanJsonOnly(dir);
		expect(result).toEqual({
			success: true,
			message: 'Plan saved successfully',
			plan_path: path.join(dir, '.swarm', 'plan.json'),
			phases_count: 1,
			tasks_count: 8,
			execution_profile: saved?.execution_profile,
		});
		expect(Object.keys(result)).toEqual([
			'success',
			'message',
			'plan_path',
			'phases_count',
			'tasks_count',
			'execution_profile',
		]);
		expect(configReads).toBe(1);
		const epicPaths = touched.filter(
			(p) =>
				p.includes(`${path.sep}epic${path.sep}`) ||
				p.includes('epic-prior') ||
				p.endsWith(`${path.sep}.git`),
		);
		expect(epicPaths).toEqual([]);
		expect(touched.length).toBeGreaterThan(0); // the spy did observe reads
	});

	test('Epic off and Epic on (seam returning nothing) give the same result', async () => {
		useConfig({});
		const off = await executeSavePlan(args('Same Plan', HUB_FILES));
		useConfig(EPIC_ON);
		savePlanInternals.computeSavePlanEpicShaping = async () => null;
		const on = await executeSavePlan(args('Same Plan', HUB_FILES));
		expect(on).toEqual(off);
		expect(configReads).toBe(2);
	});
});

describe('Epic on', () => {
	test('small plan: the one-line not-epic-sized advisory', async () => {
		useConfig(EPIC_ON);
		const result = await executeSavePlan(
			args('Small', [['src/a.ts'], ['src/b.ts']]),
		);
		expect(result.success).toBe(true);
		expect(result.epic_shaping).toEqual({
			status: 'not-epic-sized',
			message:
				'Plan is not epic-sized (too-few-tasks: 2 pending task(s) < min_tasks 6) — run it in Balanced',
			cochange: 'disabled',
		});
		expect(configReads).toBe(1); // the seam reused save_plan's config
	});

	test('hub plan: full advisory with an extract-prerequisite patch', async () => {
		useConfig(EPIC_ON);
		const result = await executeSavePlan(args('Hub', HUB_FILES));
		expect(result.epic_shaping).toMatchObject({
			status: 'improvable',
			iteration: 1,
			suggestions: [
				{
					type: 'extract-prerequisite',
					file: 'src/registry.ts',
					file_kind: 'hub-file',
					task_ids: ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'],
					patch: {
						new_task: { id: '1.9', phase: 1, depends: [] },
						edits: expect.arrayContaining([
							{
								task_id: '1.1',
								depends: ['1.9'],
								files_touched: ['src/f0.ts'],
								remove_files: ['src/registry.ts'],
								add_depends: ['1.9'],
							},
						]),
					},
				},
			],
		});
		// It travels in the serialized tool result.
		expect(JSON.parse(JSON.stringify(result)).epic_shaping.status).toBe(
			'improvable',
		);
	});

	test('epic-sized plan: acceptable advisory', async () => {
		useConfig(EPIC_ON);
		const result = await executeSavePlan(
			args(
				'Wide',
				Array.from({ length: 8 }, (_, i) => [`src/w${i}.ts`]),
			),
		);
		expect(result.epic_shaping).toMatchObject({
			status: 'acceptable',
			epic_sized: true,
		});
	});

	test('a throwing shaper fails open: saved, success, no epic_shaping', async () => {
		useConfig(EPIC_ON);
		savePlanInternals.computeSavePlanEpicShaping = async () => {
			throw new Error('shaping exploded');
		};
		const result = await executeSavePlan(args('Hub', HUB_FILES));
		expect(result.success).toBe(true);
		expect(result).not.toHaveProperty('epic_shaping');
		expect((await loadPlanJsonOnly(dir))?.phases[0].tasks).toHaveLength(8);
	});

	test('shaping runs after the plan lock is released', async () => {
		useConfig(EPIC_ON);
		// Control: while the plan lock is held, save_plan is refused.
		const held = await tryAcquireLock(dir, 'plan.json', 'probe', 'probe-1');
		if (!held.acquired) throw new Error('control lock not acquired');
		const blocked = await executeSavePlan(args('Hub', HUB_FILES));
		expect(blocked.success).toBe(false);
		await held.lock._release?.();

		let lockFreeDuringShaping: boolean | null = null;
		savePlanInternals.computeSavePlanEpicShaping = async (directory) => {
			const probe = await tryAcquireLock(
				directory,
				'plan.json',
				'probe',
				'probe-2',
			);
			lockFreeDuringShaping = probe.acquired;
			if (probe.acquired) await probe.lock._release?.();
			return null;
		};
		const result = await executeSavePlan(args('Hub', HUB_FILES));
		expect(result.success).toBe(true);
		expect(lockFreeDuringShaping).toBe(true);
	});
});
