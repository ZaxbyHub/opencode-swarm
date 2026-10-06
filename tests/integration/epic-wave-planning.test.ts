/**
 * End-to-end integration test for Epic Mode wave planning through
 * `epic_next_wave` (Epic v2 C2).
 *
 * The unit tests pin down the wave algorithm and the tool in isolation.
 * This file is the round-trip backstop for the actual flow the architect
 * runs in a no-git project (exactly the `fair-clinical-bench-v2` Phase 2
 * shape that motivated the wave planner):
 *
 *   declare_scope (×6) → epic_next_wave → wave → complete → epic_next_wave …
 *
 * The structural property: where `lean_turbo_plan_lanes`
 * collapses the branching DAG `A → B → {C, D, E, F}` into a single lane (every
 * sibling sharing deps fails the cross-lane-dep test and serializes), the
 * wave planner emits `wave 1: [A]` `wave 2: [B]` `wave 3: [C, D, E, F]`.
 * That partition is what the architect needs to dispatch four concurrent
 * coders for `C, D, E, F` in one assistant message.
 *
 * Also covered: the kitchen-sink-scope failure mode (architect claims a
 * shared file in every sibling scope) — the wave planner correctly splits
 * those into more waves rather than silently degrading to serial.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { savePlan, updateTaskStatus } from '../../src/plan/manager';
import {
	declareScopesForTest,
	resetDeclaredScopesForTest,
} from '../helpers/declared-scope-bindings';
import { openEpicForTest } from '../helpers/epic-lifecycle';

function makePhase2Plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Wave-planning integration',
		swarm: 'integration',
		current_phase: 2,
		phases: [
			{
				id: 1,
				name: 'Setup',
				status: 'completed',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Package scaffolding',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Models',
				status: 'pending',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Registry',
						depends: ['1.1'],
						files_touched: [],
					},
					{
						id: '2.2',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Column types',
						depends: ['2.1'],
						files_touched: [],
					},
					{
						id: '2.3',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Logistic',
						depends: ['2.1', '2.2'],
						files_touched: [],
					},
					{
						id: '2.4',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Random Forest',
						depends: ['2.1', '2.2'],
						files_touched: [],
					},
					{
						id: '2.5',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'XGBoost',
						depends: ['2.1', '2.2'],
						files_touched: [],
					},
					{
						id: '2.6',
						phase: 2,
						status: 'pending',
						size: 'small',
						description: 'Calibrated MLP',
						depends: ['2.1', '2.2'],
						files_touched: [],
					},
				],
			},
		],
		migration_status: 'native',
	};
}

/**
 * Declare through the real `declare_scope` path. It persists only v2 scope
 * bindings (pinned to the plan identity) — the planners never read the
 * legacy v1 `.swarm/scopes/scope-<id>.json` projection.
 */
async function writeScopeFile(
	dir: string,
	taskId: string,
	files: string[],
): Promise<void> {
	await declareScopesForTest(
		dir,
		{ [taskId]: files },
		{ sessionID: 'wave-integration-session' },
	);
}

describe('Epic Mode wave planning — Phase-2-shape integration on no-git project', () => {
	let dir: string;

	beforeEach(async () => {
		// Same `mkdtempSync` (not realpathSync) pattern as `epic-phase-handoff.test.ts`:
		// macOS resolves `/tmp/...` to `/private/tmp/...`, and `private` triggers
		// the protected-path classifier — would degrade tasks for unrelated reasons.
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-wave-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		// Epic Mode is opt-in: `epic.mode.enabled` must be true.
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				epic: { mode: { enabled: true } },
			}),
		);
		await savePlan(dir, makePhase2Plan());
		// No git init — the no-git scenario (no marker evidence needed). The
		// epic record keeps a 4-wide wave cap (the non-git width-1 cap that
		// `/swarm epic start` records is covered by the start tests) so this
		// suite exercises the planner's partition. Phase 1 finished before
		// the epic started.
		openEpicForTest(dir, {
			git: {
				isRepo: false,
				baseCommit: null,
				originalBranch: null,
				epicBranch: null,
			},
			phases: { '1': { status: 'complete', reviewRuns: 0, verdicts: [] } },
		});
	});

	afterEach(async () => {
		await resetDeclaredScopesForTest();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	});

	/** Drive epic_next_wave to the end of phase 2, completing each wave. */
	async function runPhase2(): Promise<string[][]> {
		const waves: string[][] = [];
		for (let step = 0; step < 10; step += 1) {
			const next = await runEpicNextWave(dir, 'wave-integration-session');
			if (next.status === 'phase-ready-for-review') return waves;
			expect(next.status).toBe('dispatch');
			if (next.status !== 'dispatch') return waves;
			waves.push(next.wave.taskIds);
			for (const id of next.wave.taskIds) {
				await updateTaskStatus(dir, id, 'completed');
			}
		}
		throw new Error('phase 2 did not finish within 10 waves');
	}

	test('clean disjoint scopes: three waves with the right partition (four concurrent coders last)', async () => {
		await writeScopeFile(dir, '2.1', ['src/registry.py', 'src/protocol.py']);
		await writeScopeFile(dir, '2.2', ['src/column_types.py']);
		await writeScopeFile(dir, '2.3', ['src/models/logistic.py']);
		await writeScopeFile(dir, '2.4', ['src/models/random_forest.py']);
		await writeScopeFile(dir, '2.5', ['src/models/xgboost.py']);
		await writeScopeFile(dir, '2.6', ['src/models/mlp.py']);
		expect(await runPhase2()).toEqual([
			['2.1'],
			['2.2'],
			['2.3', '2.4', '2.5', '2.6'],
		]);
	});

	test('kitchen-sink scope (every sibling claims the shared __init__.py): more waves, no task lost', async () => {
		await writeScopeFile(dir, '2.1', ['src/registry.py']);
		await writeScopeFile(dir, '2.2', ['src/column_types.py']);
		for (const [id, file] of [
			['2.3', 'logistic'],
			['2.4', 'random_forest'],
			['2.5', 'xgboost'],
			['2.6', 'mlp'],
		]) {
			await writeScopeFile(dir, id, [
				`src/models/${file}.py`,
				'src/models/__init__.py',
			]);
		}
		expect(await runPhase2()).toEqual([
			['2.1'],
			['2.2'],
			['2.3'],
			['2.4'],
			['2.5'],
			['2.6'],
		]);
	});

	test('declare-scopes → declare → re-call → dispatch (the architect recovery loop)', async () => {
		const first = await runEpicNextWave(dir, 'wave-integration-session');
		expect(first).toMatchObject({
			status: 'declare-scopes',
			phase: 2,
			tasks: [{ taskId: '2.1', suggestedFiles: [] }],
		});
		await writeScopeFile(dir, '2.1', ['src/registry.py']);
		expect(
			await runEpicNextWave(dir, 'wave-integration-session'),
		).toMatchObject({
			status: 'dispatch',
			wave: { taskIds: ['2.1'], files: { '2.1': ['src/registry.py'] } },
		});
	});
});
