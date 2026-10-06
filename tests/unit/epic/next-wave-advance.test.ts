/**
 * `epic_next_wave` — the wave advance rule (Epic v2 C2).
 *
 * A wave closes when every task is resolved (plan status completed, closed,
 * or removed from the plan) and none has a relevant merge-back failure;
 * otherwise the call is idempotent `in-progress` or `blocked`
 * (`task-blocked`, `merge-failed`, `plan-revised`). Closing records the
 * outcomes and the call continues to the next wave. Real lifecycle row;
 * the plan is driven in memory (see next-wave-fixture.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { _internals, runEpicNextWave } from '../../../src/epic/next-wave';
import {
	initDurableStatusPath,
	_internals as mergeStatusInternals,
	recordWorktreeMergeFailure,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { type NextWaveProject, openNextWaveProject } from './next-wave-fixture';

const SESSION = 'ses_nextwave';
let project: NextWaveProject;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-08-01T10:00:00.000Z' });
	project = await openNextWaveProject([
		[{ id: '1.1' }, { id: '1.2' }, { id: '1.3', depends: ['1.1'] }],
	]);
	project.declareAll();
});

afterEach(() => {
	project.cleanup();
	restoreClock?.();
	restoreClock = null;
});

describe('dispatch → in-progress (idempotent) → close → next wave', () => {
	test('a wave closes once every task is completed and the next wave is issued', async () => {
		const first = await runEpicNextWave(project.dir, SESSION);
		expect(first.status).toBe('dispatch');
		if (first.status !== 'dispatch') return;
		expect(first.wave).toMatchObject({
			seq: 1,
			phase: 1,
			kind: 'parallel',
			taskIds: ['1.1', '1.2'],
			files: { '1.1': ['src/t1_1.ts'], '1.2': ['src/t1_2.ts'] },
		});
		expect(first.instructions).toContain('ALL in ONE assistant message');
		expect(first.instructions).toContain('Per-task QA is never waived');
		let record = project.record();
		expect(record.activeWaveSeq).toBe(1);
		expect(record.waves[0]).toMatchObject({
			seq: 1,
			status: 'issued',
			baseHead: null,
			cochange: null,
			issuedAt: '2026-08-01T10:00:00.000Z',
		});
		expect(record.phases['1']?.status).toBe('active');

		// Idempotent: same wave, nothing new written.
		const again = await runEpicNextWave(project.dir, SESSION);
		expect(again).toMatchObject({
			status: 'in-progress',
			waitingOn: [
				{ taskId: '1.1', state: 'pending' },
				{ taskId: '1.2', state: 'pending' },
			],
		});
		expect(project.record().waves).toHaveLength(1);

		project.setStatus('1.1', 'completed');
		const waiting = await runEpicNextWave(project.dir, SESSION);
		expect(waiting).toMatchObject({
			status: 'in-progress',
			waitingOn: [{ taskId: '1.2', state: 'pending' }],
		});
		if (waiting.status === 'in-progress') {
			expect(waiting.message).toContain(
				'do not re-dispatch a task whose coder may still be running',
			);
		}

		project.setStatus('1.2', 'completed');
		const next = await runEpicNextWave(project.dir, SESSION);
		expect(next.status).toBe('dispatch');
		if (next.status !== 'dispatch') return;
		expect(next.wave.taskIds).toEqual(['1.3']);
		expect(next.closedWave).toMatchObject({
			seq: 1,
			taskIds: ['1.1', '1.2'],
			resolutions: { '1.1': 'completed', '1.2': 'completed' },
		});
		record = project.record();
		expect(record.activeWaveSeq).toBe(2);
		expect(record.waves[0]).toMatchObject({
			status: 'closed',
			closedAt: '2026-08-01T10:00:00.000Z',
			closeHead: null,
		});
		expect(record.tasks['1.1']).toMatchObject({
			taskId: '1.1',
			phase: 1,
			waveSeq: 1,
			resolution: 'completed',
			declared: ['src/t1_1.ts'],
			undeclared: [],
			attribution: 'no-git',
			marker: { ref: null, sha: null, provenance: 'no-git' },
		});
	});
});

describe('resolutions: closed and removed close the wave; dependents block', () => {
	test('closed + removed tasks resolve the wave; a dependent of the closed task is predecessor-missing', async () => {
		await runEpicNextWave(project.dir, SESSION);
		project.setStatus('1.1', 'closed');
		const phase = project.plan.phases[0];
		phase.tasks = phase.tasks.filter((task) => task.id !== '1.2');
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'blocked',
			reason: 'predecessor-missing',
			details: {
				problems: [{ taskId: '1.3', dependency: '1.1', why: 'closed' }],
			},
			closedWave: { resolutions: { '1.1': 'closed', '1.2': 'removed' } },
		});
		if (result.status === 'blocked') {
			expect(result.message).toContain('update_task_status closed');
		}
		const record = project.record();
		expect(record.activeWaveSeq).toBeNull();
		expect(record.tasks['1.1']?.resolution).toBe('closed');
		expect(record.tasks['1.2']?.resolution).toBe('removed');
	});
});

describe('blocked wave tasks', () => {
	test('a blocked task blocks the close with the fix-or-close remedy; closing it advances', async () => {
		await runEpicNextWave(project.dir, SESSION);
		project.setStatus('1.1', 'completed');
		project.setStatus('1.2', 'blocked');
		const blocked = await runEpicNextWave(project.dir, SESSION);
		expect(blocked).toMatchObject({
			status: 'blocked',
			reason: 'task-blocked',
			details: { waveSeq: 1, taskIds: ['1.2'] },
		});
		if (blocked.status === 'blocked') {
			expect(blocked.message).toContain('update_task_status(closed)');
		}
		expect(project.record().waves[0]?.status).toBe('issued');
		project.setStatus('1.2', 'closed');
		expect((await runEpicNextWave(project.dir, SESSION)).status).toBe(
			'dispatch',
		);
	});

	test('a relevant merge failure blocks; its snapshot is recorded and kept on the outcome', async () => {
		await runEpicNextWave(project.dir, SESSION);
		let failing = true;
		const sinceSeen: number[] = [];
		_internals.relevantMergeFailureForProject = ((
			_dir: string,
			taskId: string,
			sinceMs: number,
		) => {
			sinceSeen.push(sinceMs);
			return failing && taskId === '1.2'
				? {
						outcome: 'failed',
						stage: 'merge',
						message: 'conflict in src/t1_2.ts',
						completedAt: Date.parse('2026-08-01T10:00:00.000Z'),
					}
				: undefined;
		}) as never;
		project.setStatus('1.1', 'completed');
		project.setStatus('1.2', 'completed');
		const blocked = await runEpicNextWave(project.dir, SESSION);
		expect(blocked).toMatchObject({
			status: 'blocked',
			reason: 'merge-failed',
			details: { failures: [{ taskId: '1.2', outcome: 'failed' }] },
		});
		// The epoch is the wave's issue time.
		expect(sinceSeen[0]).toBe(Date.parse('2026-08-01T10:00:00.000Z'));
		expect(project.record().waves[0]?.mergeFailures?.['1.2']).toMatchObject({
			outcome: 'failed',
			stage: 'merge',
		});
		failing = false;
		const next = await runEpicNextWave(project.dir, SESSION);
		expect(next.status).toBe('dispatch');
		expect(project.record().tasks['1.2']?.mergeFailure).toEqual({
			outcome: 'failed',
			stage: 'merge',
		});
	});

	test('a failure in the shared registry bound to ANOTHER project does not block this epic (real registry)', async () => {
		await runEpicNextWave(project.dir, SESSION);
		const other = canonicalMkdtemp('epic-other-project-');
		try {
			initDurableStatusPath(other);
			recordWorktreeMergeFailure('1.1', {
				outcome: 'failed',
				stage: 'merge',
				message: 'another project conflict',
				completedAt: Date.parse('2026-08-01T11:00:00.000Z'),
			});
			project.setStatus('1.1', 'completed');
			project.setStatus('1.2', 'completed');
			expect((await runEpicNextWave(project.dir, SESSION)).status).toBe(
				'dispatch',
			);
		} finally {
			mergeStatusInternals.resetForTest();
			fs.rmSync(other, { recursive: true, force: true });
		}
	});

	test('a closed (dropped) task with a merge failure does not hold the wave', async () => {
		await runEpicNextWave(project.dir, SESSION);
		_internals.relevantMergeFailureForProject = ((_d: string, id: string) =>
			id === '1.2'
				? { outcome: 'failed', stage: 'merge', message: 'x', completedAt: 1 }
				: undefined) as never;
		project.setStatus('1.1', 'completed');
		project.setStatus('1.2', 'closed');
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			closedWave: { resolutions: { '1.1': 'completed', '1.2': 'closed' } },
		});
	});

	test('an unresolved task moved to another phase aborts the wave (plan-revised); the next call replans', async () => {
		await runEpicNextWave(project.dir, SESSION);
		const [phase1] = project.plan.phases;
		const moved = phase1.tasks.find((task) => task.id === '1.2');
		if (!moved) throw new Error('fixture');
		phase1.tasks = phase1.tasks.filter((task) => task.id !== '1.2');
		project.plan.phases.push({
			id: 2,
			name: 'Phase 2',
			status: 'pending',
			tasks: [moved],
		});
		const revised = await runEpicNextWave(project.dir, SESSION);
		expect(revised).toMatchObject({
			status: 'blocked',
			reason: 'plan-revised',
			details: { waveSeq: 1, moved: [{ taskId: '1.2', phase: 2 }] },
		});
		const record = project.record();
		expect(record.activeWaveSeq).toBeNull();
		expect(record.waves[0]).toMatchObject({
			status: 'aborted',
			abortReason: 'plan revised: 1.2 moved to phase 2',
		});
		const replanned = await runEpicNextWave(project.dir, SESSION);
		expect(replanned).toMatchObject({
			status: 'dispatch',
			wave: { seq: 2, taskIds: ['1.1'] },
		});
	});
});

describe('wave records are written with the epic token', () => {
	test('a stale record (other token) writes nothing and refuses', async () => {
		const real = project.record();
		_internals.getOpenEpic = (() => ({
			...real,
			token: 'stale-token',
		})) as never;
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({ status: 'refused', reason: 'no-open-epic' });
		_internals.getOpenEpic = (() => project.record()) as never;
		expect(project.record().waves).toEqual([]);
		expect(project.record().activeWaveSeq).toBeNull();
	});
});
