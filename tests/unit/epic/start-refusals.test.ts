/**
 * `/swarm epic start` (startEpic): every refusal, in order, plus success,
 * idempotence, --force and the non-git serial record. Real temp projects,
 * real git, real plan ledger; process-global inputs (in-memory Turbo
 * sessions, worktree dispatch maps, lifecycle inspection) go through the
 * start module's `_internals` seam (AGENTS.md #7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transitionCoordinationState } from '../../../src/db/coordination-store';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	EPIC_SENTINEL_RELATIVE_PATH,
	getOpenEpic,
} from '../../../src/epic/lifecycle';
import { _internals, startEpic } from '../../../src/epic/start';
import { savePlan } from '../../../src/plan/manager';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	createStartProject,
	EPIC_ON_CONFIG,
	git,
	sizedPlan,
	writeProjectConfig,
} from './start-fixture';

const realInternals = { ..._internals };
const dirs: string[] = [];
let restoreClock: Restore | null = null;

async function project(
	options: Parameters<typeof createStartProject>[1],
): Promise<string> {
	const dir = await createStartProject('epic-start-', options);
	dirs.push(dir);
	return dir;
}

function start(dir: string, force = false) {
	return startEpic({ directory: dir, sessionID: 'ses_start', force });
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-04-01T10:00:00.000Z' });
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

describe('refusals in order', () => {
	test('1. epic-disabled-by-config wins over every later failure', async () => {
		const dir = await project({ git: true, config: {}, plan: null });
		const result = await start(dir);
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'epic-disabled-by-config',
		});
		_internals.loadPluginConfigWithMeta = (() => {
			throw new Error('bad config');
		}) as never;
		expect((await start(dir)).status).toBe('refused');
		expect(fs.existsSync(path.join(dir, EPIC_SENTINEL_RELATIVE_PATH))).toBe(
			false,
		);
	});

	test('2. no-plan, then plan-ledger-unreadable', async () => {
		const dir = await project({ git: true, plan: null });
		expect(await start(dir)).toMatchObject({ reason: 'no-plan' });
		await savePlan(dir, sizedPlan('Start Plan', 6));
		_internals.readPlanEpochIdentity = (async () => {
			throw new Error('PLAN_LEDGER_TRUNCATED: bad line');
		}) as never;
		expect(await start(dir)).toMatchObject({
			reason: 'plan-ledger-unreadable',
			details: ['PLAN_LEDGER_TRUNCATED: bad line'],
		});
	});

	test('2. plan.json without a plan ledger ⇒ plan-ledger-unreadable (save the plan first)', async () => {
		const dir = await project({ git: true, plan: null });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify(sizedPlan('No Ledger', 6)),
		);
		const result = await start(dir, true);
		expect(result).toMatchObject({
			status: 'refused',
			reason: 'plan-ledger-unreadable',
		});
		if (result.status === 'refused') {
			expect(result.details.join(' ')).toContain(
				'Save the plan first (save_plan)',
			);
		}
		expect(getOpenEpic(dir)).toBeNull();
	});

	test('3. same plan ⇒ idempotent already-open; other plan ⇒ epic-open-for-other-plan', async () => {
		const dir = await project({ git: true });
		const first = await start(dir);
		expect(first.status).toBe('started');
		const again = await start(dir);
		expect(again.status).toBe('already-open');
		if (first.status === 'started' && again.status === 'already-open') {
			expect(again.record.token).toBe(first.record.token);
		}
		await savePlan(dir, sizedPlan('Another Plan', 6));
		const other = await start(dir);
		expect(other).toMatchObject({
			status: 'refused',
			reason: 'epic-open-for-other-plan',
		});
	});

	test('3. unreadable lifecycle state ⇒ epic-state-unreadable', async () => {
		const dir = await project({ git: true });
		_internals.inspectEpic = (() => ({
			sentinelPresent: true,
			sentinel: null,
			record: null,
			rowKeys: ['x'],
			unreadable: 'corrupt row',
			orphanReason: null,
			configEnabled: true,
		})) as never;
		expect(await start(dir)).toMatchObject({ reason: 'epic-state-unreadable' });
	});

	test('4. turbo-active: config turbo_mode, an in-memory Turbo session, a running Lean run', async () => {
		const dir = await project({ git: true });
		writeProjectConfig(dir, { ...EPIC_ON_CONFIG, turbo_mode: true });
		const byConfig = await start(dir);
		expect(byConfig).toMatchObject({ reason: 'turbo-active' });
		if (byConfig.status === 'refused') {
			expect(byConfig.details[0]).toContain('turbo_mode: true');
		}
		writeProjectConfig(dir, EPIC_ON_CONFIG);

		_internals.hasActiveTurboMode = () => true;
		expect(await start(dir)).toMatchObject({ reason: 'turbo-active' });
		_internals.hasActiveTurboMode = () => false;

		transitionCoordinationState(dir, {
			namespace: 'turbo.lean.session',
			entityKey: 'ses_lean',
			expectedRevision: null,
			generation: 1,
			status: 'running',
			payload: '{}',
		});
		const byLean = await start(dir);
		expect(byLean).toMatchObject({ reason: 'turbo-active' });
		if (byLean.status === 'refused') {
			expect(byLean.details[0]).toContain('ses_lean');
		}
	});

	test('4. a running Lean run in the legacy projection (no DB) is detected', async () => {
		const dir = await project({ git: false, plan: null });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'turbo-state.json'),
			JSON.stringify({ sessions: { ses_old: { status: 'running' } } }),
		);
		expect(_internals.findRunningLeanRun(dir)).toContain('ses_old');
	});

	test('5. dirty-baseline: changes outside .swarm refuse; .swarm changes do not', async () => {
		const dir = await project({ git: true });
		fs.writeFileSync(path.join(dir, 'stray.ts'), 'x');
		const dirty = await start(dir);
		expect(dirty).toMatchObject({ reason: 'dirty-baseline' });
		if (dirty.status === 'refused')
			expect(dirty.details[0]).toContain('stray.ts');
		fs.rmSync(path.join(dir, 'stray.ts'));
		fs.writeFileSync(path.join(dir, '.swarm', 'scratch.json'), '{}');
		expect((await start(dir)).status).toBe('started');
	});

	test('6. in-flight-coders refuses (detailed in start-inflight.test.ts)', async () => {
		const dir = await project({ git: true });
		_internals.countTrackedWorktreeDispatches = () => 2;
		expect(await start(dir)).toMatchObject({
			reason: 'in-flight-coders',
			details: [
				'2 worktree-isolated coder dispatch(es) running or awaiting merge-back — let them finish (`/swarm lanes` shows them)',
			],
		});
	});

	test('7. not-epic-sized reports reasons; --force opens and records forced', async () => {
		const dir = await project({ git: true, plan: sizedPlan('Small', 3) });
		const refused = await start(dir);
		expect(refused.status).toBe('refused');
		if (refused.status === 'refused') {
			expect(refused.reason).toBe('not-epic-sized');
			expect(refused.sizing?.reasons).toEqual(['too-few-tasks']);
		}
		expect(getOpenEpic(dir)).toBeNull();
		const forced = await start(dir, true);
		expect(forced.status).toBe('started');
		if (forced.status === 'started') expect(forced.record.forced).toBe(true);
	});

	test('7. no pending task ⇒ not-epic-sized even with --force', async () => {
		const plan = sizedPlan('Done', 3);
		for (const task of plan.phases[0].tasks) task.status = 'completed';
		const dir = await project({ git: true, plan });
		const forced = await start(dir, true);
		expect(forced).toMatchObject({
			status: 'refused',
			reason: 'not-epic-sized',
		});
		if (forced.status === 'refused') {
			expect(forced.details[0]).toContain('nothing to run');
		}
	});

	test('7. sizing config keys are honoured', async () => {
		const dir = await project({ git: true, plan: sizedPlan('Small', 3) });
		writeProjectConfig(dir, {
			epic: { mode: { enabled: true }, sizing: { min_tasks: 3 } },
		});
		git(dir, ['commit', '-q', '-am', 'sizing config']);
		expect((await start(dir)).status).toBe('started');
	});
});

describe('success record', () => {
	test('git: sentinel + row, epic-branch policy (default), worktree isolation, sizing', async () => {
		const dir = await project({ git: true });
		const result = await start(dir);
		expect(result.status).toBe('started');
		if (result.status !== 'started') return;
		const record = result.record;
		expect(record).toMatchObject({
			schema: 'epic-record-v1',
			status: 'open',
			startedAt: '2026-04-01T10:00:00.000Z',
			startedBySession: 'ses_start',
			forced: false,
			config: {
				commitPolicy: 'epic-branch',
				isolation: 'worktree',
				maxParallel: 4,
			},
		});
		expect(record.git.isRepo).toBe(true);
		expect(record.git.epicBranch).toBe(`swarm/epic/${record.epicKey}`);
		expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
			`swarm/epic/${record.epicKey}`,
		);
		expect(record.git.baseCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(record.sizing.epicSized).toBe(true);
		expect(record.sizing.serialSteps).toBe(2); // 6 disjoint tasks, width 4
		expect(record.epicKey).toBe(
			`start-swarm-Start_Plan-${record.planKey.slice(0, 12)}`,
		);
		expect(record.ledgerRootDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(getOpenEpic(dir)?.token).toBe(record.token);
	});

	test('non-git: allowed but serial (maxParallel 1) — only with --force', async () => {
		const dir = await project({ git: false });
		const refused = await start(dir);
		expect(refused).toMatchObject({ reason: 'not-epic-sized' });
		if (refused.status === 'refused') {
			expect(refused.sizing?.reasons).toEqual(['insufficient-parallelism']);
			expect(refused.sizing?.serialSteps).toBe(6);
		}
		const forced = await start(dir, true);
		expect(forced.status).toBe('started');
		if (forced.status === 'started') {
			expect(forced.record.config).toEqual({
				commitPolicy: 'current-branch',
				isolation: 'main-tree-nogit',
				maxParallel: 1,
			});
			expect(forced.record.git).toEqual({
				isRepo: false,
				baseCommit: null,
				originalBranch: null,
				epicBranch: null,
			});
		}
	});
});
