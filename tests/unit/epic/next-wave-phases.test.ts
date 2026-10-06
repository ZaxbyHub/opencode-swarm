/**
 * `epic_next_wave` — phase gating, declare-scopes, refusals, branch drift
 * (Epic v2 C2). Phases are iterations: no wave of phase N+1 until
 * `phase_complete` recorded phase N complete on the epic (the plan's own
 * phase status is not enough); a pending task in a complete phase blocks
 * (`task-reopened` / `plan-revised`). Real lifecycle row; plan in memory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { markEpicPhaseComplete } from '../../../src/epic/lifecycle';
import { _internals, runEpicNextWave } from '../../../src/epic/next-wave';
import { initialEpicPhases } from '../../../src/epic/start';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { type NextWaveProject, openNextWaveProject } from './next-wave-fixture';

const SESSION = 'ses_phases';
let project: NextWaveProject;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-08-02T10:00:00.000Z' });
	project = await openNextWaveProject([[{ id: '1.1' }], [{ id: '2.1' }]]);
	project.declareAll();
});

afterEach(() => {
	project.cleanup();
	restoreClock?.();
	restoreClock = null;
});

describe('phases are iterations', () => {
	test('phase 2 waits for phase_complete of phase 1; then epic-complete', async () => {
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { phase: 1, taskIds: ['1.1'] },
		});
		project.setStatus('1.1', 'completed');
		const ready = await runEpicNextWave(project.dir, SESSION);
		expect(ready).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
			closedWave: { seq: 1 },
		});
		if (ready.status === 'phase-ready-for-review') {
			expect(ready.message).toContain('epic_phase_review({ phase: 1 })');
			// Hand-off to the normal PHASE-WRAP, which dispatches the docs agent
			// that phase_complete requires (REQUIRED_AGENTS_MISSING otherwise).
			expect(ready.message).toContain('PHASE-WRAP');
			expect(ready.message).toContain('docs agent');
			expect(ready.message.indexOf('docs agent')).toBeLessThan(
				ready.message.indexOf('phase_complete('),
			);
		}
		expect(project.record().phases['1']?.status).toBe('review');
		// Idempotent; phase 2 is NOT issued before phase_complete.
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
		});
		expect(project.record().waves).toHaveLength(1);

		// The plan's own phase status turns `complete` as soon as every task
		// completes — that is NOT phase_complete and must not advance.
		project.setPhaseStatus(1, 'complete');
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 1,
		});
		markEpicPhaseComplete(project.dir, 1);
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 2, phase: 2, taskIds: ['2.1'] },
		});
		expect(project.record().phases).toMatchObject({
			'1': { status: 'complete' },
			'2': { status: 'active' },
		});
		project.setStatus('2.1', 'completed');
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			phase: 2,
		});
		markEpicPhaseComplete(project.dir, 2);
		const done = await runEpicNextWave(project.dir, SESSION);
		expect(done.status).toBe('epic-complete');
		if (done.status === 'epic-complete') {
			expect(done.message).toContain('/swarm epic close');
		}
		expect(project.record().phases['2']?.status).toBe('complete');
		// Idempotent.
		expect(markEpicPhaseComplete(project.dir, 2).outcome).toBe(
			'already-complete',
		);
	});

	test('a task reopened in a complete phase blocks task-reopened; a new one there blocks plan-revised', async () => {
		await runEpicNextWave(project.dir, SESSION);
		project.setStatus('1.1', 'completed');
		await runEpicNextWave(project.dir, SESSION);
		markEpicPhaseComplete(project.dir, 1);
		project.setStatus('1.1', 'pending');
		const reopened = await runEpicNextWave(project.dir, SESSION);
		expect(reopened).toMatchObject({
			status: 'blocked',
			reason: 'task-reopened',
			details: { taskIds: ['1.1'] },
		});
		// No coder can run outside a wave: close it, or re-add the work as a
		// NEW task of the current phase.
		if (reopened.status === 'blocked') {
			expect(reopened.message).toContain('update_task_status closed');
			expect(reopened.message).toContain('NEW task in the current phase');
			expect(reopened.message).not.toContain('per-task flow');
		}
		project.setStatus('1.1', 'completed');
		project.plan.phases[0].tasks.push({
			...project.plan.phases[0].tasks[0],
			id: '1.9',
			status: 'pending',
		});
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'plan-revised',
			details: { taskIds: ['1.9'] },
		});
		expect(project.record().waves).toHaveLength(1);
	});
});

describe('phase_complete out of order', () => {
	test('only the current phase can be recorded complete; next_wave keeps running phase 1', async () => {
		expect(markEpicPhaseComplete(project.dir, 2)).toEqual({
			outcome: 'not-current-phase',
			currentPhase: 1,
		});
		expect(project.record().phases['2']).toBeUndefined();
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { phase: 1, taskIds: ['1.1'] },
		});
		expect(markEpicPhaseComplete(project.dir, 1).outcome).toBe('recorded');
	});
});

describe('initialEpicPhases (start)', () => {
	test('phases finished before the epic starts are recorded complete; others are not', () => {
		const plan = project.plan;
		plan.phases[0].tasks[0].status = 'closed';
		expect(initialEpicPhases(plan)).toEqual({
			'1': {
				status: 'complete',
				completeAtStart: true,
				reviewRuns: 0,
				verdicts: [],
			},
		});
		plan.phases[0].tasks[0].status = 'pending';
		plan.phases[1].status = 'closed';
		expect(Object.keys(initialEpicPhases(plan))).toEqual(['2']);
	});
});

describe('declare-scopes', () => {
	test('wave members without a live binding get declare-scopes with files_touched suggestions; no wave issued', async () => {
		for (const key of Object.keys(project.live)) delete project.live[key];
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'declare-scopes',
			phase: 1,
			tasks: [{ taskId: '1.1', suggestedFiles: ['src/t1_1.ts'] }],
		});
		expect(project.record().waves).toEqual([]);
		project.live['1.1'] = ['src/t1_1.ts', 'src/extra.ts'];
		const dispatched = await runEpicNextWave(project.dir, SESSION);
		expect(dispatched).toMatchObject({
			status: 'dispatch',
			wave: { files: { '1.1': ['src/t1_1.ts', 'src/extra.ts'] } },
		});
	});
});

describe('refusals', () => {
	test('config gate off ⇒ epic-disabled-by-config', async () => {
		_internals.loadPluginConfigWithMeta = (() => ({
			config: { turbo: { strategy: 'standard' } },
		})) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'refused',
			reason: 'epic-disabled-by-config',
		});
	});

	test('unreadable state, orphaned and absent epics are refused distinctly', async () => {
		_internals.getOpenEpic = (() => {
			throw new Error('multiple Epic lifecycle rows present');
		}) as never;
		const unreadable = await runEpicNextWave(project.dir, SESSION);
		expect(unreadable).toMatchObject({
			status: 'refused',
			reason: 'epic-state-unreadable',
		});
		_internals.getOpenEpic = (() => null) as never;
		_internals.inspectEpic = (() => ({
			record: stubEpicRecord(),
			orphanReason: 'plan-renamed-or-replaced',
		})) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'refused',
			reason: 'epic-orphaned',
		});
		_internals.inspectEpic = (() => ({
			record: null,
			orphanReason: null,
		})) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'refused',
			reason: 'no-open-epic',
		});
	});
});

describe('branch drift', () => {
	test('EPIC_BRANCH_MISMATCH blocks before any wave work', async () => {
		_internals.checkEpicBranch = (() => ({
			ok: false,
			code: 'EPIC_BRANCH_MISMATCH',
			expected: 'swarm/epic/x',
			actual: 'main',
			message: 'EPIC_BRANCH_MISMATCH: run git checkout swarm/epic/x',
		})) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'epic-branch-mismatch',
			details: { expected: 'swarm/epic/x', actual: 'main' },
		});
		expect(project.record().waves).toEqual([]);
	});
});
