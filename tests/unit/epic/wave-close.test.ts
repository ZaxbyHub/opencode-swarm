/**
 * Epic v2 C2 wave close (`src/epic/wave-close.ts`):
 *   - outcome fields from evidence (generation, Stage A/B lower bounds) and
 *     the plan ledger (resolution time, reopen count);
 *   - divergence sources: write attribution unioned across same-project
 *     sessions (coder CHILD sessions), never another project's; the git
 *     fallback (real repository) for a single-task wave, and wave-level
 *     undeclared files otherwise;
 *   - `applyWaveClose` is idempotent (a concurrent close wins once);
 *   - the learning posterior applies each closed wave once
 *     (`recordEpicWaveLearning`), and not at all with learning disabled.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { readEpicPosterior } from '../../../src/epic/learning-store';
import type { EpicWaveRecord } from '../../../src/epic/lifecycle';
import {
	_internals,
	applyWaveClose,
	computeWaveClose,
	recordEpicWaveLearning,
	releaseWaveAttribution,
} from '../../../src/epic/wave-close';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { phasePlan } from './next-wave-fixture';
import { git } from './start-fixture';

const realInternals = { ..._internals };
const NOW = '2026-08-04T10:00:00.000Z';
let dir: string;
let restoreClock: Restore | null = null;

function wave(overrides: Partial<EpicWaveRecord> = {}): EpicWaveRecord {
	return {
		seq: 1,
		phase: 1,
		kind: 'parallel',
		taskIds: ['1.1', '1.2'],
		files: { '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] },
		cochange: null,
		baseHead: null,
		issuedAt: NOW,
		status: 'issued',
		...overrides,
	};
}

function plan(statuses: Record<string, 'completed' | 'closed'>): Plan {
	return phasePlan([
		Object.entries(statuses).map(([id, status]) => ({ id, status })),
	]);
}

function session(project: string, files: Record<string, string[]>) {
	return {
		owningProjectKey: project,
		modifiedFilesByTask: new Map(Object.entries(files)),
	};
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: NOW });
	dir = canonicalMkdtemp('epic-wave-close-');
	_internals.readLedgerEvents = (async () => []) as never;
	_internals.readTaskEvidence = (async () => null) as never;
	_internals.listAgentSessions = () => [];
	_internals.getAgentSession = (() => undefined) as never;
	_internals.hydrationProjectKey = () => 'project-key';
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	restoreClock?.();
	restoreClock = null;
	fs.rmSync(dir, { recursive: true, force: true });
});

const noGitEpic = () =>
	stubEpicRecord({
		git: {
			isRepo: false,
			baseCommit: null,
			originalBranch: null,
			epicBranch: null,
		},
		startedAt: '2026-08-01T00:00:00.000Z',
	});

describe('outcome fields', () => {
	test('evidence workflow counts, ledger times and reopen count', async () => {
		_internals.readTaskEvidence = (async (_d: string, id: string) =>
			id === '1.1'
				? {
						workflow: {
							generation: 3,
							retryHistory: [
								'stage_a_failed',
								'stage_b_failed',
								'stage_b_failed',
							],
						},
					}
				: null) as never;
		_internals.readLedgerEvents = (async () => [
			{
				task_id: '1.1',
				event_type: 'task_status_changed',
				from_status: 'pending',
				to_status: 'completed',
				timestamp: '2026-08-02T00:00:00.000Z',
			},
			{
				task_id: '1.1',
				event_type: 'task_status_changed',
				from_status: 'completed',
				to_status: 'in_progress',
				timestamp: '2026-08-02T01:00:00.000Z',
			},
			{
				task_id: '1.1',
				event_type: 'task_status_changed',
				from_status: 'completed',
				to_status: 'pending',
				timestamp: '2026-07-01T00:00:00.000Z',
			},
			{
				task_id: '1.1',
				event_type: 'task_status_changed',
				from_status: 'in_progress',
				to_status: 'completed',
				timestamp: '2026-08-02T02:00:00.000Z',
			},
			{
				task_id: '1.2',
				event_type: 'task_status_changed',
				from_status: 'pending',
				to_status: 'closed',
				timestamp: '2026-08-02T03:00:00.000Z',
			},
		]) as never;
		const result = await computeWaveClose({
			directory: dir,
			epic: noGitEpic(),
			wave: wave(),
			plan: plan({ '1.1': 'completed', '1.2': 'closed' }),
			sessionID: undefined,
			nowIso: NOW,
		});
		expect(result.closeHead).toBeNull();
		expect(result.outcomes[0]).toMatchObject({
			taskId: '1.1',
			resolution: 'completed',
			resolvedAt: '2026-08-02T02:00:00.000Z',
			generation: 3,
			stageAFailures: 1,
			stageBFailures: 2,
			// The July reopen predates the epic start.
			reopened: 1,
			attribution: 'no-git',
			marker: { ref: null, sha: null, provenance: 'no-git' },
		});
		expect(result.outcomes[1]).toMatchObject({
			taskId: '1.2',
			resolution: 'closed',
			resolvedAt: '2026-08-02T03:00:00.000Z',
			generation: 0,
		});
	});

	test('a task missing from the plan resolves as removed', async () => {
		const result = await computeWaveClose({
			directory: dir,
			epic: noGitEpic(),
			wave: wave(),
			plan: plan({ '1.1': 'completed' }),
			sessionID: undefined,
			nowIso: NOW,
		});
		expect(result.outcomes[1]).toMatchObject({
			taskId: '1.2',
			resolution: 'removed',
			resolvedAt: NOW,
		});
	});
});

describe('divergence: session attribution', () => {
	test('child-session attribution of the same project counts; another project never does', async () => {
		const child = session('project-key', {
			'1.1': ['src/a.ts', 'src/extra.ts'],
		});
		const foreign = session('other-project', { '1.1': ['src/foreign.ts'] });
		const caller = session('project-key', { '1.2': ['src/b.ts'] });
		_internals.getAgentSession = (() => caller) as never;
		_internals.listAgentSessions = () =>
			[
				['ses_child', child],
				['ses_foreign', foreign],
				['ses_caller', caller],
			] as never;
		const result = await computeWaveClose({
			directory: dir,
			epic: noGitEpic(),
			wave: wave(),
			plan: plan({ '1.1': 'completed', '1.2': 'completed' }),
			sessionID: 'ses_caller',
			nowIso: NOW,
		});
		expect(result.outcomes[0]).toMatchObject({
			undeclared: ['src/extra.ts'],
			attribution: 'session',
		});
		expect(result.outcomes[1]).toMatchObject({
			undeclared: [],
			attribution: 'session',
		});
	});
});

describe('divergence: git fallback (real repository)', () => {
	let base: string;
	beforeEach(() => {
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 't@example.com']);
		git(dir, ['config', 'user.name', 'T']);
		git(dir, ['config', 'commit.gpgsign', 'false']);
		fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
		git(dir, ['add', '.']);
		git(dir, ['commit', '-q', '-m', 'seed']);
		base = git(dir, ['rev-parse', 'HEAD']).trim();
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'a\n');
		git(dir, ['add', 'src/a.ts']);
		git(dir, ['commit', '-q', '-m', 'swarm(task 1.1): a']);
		fs.writeFileSync(path.join(dir, 'src', 'stray.ts'), 'stray\n');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(dir, '.swarm', 'x.json'), '{}');
	});

	const gitEpic = () =>
		stubEpicRecord({ startedAt: '2026-08-01T00:00:00.000Z' });

	test('single-task wave: changed files since baseHead are the task’s actual files', async () => {
		const result = await computeWaveClose({
			directory: dir,
			epic: gitEpic(),
			wave: wave({
				taskIds: ['1.1'],
				files: { '1.1': ['src/a.ts'] },
				baseHead: base,
			}),
			plan: plan({ '1.1': 'completed' }),
			sessionID: undefined,
			nowIso: NOW,
		});
		const head = git(dir, ['rev-parse', 'HEAD']).trim();
		expect(result.closeHead).toBe(head);
		expect(result.outcomes[0]).toMatchObject({
			undeclared: ['src/stray.ts'],
			attribution: 'git-single-task',
			marker: {
				ref: 'refs/swarm/epics/test-swarm-Test_Plan-0123456789ab/tasks/1.1',
				sha: head,
				provenance: 'wave-close-head',
			},
		});
		expect(result.waveUndeclared).toEqual(['src/stray.ts']);
	});

	test('multi-task wave without attribution: undeclared kept at wave level only', async () => {
		const result = await computeWaveClose({
			directory: dir,
			epic: gitEpic(),
			wave: wave({ baseHead: base }),
			plan: plan({ '1.1': 'completed', '1.2': 'completed' }),
			sessionID: undefined,
			nowIso: NOW,
		});
		expect(result.outcomes.map((o) => o.attribution)).toEqual([
			'unavailable',
			'unavailable',
		]);
		expect(result.outcomes.map((o) => o.undeclared)).toEqual([[], []]);
		expect(result.waveUndeclared).toEqual(['src/stray.ts']);
	});
});

describe('applyWaveClose', () => {
	test('closes once; a second application is a no-op (concurrent close)', () => {
		const record = stubEpicRecord({ waves: [wave()], activeWaveSeq: 1 });
		const computation = {
			closeHead: null,
			outcomes: [],
			waveUndeclared: ['src/x.ts'],
		};
		const closed = applyWaveClose(record, 1, computation, NOW);
		expect(closed).not.toBe(record);
		expect(closed.activeWaveSeq).toBeNull();
		expect(closed.waves[0]).toMatchObject({
			status: 'closed',
			closedAt: NOW,
			undeclared: ['src/x.ts'],
		});
		expect(applyWaveClose(closed, 1, computation, NOW)).toBe(closed);
	});

	test('a task run again keeps its earlier counters as `previous` (learning charges the delta)', () => {
		const first = {
			taskId: '1.1',
			phase: 1,
			waveSeq: 1,
			resolution: 'completed' as const,
			resolvedAt: NOW,
			generation: 2,
			stageAFailures: 0,
			stageBFailures: 1,
			mergeFailure: null,
			declared: ['src/a.ts'],
			undeclared: [],
			attribution: 'session' as const,
			reopened: 0,
			marker: null,
		};
		const record = stubEpicRecord({
			waves: [
				{ ...wave(), status: 'closed' },
				wave({ seq: 2, taskIds: ['1.1'] }),
			],
			activeWaveSeq: 2,
			tasks: { '1.1': first },
		});
		const closed = applyWaveClose(
			record,
			2,
			{
				closeHead: null,
				outcomes: [{ ...first, waveSeq: 2, generation: 3, reopened: 1 }],
				waveUndeclared: [],
			},
			NOW,
		);
		expect(closed.tasks['1.1']).toMatchObject({
			waveSeq: 2,
			generation: 3,
			previous: { waveSeq: 1, generation: 2, stageBFailures: 1, reopened: 0 },
		});
	});
});

describe('recordEpicWaveLearning', () => {
	const config = (learning: Record<string, unknown> = {}) =>
		({
			epic: { mode: { enabled: true }, learning },
		}) as never;
	const closedRecord = () =>
		stubEpicRecord({
			waves: [{ ...wave(), status: 'closed', closedAt: NOW }],
			activeWaveSeq: null,
			tasks: {
				'1.1': {
					taskId: '1.1',
					phase: 1,
					waveSeq: 1,
					resolution: 'completed',
					resolvedAt: NOW,
					generation: 1,
					stageAFailures: 0,
					stageBFailures: 0,
					mergeFailure: null,
					declared: ['src/a.ts'],
					undeclared: ['src/hot.ts'],
					attribution: 'session',
					reopened: 0,
					marker: null,
				},
			},
		});

	test('applies the closed wave to the posterior exactly once', () => {
		const record = closedRecord();
		expect(
			recordEpicWaveLearning({ directory: dir, config: config(), record }),
		).toEqual([1]);
		expect(
			recordEpicWaveLearning({ directory: dir, config: config(), record }),
		).toEqual([]);
		const posterior = readEpicPosterior(dir);
		expect(posterior?.lastAppliedWaveSeq).toBe(1);
		expect(posterior?.increments.files.get('src/hot.ts')).toEqual({
			alpha: 1,
			beta: 0,
		});
		expect(posterior?.increments.edges.get('src/a.ts')?.get('src/hot.ts')).toBe(
			1,
		);
	});

	test('learning disabled: nothing is learned or written', () => {
		expect(
			recordEpicWaveLearning({
				directory: dir,
				config: config({ enabled: false }),
				record: closedRecord(),
			}),
		).toEqual([]);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'epic', 'posterior.json')),
		).toBe(false);
	});

	test('a failing update never throws (the wave flow continues)', () => {
		_internals.applyClosedWavesToPosterior = () => {
			throw new Error('disk full');
		};
		expect(
			recordEpicWaveLearning({
				directory: dir,
				config: config(),
				record: closedRecord(),
			}),
		).toEqual([]);
	});
});

describe('releaseWaveAttribution', () => {
	test('releases the closed tasks in every same-project session, never another project', () => {
		const caller = session('project-key', { '1.1': ['src/a.ts'] });
		const child = session('project-key', {
			'1.1': ['src/a.ts'],
			'9.9': ['src/keep.ts'],
		});
		const foreign = session('other-project', { '1.1': ['src/x.ts'] });
		_internals.getAgentSession = (() => caller) as never;
		_internals.listAgentSessions = () =>
			[
				['ses_caller', caller],
				['ses_child', child],
				['ses_foreign', foreign],
			] as never;
		releaseWaveAttribution(dir, 'ses_caller', ['1.1']);
		expect(caller.modifiedFilesByTask.has('1.1')).toBe(false);
		expect(child.modifiedFilesByTask.has('1.1')).toBe(false);
		expect(child.modifiedFilesByTask.get('9.9')).toEqual(['src/keep.ts']);
		expect(foreign.modifiedFilesByTask.get('1.1')).toEqual(['src/x.ts']);
	});
});
