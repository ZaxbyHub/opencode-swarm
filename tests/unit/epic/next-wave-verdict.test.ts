/**
 * Epic v2 C4 — one verdict, two call sites. `epic_next_wave` issues a
 * multi-task wave only when THE wave verdict (`computeEpicWaveVerdict`:
 * `computeParallelVerdict` over the wave's frozen scopes and frozen
 * co-change pairs) is `all_disjoint`; the delegation gate's dispatch policy
 * repeats exactly that call. Parity: the gate's call and the issue-time
 * call receive identical arguments and return identical verdicts.
 * A failed assertion (a planner bug) narrows the wave to one task.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals as gatePolicyInternals,
	resolveEpicDispatchPolicy,
} from '../../../src/epic/gate-policy';
import { _internals, runEpicNextWave } from '../../../src/epic/next-wave';
import type { ParallelVerdict } from '../../../src/plan/parallel-verdict';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	type NextWaveProject,
	openNextWaveProject,
	type TaskSpec,
} from './next-wave-fixture';

const SESSION = 'ses_verdict';
const realGatePolicy = { ...gatePolicyInternals };
let project: NextWaveProject | null = null;
let restoreClock: Restore | null = null;

const GIT_EPIC = {
	config: {
		commitPolicy: 'current-branch' as const,
		isolation: 'worktree' as const,
		maxParallel: 3,
	},
	git: {
		isRepo: true,
		baseCommit: null,
		originalBranch: 'main',
		epicBranch: null,
	},
};

async function open(
	phases: TaskSpec[][],
	config?: Record<string, unknown>,
): Promise<NextWaveProject> {
	project = await openNextWaveProject(phases, {
		...(config ? { config } : {}),
		overrides: GIT_EPIC,
	});
	project.declareAll();
	// A git epic without a repository: no dirty files, no HEAD.
	_internals.listDirtyEntries = (() => []) as never;
	_internals.readHead = () => null;
	return project;
}

type VerdictCall = {
	directory: string;
	taskIds: string[];
	options: unknown;
	result: ParallelVerdict;
};

function spyVerdicts(): VerdictCall[] {
	const calls: VerdictCall[] = [];
	gatePolicyInternals.computeParallelVerdict = ((
		directory: string,
		taskIds: string[],
		options: unknown,
	) => {
		const result = realGatePolicy.computeParallelVerdict(
			directory,
			taskIds,
			options as never,
		);
		calls.push({ directory, taskIds: [...taskIds], options, result });
		return result;
	}) as never;
	return calls;
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-09-01T10:00:00.000Z' });
});

afterEach(() => {
	Object.assign(gatePolicyInternals, realGatePolicy);
	project?.cleanup();
	project = null;
	restoreClock?.();
	restoreClock = null;
});

describe('issue-time assertion', () => {
	test('a multi-task wave is asserted all_disjoint over its frozen scopes', async () => {
		const p = await open([[{ id: '1.1' }, { id: '1.2' }]]);
		const calls = spyVerdicts();
		expect(await runEpicNextWave(p.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.1', '1.2'] },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].taskIds).toEqual(['1.1', '1.2']);
		expect(calls[0].options).toMatchObject({
			scopes: { '1.1': ['src/t1_1.ts'], '1.2': ['src/t1_2.ts'] },
			useCochange: false,
		});
		expect(calls[0].result.verdict).toBe('all_disjoint');
	});

	test('a single-task wave needs no verdict', async () => {
		const p = await open([[{ id: '1.1' }]]);
		const calls = spyVerdicts();
		expect(await runEpicNextWave(p.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.1'] },
		});
		expect(calls).toEqual([]);
	});

	test('a failed assertion narrows the wave to the first task in serial order', async () => {
		const p = await open([[{ id: '1.1' }, { id: '1.2' }]]);
		_internals.computeEpicWaveVerdict = (() => ({
			verdict: 'conflicts_present',
			pairs: [],
			suggestedSerialOrder: ['1.2', '1.1'],
			unknownScopeTasks: [],
		})) as never;
		expect(await runEpicNextWave(p.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.2'] },
		});
		const wave = p.record().waves[0];
		expect(wave?.taskIds).toEqual(['1.2']);
		expect(wave?.files).toEqual({ '1.2': ['src/t1_2.ts'] });
	});

	test('a throwing verdict narrows the wave to its first task', async () => {
		const p = await open([[{ id: '1.1' }, { id: '1.2' }]]);
		_internals.computeEpicWaveVerdict = (() => {
			throw new RangeError('too many');
		}) as never;
		expect(await runEpicNextWave(p.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.1'] },
		});
	});
});

describe('parity: gate verdict == issue assertion', () => {
	async function parity(config?: Record<string, unknown>): Promise<void> {
		const p = await open(
			[[{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }]],
			config,
		);
		const calls = spyVerdicts();
		const issued = await runEpicNextWave(p.dir, SESSION);
		expect(issued.status).toBe('dispatch');
		const wave = p.record().waves[0];
		if (!wave) throw new Error('no wave');
		const plan = p.plan as Plan;
		for (const taskId of wave.taskIds) {
			const policy = resolveEpicDispatchPolicy(
				p.dir,
				plan,
				taskId,
				wave.files[taskId],
			);
			expect(policy).toEqual({
				kind: 'allow',
				parallel: true,
				isolate: true,
				maxConcurrent: 3,
			});
		}
		// 1 issue call + 1 gate call per task, all identical.
		expect(calls).toHaveLength(1 + wave.taskIds.length);
		for (const call of calls.slice(1)) {
			expect(call.directory).toBe(calls[0].directory);
			expect(call.taskIds).toEqual(calls[0].taskIds);
			expect(call.options).toEqual(calls[0].options);
			expect(call.result).toEqual(calls[0].result);
		}
		expect(calls[0].result.verdict).toBe('all_disjoint');
	}

	test('path-only wave', async () => {
		await parity();
	});

	test('co-change wave: the frozen pairs and threshold travel to the gate', async () => {
		_internals.getCoChangeData = (async () => ({
			pairs: [
				{
					fileA: 'src/t1_1.ts',
					fileB: 'src/t1_2.ts',
					npmi: 0.1,
					coChangeCount: 4,
				},
			],
			commitsObserved: 30,
		})) as never;
		await parity({
			epic: {
				mode: { enabled: true },
				cochange: { enabled: true, threshold: 0.5, min_co_changes: 2 },
			},
		});
	});

	test('once a wave task resolves, the gate verdict covers only the unresolved ones', async () => {
		const p = await open([[{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }]]);
		await runEpicNextWave(p.dir, SESSION);
		const calls = spyVerdicts();
		p.setStatus('1.1', 'completed');
		const wave = p.record().waves[0];
		if (!wave) throw new Error('no wave');
		expect(
			resolveEpicDispatchPolicy(p.dir, p.plan, '1.2', wave.files['1.2']),
		).toMatchObject({ kind: 'allow', parallel: true });
		expect(calls.map((c) => c.taskIds)).toEqual([['1.2', '1.3']]);
		p.setStatus('1.3', 'closed');
		expect(
			resolveEpicDispatchPolicy(p.dir, p.plan, '1.2', wave.files['1.2']),
		).toMatchObject({ kind: 'allow', parallel: false });
		expect(calls).toHaveLength(1);
	});
});
