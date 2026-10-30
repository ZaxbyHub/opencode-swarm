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
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import { executeLeanTurboPlanLanes } from '../../../../src/tools/lean-turbo-plan-lanes';
import type { planLeanTurboLanes } from '../../../../src/turbo/lean/planner';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import * as leanState from '../../../../src/turbo/lean/state';
import {
	resolveLeanRule3Predicate,
	_internals as uc,
} from '../../../../src/turbo/lean/upstream-committed';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';
import {
	OTHER_PLAN_KEY,
	openEpicRecord,
	PLAN_KEY,
	seamEpicOpen,
} from './_rule3-fixtures';

const SESSION_ID = 'sess-rule3-wiring';
const realUc = { ...uc };
const realRunnerInternals = { ...LeanTurboRunner._internals };

let tmpDir: string;

/** Seam that records the taskIds the wiring actually passes (TC-03/F1: the
 * committed arms must fail if the wiring drops or scrambles the plan's
 * task-id set) and answers with the given committed-id set. */
function seamCommitted(recordedTaskIds: string[], ...committed: string[]) {
	const set = new Map(committed.map((id) => [id, `sha-${id}`]));
	const calls = mock(
		(
			_directory: string,
			_range: string,
			_planKey: string,
			taskIds: readonly string[],
		) => {
			recordedTaskIds.length = 0;
			recordedTaskIds.push(...taskIds);
			return set;
		},
	);
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
					id: 1,
					name: 'Phase 1',
					status: 'completed',
					tasks: [
						{
							id: '1.1',
							description: 'upstream landed in a prior phase',
							status: 'completed',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
					],
				},
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
	// The dedup registry is module-level and NOT restored by the spread above
	// (PRR-006/TC-08): clear it so tests stay order-independent.
	uc.warnedDirectories.clear();
	resetSwarmState();
	removeTreeWithRetry(tmpDir);
});

describe('resolveLeanRule3Predicate helper arms', () => {
	test('epic-active + committed upstream: predicate defined and true for landed ids', () => {
		seamEpicOpen();
		const recorded: string[] = [];
		seamCommitted(recorded, '1.1');
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1', '2.1']);
		expect(predicate).toBeDefined();
		expect(predicate?.('1.1')).toBe(true);
		expect(predicate?.('2.1')).toBe(false);
	});

	test('epic-inactive (no open Epic): predicate is undefined — pure-lean legacy branch', () => {
		seamEpicOpen(null);
		const recorded: string[] = [];
		const findCalls = seamCommitted(recorded, '1.1');
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])).toBeUndefined();
		expect(findCalls).not.toHaveBeenCalled();
	});

	// NOTE: the "unreadable Epic state reads as OFF" contract's operator-visible
	// warn lives in lifecycle.ts's isEpicOpenForProject (warnUnreadableOnce),
	// which these arms seam out — the warn contract is lifecycle-owned and is
	// not re-asserted here (the duplicated dead arm was removed, review LO-8).

	test('mid-flight getOpenEpic throw: undefined + warnOnce seam invoked on each failure', () => {
		uc.isEpicOpenForProject = () => true;
		uc.getOpenEpic = () => {
			throw new Error('unreadable mid-read');
		};
		const warns: Array<{ dir: string; kind: string; message: string }> = [];
		uc.warnOnce = (dir, kind, message) => {
			warns.push({ dir, kind, message });
		};
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])).toBeUndefined();
		expect(resolveLeanRule3Predicate(tmpDir, ['1.1'])).toBeUndefined();
		expect(warns.length).toBe(2);
		// Every mid-flight unreadable warning carries the epic-unreadable class
		// so it can never suppress the distinct git-failure class (PRR-006).
		expect(warns.every((w) => w.kind === 'epic-unreadable')).toBe(true);
	});

	test('warnOnce dedup: per directory AND per failure class (PRR-006)', () => {
		const seen: string[] = [];
		uc.criticalWarn = (message: string) => {
			seen.push(message);
		};
		try {
			uc.warnedDirectories.clear();
			// Same dir + same class: deduped to one operator-visible warn.
			realUc.warnOnce(`${tmpDir}`, 'rule3-git-failure', 'first');
			realUc.warnOnce(`${tmpDir}`, 'rule3-git-failure', 'second — deduped');
			expect(seen.length).toBe(1);
			// Same dir, DIFFERENT class: must fire (the two degradations never
			// suppress each other — PRR-006).
			realUc.warnOnce(`${tmpDir}`, 'epic-unreadable', 'other class');
			expect(seen.length).toBe(2);
			// Path-spelling variants of the same directory dedup (C-S2).
			realUc.warnOnce(`${tmpDir}${path.sep}`, 'rule3-git-failure', 'spelling');
			expect(seen.length).toBe(2);
			// FIFO cap: MAX_WARNED_DIRECTORIES entries, then the oldest evicts.
			for (let i = 0; i < 64; i += 1) {
				realUc.warnOnce(`${tmpDir}-cap-${i}`, 'rule3-git-failure', `c${i}`);
			}
			expect(seen.length).toBe(2 + 64);
			// The cap evicted the FIRST tmpDir key, so its class warns again.
			realUc.warnOnce(`${tmpDir}`, 'rule3-git-failure', 'post-eviction');
			expect(seen.length).toBe(2 + 64 + 1);
		} finally {
			uc.warnedDirectories.clear();
		}
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
		uc.warnOnce = (_dir, kind, message) => {
			warns.push(`${kind}:${message}`);
		};
		const predicate = resolveLeanRule3Predicate(tmpDir, ['1.1']);
		expect(predicate).toBeDefined();
		expect(predicate?.('1.1')).toBe(true);
		expect(warns.length).toBe(1);
		expect(warns[0]).toStartWith('rule3-git-failure:');
	});

	test('probe failure (unknown, and probe throw): permissive predicate + warnOnce, never () => false', () => {
		seamEpicOpen();
		uc.findTaskCommits = () => {
			throw new Error('log failed');
		};
		const warns: string[] = [];
		uc.warnOnce = (_dir, kind, message) => {
			warns.push(`${kind}:${message}`);
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
		const recorded: string[] = [];
		seamCommitted(recorded); // nothing landed
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
		const recorded: string[] = [];
		seamCommitted(recorded, '1.1');
		const result = await executeLeanTurboPlanLanes({
			directory: tmpDir,
			phase: 2,
		});
		const shape = placementShape(result.plan);
		expect(shape.placed).toContain('2.1');
		expect(shape.degraded.length).toBe(0);
		// TC-03/F1: the wiring must pass the plan's FULL task-id set to the
		// marker read — dropping or scrambling it fails this arm.
		expect([...recorded].sort()).toEqual(['1.1', '2.1']);
	});

	test('tool, epic-inactive: marker machinery untouched, legacy placement', async () => {
		writeScratchProject();
		seamEpicOpen(null);
		const recorded: string[] = [];
		const findCalls = seamCommitted(recorded);
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
		const recorded: string[] = [];
		seamCommitted(recorded, '1.1');
		const { captured, restore } = captureArgs5();
		try {
			await runPhaseTwo();
		} finally {
			restore();
		}
		expect(captured.length).toBe(1);
		expect(typeof captured[0]).toBe('function');
		expect((captured[0] as (id: string) => boolean)('1.1')).toBe(true);
		// TC-03/F1: runner wiring passes the plan's full task-id set.
		expect([...recorded].sort()).toEqual(['1.1', '2.1']);
	});

	test('runner, epic-inactive: args[5] is undefined, legacy placement', async () => {
		writeScratchProject();
		seamEpicOpen(null);
		const recorded: string[] = [];
		const findCalls = seamCommitted(recorded);
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
