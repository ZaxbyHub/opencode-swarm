/**
 * `epic_next_wave` — git-side rules (Epic v2 C2/C3), through the
 * `_internals` seam (no real repository needed):
 *   - predecessor evidence: a completed out-of-batch dependency counts only
 *     when its epic task ref (mirrored from the record) is an ancestor of
 *     HEAD, or it was completed before the epic started; a missing or
 *     unreachable ref blocks `predecessor-missing`, a git failure blocks
 *     `git-failed`;
 *   - dirty baseline (X1): declared-but-uncommitted files are committed as
 *     the task's residue, unattributed TRACKED changes block
 *     `dirty-baseline`, unattributed untracked files are only reported;
 *   - the issued wave records HEAD as `baseHead`;
 *   - with the co-change signal enabled, co-changing tasks are kept apart
 *     and the in-wave pairs are frozen into the record.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { markEpicPhaseComplete } from '../../../src/epic/lifecycle';
import { epicTaskRef } from '../../../src/epic/markers';
import { _internals, runEpicNextWave } from '../../../src/epic/next-wave';
import type { DirtyEntry } from '../../../src/epic/residue-commit';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { type NextWaveProject, openNextWaveProject } from './next-wave-fixture';

const SESSION = 'ses_git';
const HEAD = 'a'.repeat(40);
const LANDED = 'b'.repeat(40);
let project: NextWaveProject;
let restoreClock: Restore | null = null;
let refSyncs = 0;
let ancestorChecks: string[] = [];
let residueCalls: Array<{ taskId: string; files: string[] }> = [];

const GIT_OVERRIDES = {
	config: {
		commitPolicy: 'current-branch' as const,
		isolation: 'worktree' as const,
		maxParallel: 4,
	},
	git: {
		isRepo: true,
		baseCommit: HEAD,
		originalBranch: 'main',
		epicBranch: null,
	},
};

/** 1.1 completed DURING the epic (a ledger transition after its start). */
const COMPLETED_DURING_EPIC = async () => [
	{
		event_type: 'task_status_changed',
		task_id: '1.1',
		from_status: 'in_progress',
		to_status: 'completed',
		timestamp: '2026-08-03T09:00:00.000Z',
	},
];

function dirty(entries: DirtyEntry[]): void {
	_internals.listDirtyEntries = () => entries;
}

async function open(
	config?: Record<string, unknown>,
	phases = [
		[
			{ id: '1.1', status: 'completed' as const },
			{ id: '1.2', depends: ['1.1'] },
			{ id: '1.3' },
		],
	],
): Promise<void> {
	project = await openNextWaveProject(phases, {
		config,
		overrides: GIT_OVERRIDES,
	});
	project.declareAll();
	_internals.checkEpicBranch = (() => ({ ok: true })) as never;
	dirty([]);
	_internals.readHead = () => HEAD;
	_internals.readLedgerEvents = COMPLETED_DURING_EPIC as never;
	refSyncs = 0;
	ancestorChecks = [];
	residueCalls = [];
	const epicKey = project.record().epicKey;
	_internals.syncEpicRefs = (() => {
		refSyncs += 1;
		return new Map([[epicTaskRef(epicKey, '1.1'), LANDED]]);
	}) as never;
	_internals.isCommitAncestorOfHead = ((_dir: string, sha: string) => {
		ancestorChecks.push(sha);
		return true;
	}) as never;
	// Matches like the real one: dirty paths among the candidates or under
	// the declared scopes.
	_internals.commitTaskResidue = ((args: {
		taskId: string;
		candidates: Iterable<string>;
		scopes?: string[];
		dirty: DirtyEntry[];
	}) => {
		const wanted = new Set(args.candidates);
		const files = args.dirty
			.map((entry) => entry.path)
			.filter(
				(file) =>
					wanted.has(file) ||
					(args.scopes ?? []).some(
						(scope) => file === scope || file.startsWith(`${scope}/`),
					),
			);
		if (files.length === 0) return { status: 'nothing' };
		residueCalls.push({ taskId: args.taskId, files });
		return { status: 'committed', sha: LANDED, files };
	}) as never;
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-08-03T10:00:00.000Z' });
});

afterEach(() => {
	project.cleanup();
	restoreClock?.();
	restoreClock = null;
});

describe('predecessor evidence (epic task refs)', () => {
	test('a predecessor whose task ref is an ancestor of HEAD admits its dependent; baseHead is recorded', async () => {
		await open();
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.2', '1.3'] },
		});
		expect(refSyncs).toBe(1);
		expect(ancestorChecks).toEqual([LANDED]);
		expect(project.record().waves[0]?.baseHead).toBe(HEAD);
	});

	test('no task ref (completed outside a wave) ⇒ predecessor-missing with the repair remedy', async () => {
		await open();
		_internals.syncEpicRefs = (() => new Map()) as never;
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'blocked',
			reason: 'predecessor-missing',
			details: {
				problems: [{ taskId: '1.2', dependency: '1.1', why: 'not-committed' }],
			},
		});
		if (result.status === 'blocked') {
			expect(result.message).toContain('/swarm epic status --repair-refs');
			expect(result.message).toContain('Swarm-Plan: 0123456789abcdef');
		}
		expect(project.record().waves).toEqual([]);
	});

	test('a task ref no longer reachable from HEAD (rebase/amend) ⇒ predecessor-missing', async () => {
		await open();
		_internals.isCommitAncestorOfHead = (() => false) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'predecessor-missing',
		});
	});

	test('a predecessor completed BEFORE the epic started needs no ref', async () => {
		// 1.1 was saved completed with the plan (no ledger transition): its
		// work is in HEAD because start refused a dirty tree.
		await open(undefined, [
			[{ id: '1.1', status: 'completed' }],
			[{ id: '2.1', depends: ['1.1'] }],
		]);
		_internals.readLedgerEvents = (async () => []) as never;
		_internals.syncEpicRefs = (() => new Map()) as never;
		expect(markEpicPhaseComplete(project.dir, 1).outcome).toBe('recorded');
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { phase: 2, taskIds: ['2.1'] },
		});
		expect(ancestorChecks).toEqual([]);
	});

	test('a git failure reading/writing refs or checking ancestry blocks git-failed (fail closed)', async () => {
		await open();
		_internals.syncEpicRefs = (() => {
			throw new Error('index.lock exists');
		}) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'git-failed',
			details: { error: 'index.lock exists' },
		});
		_internals.syncEpicRefs = (() =>
			new Map([
				[epicTaskRef(project.record().epicKey, '1.1'), LANDED],
			])) as never;
		_internals.isCommitAncestorOfHead = (() => {
			throw new Error('git merge-base timed out');
		}) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'git-failed',
		});
		expect(project.record().waves).toEqual([]);
	});

	test('no out-of-batch completed dependency ⇒ no ref read at all', async () => {
		await open(undefined, [[{ id: '1.1' }, { id: '1.2' }]]);
		expect((await runEpicNextWave(project.dir, SESSION)).status).toBe(
			'dispatch',
		);
		expect(refSyncs).toBe(0);
	});
});

describe('dirty baseline (X1)', () => {
	test('unattributed TRACKED changes block before a wave is issued; a git failure blocks git-failed', async () => {
		await open();
		dirty([{ path: 'src/stray.ts', untracked: false }]);
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'blocked',
			reason: 'dirty-baseline',
			details: { files: ['src/stray.ts'], total: 1 },
		});
		expect(residueCalls).toEqual([]);
		expect(project.record().waves).toEqual([]);
		_internals.listDirtyEntries = () => {
			throw new Error('git status timed out');
		};
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'git-failed',
		});
	});

	test('unattributed untracked files are only reported in the dispatch instructions', async () => {
		await open();
		dirty([{ path: 'notes/todo.txt', untracked: true }]);
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result.status).toBe('dispatch');
		if (result.status === 'dispatch') {
			expect(result.instructions).toContain(
				'1 untracked file(s) outside .swarm/ belong to no task (notes/todo.txt)',
			);
		}
		expect(residueCalls).toEqual([]);
	});

	test('files declared by a task of an earlier wave are committed as its residue first', async () => {
		await open(undefined, [[{ id: '1.1' }, { id: '1.2' }]]);
		// Wave 1 issued and closed with 1.1 and 1.2 completed.
		const first = await runEpicNextWave(project.dir, SESSION);
		expect(first.status).toBe('dispatch');
		project.setStatus('1.1', 'completed');
		project.setStatus('1.2', 'completed');
		// The closing wave commits the residue its tasks declared.
		dirty([{ path: 'src/t1_1.ts', untracked: false }]);
		const second = await runEpicNextWave(project.dir, SESSION);
		expect(second.status).toBe('phase-ready-for-review');
		expect(residueCalls).toEqual([{ taskId: '1.1', files: ['src/t1_1.ts'] }]);
	});

	test('a residue commit that fails at wave close keeps the wave open (git-failed)', async () => {
		await open(undefined, [[{ id: '1.1' }]]);
		expect((await runEpicNextWave(project.dir, SESSION)).status).toBe(
			'dispatch',
		);
		project.setStatus('1.1', 'completed');
		dirty([{ path: 'src/t1_1.ts', untracked: false }]);
		_internals.commitTaskResidue = (() => ({
			status: 'failed',
			error: 'index.lock exists',
			files: ['src/t1_1.ts'],
		})) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'git-failed',
		});
		expect(project.record().waves[0]?.status).toBe('issued');
	});

	test('an edit made after its wave closed is never a residue: it blocks dirty-baseline', async () => {
		await open(undefined, [[{ id: '1.1' }, { id: '1.2', depends: ['1.1'] }]]);
		_internals.readLedgerEvents = (async () => []) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.1'] },
		});
		project.setStatus('1.1', 'completed');
		let statusReads = 0;
		_internals.listDirtyEntries = () =>
			++statusReads === 1 ? [] : [{ path: 'src/t1_1.ts', untracked: false }];
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'blocked',
			reason: 'dirty-baseline',
			details: { files: ['src/t1_1.ts'] },
		});
		expect(residueCalls).toEqual([]);
	});

	test('a landing refused for a dirty index blocks landing-index-dirty with the remedy', async () => {
		await open(undefined, [[{ id: '1.1' }]]);
		expect((await runEpicNextWave(project.dir, SESSION)).status).toBe(
			'dispatch',
		);
		project.setStatus('1.1', 'completed');
		_internals.relevantMergeFailureForProject = (() => ({
			outcome: 'failed',
			stage: 'epic-landing-index',
			message:
				'EPIC_LANDING_INDEX_DIRTY: task 1.1 was not landed … Remedy: unstage them (`git restore --staged -- README.md`), then re-dispatch the task',
			completedAt: Date.parse('2026-08-03T10:00:00.000Z'),
		})) as never;
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'blocked',
			reason: 'landing-index-dirty',
		});
		if (result.status === 'blocked') {
			expect(result.message).toContain('git restore --staged -- README.md');
		}
		expect(project.record().waves[0]?.status).toBe('issued');
	});

	test('the closing wave residue waits for a landing in progress (serialized)', async () => {
		await open(undefined, [[{ id: '1.1' }]]);
		expect((await runEpicNextWave(project.dir, SESSION)).status).toBe(
			'dispatch',
		);
		project.setStatus('1.1', 'completed');
		dirty([{ path: 'src/t1_1.ts', untracked: false }]);
		const order: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		_internals.serializeWithMergeBacks = (async <T>(
			task: () => T | Promise<T>,
		): Promise<T> => {
			order.push('queued');
			await gate;
			order.push('run');
			return task();
		}) as never;
		const pending = runEpicNextWave(project.dir, SESSION);
		await new Promise((resolve) => setImmediate(resolve));
		expect(residueCalls).toEqual([]);
		release();
		await pending;
		expect(order).toEqual(['queued', 'run']);
		expect(residueCalls).toEqual([{ taskId: '1.1', files: ['src/t1_1.ts'] }]);
	});
});

describe('co-change signal', () => {
	const COCHANGE_ON = {
		epic: {
			mode: { enabled: true },
			cochange: { enabled: true, threshold: 0.5, min_co_changes: 2 },
		},
	};

	test('enabled: co-changing tasks are kept apart and in-wave pairs are frozen', async () => {
		await open(COCHANGE_ON, [[{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }]]);
		_internals.getCoChangeData = (async () => ({
			pairs: [
				{
					fileA: 'src/t1_1.ts',
					fileB: 'src/t1_2.ts',
					npmi: 0.9,
					coChangeCount: 4,
				},
				{
					fileA: 'src/t1_1.ts',
					fileB: 'src/t1_3.ts',
					npmi: 0.1,
					coChangeCount: 4,
				},
			],
			commitsObserved: 30,
		})) as never;
		const result = await runEpicNextWave(project.dir, SESSION);
		expect(result).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.1', '1.3'] },
		});
		expect(project.record().waves[0]?.cochange).toEqual({
			pairs: [],
			threshold: { npmi: 0.5, minCoChanges: 2 },
		});
	});

	test('disabled (default): co-change data is never fetched; path-only', async () => {
		await open(undefined, [[{ id: '1.1' }, { id: '1.2' }]]);
		let fetched = 0;
		_internals.getCoChangeData = (async () => {
			fetched += 1;
			return { pairs: [], commitsObserved: 0 };
		}) as never;
		expect(await runEpicNextWave(project.dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['1.1', '1.2'] },
		});
		expect(fetched).toBe(0);
		expect(project.record().waves[0]?.cochange).toBeNull();
	});
});
