/**
 * Production wiring tests for the Lean Turbo Rule-3 upstream-commit gate
 * (issue #2962).
 *
 * `planLeanTurboLanes` has always reserved an optional `isUpstreamCommitted`
 * predicate, but neither production caller supplied it, so
 * `makeDependencySatisfactionChecker` treated every cross-batch `depends:`
 * upstream as implicitly satisfied. This suite pins the wiring:
 *
 *  - helper arms for `resolveLeanRule3Predicate` (epic-gated; committed set
 *    from the CURRENT Epic marker machinery; unborn-HEAD vs genuine-git-failure
 *    taxonomy; warn-once contract),
 *  - the `lean_turbo_plan_lanes` tool path (probe-shaped differentiated
 *    placement),
 *  - the `LeanTurboRunner.runPhase` call shape (args[5] predicate capture),
 *  - real-git evidence arms (merge-shaped landings, plan-key filtering,
 *    scrubbed ids, unborn HEAD).
 *
 * DI goes through the module `_internals` seams only (no `mock.module`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EpicRecordV1 } from '../../../../src/epic/lifecycle';
import {
	computePlanKey,
	formatEpicTaskCommitMessage,
} from '../../../../src/epic/plan-key';
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import { executeLeanTurboPlanLanes } from '../../../../src/tools/lean-turbo-plan-lanes';
import type { planLeanTurboLanes } from '../../../../src/turbo/lean/planner';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import * as leanState from '../../../../src/turbo/lean/state';
import {
	resolveLeanRule3Predicate,
	_internals as uc,
} from '../../../../src/turbo/lean/upstream-committed';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const SESSION_ID = 'sess-rule3-wiring';
const PLAN_KEY = computePlanKey('test-identity-hash', null);
const OTHER_PLAN_KEY = computePlanKey('other-identity-hash', null);

const realUc = { ...uc };
const realRunnerInternals = { ...LeanTurboRunner._internals };

let tmpDir: string;

/** Minimal EpicRecordV1 stand-in with the fields the helper consumes. */
function openEpicRecord(baseCommit: string | null): EpicRecordV1 {
	return {
		schema: 'epic-record-v1',
		epicKey: 'epic-test',
		token: 'tok',
		planId: 'plan-test',
		planIdentityHash: 'test-identity-hash',
		planEpoch: null,
		planKey: PLAN_KEY,
		ledgerRootDigest: null,
		status: 'open',
		startedAt: '2026-01-01T00:00:00.000Z',
		startedBySession: SESSION_ID,
		forced: false,
		structureHashAtStart: 'x',
		config: {} as EpicRecordV1['config'],
		git: { baseCommit, originalBranch: 'main' } as EpicRecordV1['git'],
		sizing: {} as EpicRecordV1['sizing'],
		priorDigest: null,
		closing: null,
		waves: [],
		activeWaveSeq: null,
		tasks: {},
		phases: {},
	};
}

function seamEpicOpen(record: EpicRecordV1 | null = openEpicRecord(null)) {
	uc.isEpicOpenForProject = () => record !== null;
	uc.getOpenEpic = () => record;
}

function seamCommitted(...taskIds: string[]) {
	const set = new Map(taskIds.map((id) => [id, `sha-${id}`]));
	const calls = mock(() => set);
	uc.findTaskCommits = calls;
	return calls;
}

function git(dir: string, args: string[]): string {
	const r = spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

function writeScratchProject(): void {
	fs.mkdirSync(path.join(tmpDir, '.swarm', 'scopes'), { recursive: true });
	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'scopes', 'scope-2.1.json'),
		JSON.stringify({
			taskId: '2.1',
			files: ['src/a.ts'],
			declaredAt: '2026-01-01T00:00:00.000Z',
		}),
	);
	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Rule 3 Wiring Plan',
			swarm: 'test-swarm',
			current_phase: 2,
			phases: [
				{
					id: 2,
					name: 'Phase 2',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							description: 'downstream with cross-batch dep',
							status: 'pending',
							phase: 2,
							size: 'small',
							depends: ['1.1'],
							acceptance: 'Done',
						},
					],
				},
			],
			lean: {
				max_parallel_coders: 4,
				require_declared_scope: true,
				conflict_policy: 'serialize',
				degrade_on_risk: true,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
				allow_docs_only_without_reviewer: false,
				worktree_isolation: false,
			},
		}),
	);
}

function placementShape(result: ReturnType<typeof planLeanTurboLanes>) {
	return {
		placed: [
			...result.lanes.flatMap((l) => l.taskIds),
			...result.serializedTasks,
		],
		degraded: result.degradedTasks.map(
			(d) => `${d.taskId}: ${d.reason}` as const,
		),
	};
}

beforeEach(() => {
	resetSwarmState();
	startAgentSession(SESSION_ID, 'architect');
	tmpDir = canonicalMkdtemp('rule3-wiring-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
});

afterEach(() => {
	Object.assign(uc, realUc);
	Object.assign(LeanTurboRunner._internals, realRunnerInternals);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

describe('resolveLeanRule3Predicate helper arms', () => {
	test('epic-active + committed upstream: predicate defined and true for landed ids', () => {
		seamEpicOpen();
		seamCommitted('1.1');
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1', '2.1']);
		expect(predicate).toBeDefined();
		expect(predicate?.('1.1')).toBe(true);
		expect(predicate?.('2.1')).toBe(false);
	});

	test('epic-inactive (no open Epic): predicate is undefined — pure-lean legacy branch', () => {
		seamEpicOpen(null);
		const findCalls = seamCommitted('1.1');
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])).toBeUndefined();
		expect(findCalls).not.toHaveBeenCalled();
	});

	test('unreadable Epic state (isEpicOpenForProject false): predicate undefined', () => {
		uc.isEpicOpenForProject = () => false;
		uc.getOpenEpic = () => {
			throw new Error('EpicStateUnreadable');
		};
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])).toBeUndefined();
	});

	test('mid-flight getOpenEpic throw: undefined + warnOnce seam invoked on each failure', () => {
		uc.isEpicOpenForProject = () => true;
		uc.getOpenEpic = () => {
			throw new Error('unreadable mid-read');
		};
		const warns: string[] = [];
		uc.warnOnce = (_dir, message) => {
			warns.push(message);
		};
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])).toBeUndefined();
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])).toBeUndefined();
		expect(warns.length).toBe(2);
	});

	test('warnOnce dedup: one operator-visible criticalWarn per directory', () => {
		const seen: string[] = [];
		uc.criticalWarn = (message: string) => {
			seen.push(message);
		};
		// realUc.warnOnce is the production dedup implementation
		realUc.warnOnce(`${tmpDir}`, 'first');
		realUc.warnOnce(`${tmpDir}`, 'second — deduped');
		realUc.warnOnce(`${tmpDir}-other`, 'other dir');
		expect(seen.length).toBe(2);
		expect(seen[0]).toContain('first');
		expect(seen[1]).toContain('other dir');
	});

	test('close/config race (getOpenEpic returns null on the second read): undefined, no warning', () => {
		uc.isEpicOpenForProject = () => true;
		uc.getOpenEpic = () => null;
		const warns: string[] = [];
		uc.warnOnce = (_dir, message) => {
			warns.push(message);
		};
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])).toBeUndefined();
		expect(warns.length).toBe(0);
	});

	test('unborn HEAD (probe classifies unborn): defined predicate with EMPTY committed set', () => {
		seamEpicOpen();
		uc.findTaskCommits = () => {
			throw new Error('fatal: bad revision HEAD');
		};
		uc.headCommitExists = () => 'unborn';
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1']);
		expect(predicate).toBeDefined();
		expect(predicate?.('1.1')).toBe(false);
	});

	test('genuine git failure (HEAD exists, log read fails): permissive predicate + warnOnce', () => {
		seamEpicOpen();
		uc.findTaskCommits = () => {
			throw new Error('spawn timeout');
		};
		uc.headCommitExists = () => 'exists';
		const warns: string[] = [];
		uc.warnOnce = (_dir, message) => {
			warns.push(message);
		};
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1']);
		expect(predicate).toBeDefined();
		expect(predicate?.('1.1')).toBe(true);
		expect(warns.length).toBe(1);
	});

	test('probe failure (unknown, and probe throw): permissive predicate + warnOnce, never () => false', () => {
		seamEpicOpen();
		uc.findTaskCommits = () => {
			throw new Error('log failed');
		};
		const warns: string[] = [];
		uc.warnOnce = (_dir, message) => {
			warns.push(message);
		};
		uc.headCommitExists = () => 'unknown';
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])?.('1.1')).toBe(true);
		uc.headCommitExists = () => {
			throw new Error('probe spawn error');
		};
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])?.('1.1')).toBe(true);
		expect(warns.length).toBe(2);
	});
});

describe('lean_turbo_plan_lanes tool wiring (probe-shaped)', () => {
	test('tool, epic-active + uncommitted upstream: task degraded, absent from lanes and serializedTasks', async () => {
		writeScratchProject();
		seamEpicOpen();
		seamCommitted(); // nothing landed
		const result = await executeLeanTurboPlanLanes({
			directory: tmpDir,
			phase: 2,
		});
		expect(result.success).toBe(true);
		const shape = placementShape(result.plan);
		expect(shape.placed).not.toContain('2.1');
		expect(
			shape.degraded.some(
				(d) => /greenfield-smart Rule 3/.test(d) && d.includes('1.1'),
			),
		).toBe(true);
	});

	test('tool, epic-active + committed upstream (swarm(task 1.1) in marker set): task placed in a lane', async () => {
		writeScratchProject();
		seamEpicOpen();
		seamCommitted('1.1');
		const result = await executeLeanTurboPlanLanes({
			directory: tmpDir,
			phase: 2,
		});
		const shape = placementShape(result.plan);
		expect(shape.placed).toContain('2.1');
		expect(shape.degraded.length).toBe(0);
	});

	test('tool, epic-inactive: marker machinery untouched, legacy placement', async () => {
		writeScratchProject();
		seamEpicOpen(null);
		const findCalls = seamCommitted();
		const result = await executeLeanTurboPlanLanes({
			directory: tmpDir,
			phase: 2,
		});
		const shape = placementShape(result.plan);
		expect(shape.placed).toContain('2.1');
		expect(shape.degraded.length).toBe(0);
		expect(findCalls).not.toHaveBeenCalled();
	});
});

describe('LeanTurboRunner.runPhase wiring (call shape)', () => {
	function captureArgs5(): {
		captured: Array<unknown>;
		restore: () => void;
	} {
		const orig = LeanTurboRunner._internals.planLeanTurboLanes;
		const captured: Array<unknown> = [];
		LeanTurboRunner._internals.planLeanTurboLanes = mock(
			(...args: Parameters<typeof orig>) => {
				captured.push(args[5]);
				return orig(...args);
			},
		);
		return {
			captured,
			restore: () => {
				LeanTurboRunner._internals.planLeanTurboLanes = orig;
			},
		};
	}

	function mockSessionOps() {
		return {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-session-1' }, error: null }),
			),
			prompt: mock(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
			delete: mock(() => Promise.resolve()),
		};
	}

	async function runPhaseTwo(): Promise<void> {
		const runner = new LeanTurboRunner({
			directory: tmpDir,
			sessionID: SESSION_ID,
			leanConfig: {
				...({} as Record<string, never>),
				max_parallel_coders: 4,
				require_declared_scope: true,
				conflict_policy: 'serialize',
				degrade_on_risk: true,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
				allow_docs_only_without_reviewer: false,
				worktree_isolation: false,
			},
		});
		(runner as unknown as { _sessionOps: unknown })._sessionOps =
			mockSessionOps();
		await runner.runPhase(2);
	}

	test('runner, epic-active + committed upstream: args[5] predicate defined, task placed', async () => {
		writeScratchProject();
		seamEpicOpen();
		seamCommitted('1.1');
		const { captured, restore } = captureArgs5();
		try {
			await runPhaseTwo();
		} finally {
			restore();
		}
		expect(captured.length).toBe(1);
		expect(typeof captured[0]).toBe('function');
		expect((captured[0] as (id: string) => boolean)('1.1')).toBe(true);
	});

	test('runner, epic-inactive: args[5] is undefined, legacy placement', async () => {
		writeScratchProject();
		seamEpicOpen(null);
		const findCalls = seamCommitted();
		const { captured, restore } = captureArgs5();
		try {
			await runPhaseTwo();
		} finally {
			restore();
		}
		expect(captured.length).toBe(1);
		expect(captured[0]).toBeUndefined();
		expect(findCalls).not.toHaveBeenCalled();
	});
});

describe('real-git evidence arms (current Epic marker machinery, no seams)', () => {
	function initRepo(): string {
		git(tmpDir, ['init', '--initial-branch=main']);
		git(tmpDir, ['config', 'user.email', 'test@example.com']);
		git(tmpDir, ['config', 'user.name', 'Rule3 Test']);
		fs.writeFileSync(path.join(tmpDir, 'base.txt'), 'base\n');
		git(tmpDir, ['add', '.']);
		git(tmpDir, ['commit', '-m', 'base commit']);
		return git(tmpDir, ['rev-parse', 'HEAD']).trim();
	}

	/** Mirror the production landing shape: work committed on a lane branch,
	 * then merged back with `git merge --no-ff -m <swarm(task ...)>` — the
	 * marker lands on a MERGE commit, which a `--no-merges` scan would miss. */
	function landTask(taskId: string, planKey: string): void {
		const safe = taskId.replace(/\W/g, '_');
		git(tmpDir, ['checkout', '-q', '-b', `lane-${safe}`]);
		fs.writeFileSync(path.join(tmpDir, `${safe}.txt`), 'landed\n');
		git(tmpDir, ['add', '.']);
		git(tmpDir, ['commit', '-m', `wip ${safe}`]);
		git(tmpDir, ['checkout', '-q', 'main']);
		git(tmpDir, [
			'merge',
			'--no-ff',
			'-m',
			formatEpicTaskCommitMessage(taskId, planKey, 'landed work'),
			`lane-${safe}`,
		]);
	}

	beforeEach(() => {
		seamEpicOpen(openEpicRecord(null)); // epicCommitRange falls back to 'HEAD'
	});

	test('merge-shaped --no-ff landing satisfies the predicate for its task id', () => {
		initRepo();
		landTask('1.1', PLAN_KEY);
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1', '2.1']);
		expect(predicate?.('1.1')).toBe(true);
		expect(predicate?.('2.1')).toBe(false);
	});

	test('same task id under a DIFFERENT plan key does NOT satisfy the predicate', () => {
		initRepo();
		landTask('1.1', OTHER_PLAN_KEY);
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1']);
		expect(predicate?.('1.1')).toBe(false);
	});

	test('scrubbed task id maps back to the raw plan id', () => {
		initRepo();
		const rawId = '1.1 (a)';
		landTask(rawId, PLAN_KEY); // subject carries the scrubbed id
		const predicate = resolveLeanRule3Predicate(tmpDir, [rawId]);
		expect(predicate?.(rawId)).toBe(true);
	});

	test('unborn HEAD (empty repository): defined predicate, empty committed set', () => {
		git(tmpDir, ['init', '--initial-branch=main']);
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1']);
		expect(predicate).toBeDefined();
		expect(predicate?.('1.1')).toBe(false);
	});
});
