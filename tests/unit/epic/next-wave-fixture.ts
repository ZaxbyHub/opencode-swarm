/**
 * Shared fixture for the `epic_next_wave` suites (Epic v2 C2).
 *
 * A real temp project (config opt-in, saved plan, REAL lifecycle row opened
 * through `openEpicForTest`, non-git unless a test opts in) whose plan the
 * tests then drive IN MEMORY through `next-wave.ts`'s `_internals` seam:
 * `loadPlanJsonOnly` returns {@link NextWaveProject.plan} and
 * `resolveEpicDeclaredScopes` returns {@link NextWaveProject.live}, so a test
 * flips task / phase statuses and declarations without the plan-ledger or
 * scope-binding machinery. Wave records are written through the real
 * token-guarded `updateEpicRecord`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { type EpicRecordV1, getOpenEpic } from '../../../src/epic/lifecycle';
import { _internals as nextWaveInternals } from '../../../src/epic/next-wave';
import { savePlan } from '../../../src/plan/manager';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { EPIC_ON_CONFIG, writeProjectConfig } from './start-fixture';

export const realNextWaveInternals = { ...nextWaveInternals };

export interface TaskSpec {
	id: string;
	depends?: string[];
	files?: string[];
	status?: Plan['phases'][number]['tasks'][number]['status'];
}

export function phasePlan(phases: TaskSpec[][], title = 'Next Wave'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'next-wave-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: phases.map((tasks, index) => ({
			id: index + 1,
			name: `Phase ${index + 1}`,
			status: 'pending' as const,
			tasks: tasks.map((spec) => ({
				id: spec.id,
				phase: index + 1,
				status: spec.status ?? ('pending' as const),
				size: 'small' as const,
				description: `task ${spec.id}`,
				depends: spec.depends ?? [],
				files_touched: spec.files ?? [`src/t${spec.id.replace('.', '_')}.ts`],
			})),
		})),
	};
}

export interface NextWaveProject {
	dir: string;
	plan: Plan;
	/** Live declared scopes served to the planner (taskId → files). */
	live: Record<string, string[]>;
	epic: EpicRecordV1;
	record(): EpicRecordV1;
	setStatus(taskId: string, status: TaskSpec['status']): void;
	setPhaseStatus(
		phaseId: number,
		status: Plan['phases'][number]['status'],
	): void;
	/** Declare every pending task's `files_touched` as its live scope. */
	declareAll(): void;
	cleanup(): void;
}

export async function openNextWaveProject(
	phases: TaskSpec[][],
	options: {
		config?: Record<string, unknown>;
		maxParallel?: number;
		overrides?: Partial<EpicRecordV1>;
	} = {},
): Promise<NextWaveProject> {
	const dir = canonicalMkdtemp('epic-next-wave-');
	writeProjectConfig(dir, options.config ?? EPIC_ON_CONFIG);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	const plan = phasePlan(phases);
	await savePlan(dir, plan);
	const epic = openEpicForTest(dir, {
		config: {
			commitPolicy: 'current-branch',
			isolation: 'main-tree-nogit',
			maxParallel: options.maxParallel ?? 4,
		},
		git: {
			isRepo: false,
			baseCommit: null,
			originalBranch: null,
			epicBranch: null,
		},
		...options.overrides,
	});
	const live: Record<string, string[]> = {};
	nextWaveInternals.loadPlanJsonOnly = (async () => plan) as never;
	nextWaveInternals.resolveEpicDeclaredScopes = ((
		_dir: string,
		_plan: Plan,
		ids: readonly string[],
	) => Object.fromEntries(ids.map((id) => [id, live[id] ?? []]))) as never;
	const findTask = (taskId: string) => {
		for (const phase of plan.phases) {
			const task = phase.tasks.find((t) => t.id === taskId);
			if (task) return task;
		}
		throw new Error(`no task ${taskId}`);
	};
	return {
		dir,
		plan,
		live,
		epic,
		record: () => {
			const record = getOpenEpic(dir);
			if (!record) throw new Error('epic not open');
			return record;
		},
		setStatus: (taskId, status) => {
			findTask(taskId).status = status ?? 'pending';
		},
		setPhaseStatus: (phaseId, status) => {
			const phase = plan.phases.find((p) => p.id === phaseId);
			if (!phase) throw new Error(`no phase ${phaseId}`);
			phase.status = status;
		},
		declareAll: () => {
			for (const phase of plan.phases) {
				for (const task of phase.tasks) live[task.id] = [...task.files_touched];
			}
		},
		cleanup: () => {
			Object.assign(nextWaveInternals, realNextWaveInternals);
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
