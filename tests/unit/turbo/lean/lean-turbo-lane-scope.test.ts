import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../../src/config/plan-schema';
import { createScopeGuardHook } from '../../../../src/hooks/scope-guard';
import { clearScopeBindings } from '../../../../src/scope/scope-binding';
import {
	readScopeBindingFromDisk,
	resolveAuthorizedScopeBinding,
} from '../../../../src/scope/scope-persistence';
import { resetSwarmState, swarmState } from '../../../../src/state';
import {
	LEAN_TURBO_LANE_DISPATCH_PREFIX,
	publishLeanTurboLaneScopeBinding,
	resolveLeanTurboLaneAuthorityFiles,
} from '../../../../src/turbo/lean/lane-scope';
import { createSafeTestDir } from '../../../helpers/safe-test-dir';

/**
 * Issue #2002 (Lean Turbo half). Lean Turbo dispatched lane coders with
 * write/edit/patch enabled but never published a scope binding and never
 * materialized a plan into the lane, so `readCurrentPlan(laneRoot)` returned
 * null and every lane write failed SCOPE_NOT_DECLARED.
 *
 * Every gate here is constructed with the PROJECT ROOT, mirroring production
 * wiring (the hook is built once at plugin init with `ctx.directory`). Passing
 * the lane as the hook directory would remove the only thing these tests prove.
 */

const plan: Plan = {
	schema_version: '1.0.0',
	title: 'Lean turbo lane scope',
	swarm: 'test',
	phases: [
		{
			id: 1,
			name: 'Implement',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'lane a work',
					depends: [],
					files_touched: ['src/lane-a.ts'],
				},
				{
					id: '1.2',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'lane b work',
					depends: [],
					files_touched: ['src/lane-b.ts'],
				},
			],
		},
	],
};

const LANE_A = {
	laneId: 'lane-1',
	taskIds: ['1.1'],
	files: ['src/lane-a.ts'],
};
const LANE_B = {
	laneId: 'lane-2',
	taskIds: ['1.2'],
	files: ['src/lane-b.ts'],
};

describe('lean turbo lane scope publication (#2002)', () => {
	let directory: string;
	let cleanup: () => void;

	async function publishLane(
		laneName: string,
		lane: { laneId: string; taskIds: string[]; files: string[] },
		childSessionId: string,
		parentSessionId = 'architect-session',
	): Promise<{
		laneRoot: string;
		binding: Awaited<ReturnType<typeof publishLeanTurboLaneScopeBinding>>;
	}> {
		const laneRoot = path.join(directory, laneName);
		fs.mkdirSync(laneRoot, { recursive: true });
		const binding = await publishLeanTurboLaneScopeBinding({
			primaryDirectory: directory,
			laneRoot,
			isolated: true,
			plan,
			lane,
			parentSessionId,
			childSessionId,
		});
		return { laneRoot, binding };
	}

	beforeEach(() => {
		resetSwarmState();
		clearScopeBindings();
		const created = createSafeTestDir('lean-lane-scope-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	});

	afterEach(() => {
		clearScopeBindings();
		resetSwarmState();
		cleanup();
	});

	test('REGRESSION: an in-scope lane coder write is ALLOWED after publication', async () => {
		const { binding } = await publishLane('lane-a', LANE_A, 'lane-a-session');
		expect(binding).not.toBeNull();

		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'lane-a-session', callID: 'w1' },
				{ args: { path: 'src/lane-a.ts', content: 'ok' } },
			),
		).resolves.toBeUndefined();
	});

	test('an absolute path inside the lane is allowed when in scope', async () => {
		const { laneRoot } = await publishLane(
			'lane-abs',
			LANE_A,
			'lane-abs-session',
		);
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'lane-abs-session', callID: 'w-abs' },
				{
					args: {
						path: path.join(laneRoot, 'src', 'lane-a.ts'),
						content: 'ok',
					},
				},
			),
		).resolves.toBeUndefined();
	});

	test('an out-of-scope write from the lane session is still BLOCKED', async () => {
		await publishLane('lane-oos', LANE_A, 'lane-oos-session');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'lane-oos-session', callID: 'w2' },
				{ args: { path: 'src/unrelated.ts', content: 'no' } },
			),
		).rejects.toThrow('SCOPE VIOLATION');
	});

	test('a path escaping the lane root is BLOCKED', async () => {
		await publishLane('lane-esc', LANE_A, 'lane-esc-session');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'lane-esc-session', callID: 'w3' },
				{ args: { path: '../src/lane-a.ts', content: 'no' } },
			),
		).rejects.toThrow('SCOPE_ROOT_ESCAPE');
	});

	test('one lane cannot use another lane binding', async () => {
		const a = await publishLane('lane-x', LANE_A, 'lane-x-session');
		const b = await publishLane('lane-y', LANE_B, 'lane-y-session');
		expect(a.binding).not.toBeNull();
		expect(b.binding).not.toBeNull();

		const hook = createScopeGuardHook({ enabled: true }, directory);
		// Lane Y's session writing lane X's file: the file is outside lane Y's
		// declared scope, and lane X's tree is outside lane Y's root.
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'lane-y-session', callID: 'w4' },
				{ args: { path: 'src/lane-a.ts', content: 'no' } },
			),
		).rejects.toThrow('SCOPE VIOLATION');
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'lane-y-session', callID: 'w5' },
				{
					args: {
						path: path.join(a.laneRoot, 'src', 'lane-a.ts'),
						content: 'no',
					},
				},
			),
		).rejects.toThrow('SCOPE_ROOT_ESCAPE');
	});

	test("a lane binding does not resolve against another lane's root", async () => {
		const a = await publishLane('lane-p', LANE_A, 'lane-p-session');
		const b = await publishLane('lane-q', LANE_B, 'lane-q-session');
		expect(
			resolveAuthorizedScopeBinding({
				directory: a.laneRoot,
				taskId: '1.1',
				activeSessionId: 'lane-p-session',
			}),
		).not.toBeNull();
		// Same session, wrong root → no authorization.
		expect(
			resolveAuthorizedScopeBinding({
				directory: b.laneRoot,
				taskId: '1.1',
				activeSessionId: 'lane-p-session',
			}),
		).toBeNull();
		// Same root, wrong session → no authorization.
		expect(
			resolveAuthorizedScopeBinding({
				directory: a.laneRoot,
				taskId: '1.1',
				activeSessionId: 'lane-q-session',
			}),
		).toBeNull();
	});

	test('a lane binding does not authorize the project root', async () => {
		await publishLane('lane-root-check', LANE_A, 'lane-root-session');
		expect(
			resolveAuthorizedScopeBinding({
				directory,
				taskId: '1.1',
				activeSessionId: 'lane-root-session',
			}),
		).toBeNull();
	});

	test('the authoritative plan is materialized into the isolated lane', async () => {
		const { laneRoot } = await publishLane(
			'lane-plan',
			LANE_A,
			'lane-plan-session',
		);
		expect(fs.existsSync(path.join(laneRoot, '.swarm', 'plan.json'))).toBe(
			true,
		);
	});

	test('the binding survives an in-memory restart via the lane disk record', async () => {
		const { laneRoot } = await publishLane(
			'lane-disk',
			LANE_A,
			'lane-disk-session',
		);
		clearScopeBindings();
		const durable = readScopeBindingFromDisk({
			directory: laneRoot,
			taskId: '1.1',
			plan,
			ownerSessionId: 'lane-disk-session',
			requireDispatchCorrelation: true,
		});
		expect(durable).not.toBeNull();
		expect(durable?.files).toEqual(['src/lane-a.ts']);
		expect(durable?.dispatchCallId).toStartWith(
			`${LEAN_TURBO_LANE_DISPATCH_PREFIX}:`,
		);
	});

	test('the child session is bound to the lane root and marked a coder', async () => {
		const { laneRoot } = await publishLane(
			'lane-bind',
			LANE_A,
			'lane-bind-session',
		);
		const session = swarmState.agentSessions.get('lane-bind-session');
		expect(session?.workspaceDirectory).toBe(laneRoot);
		expect(session?.agentName).toBe('coder');
		expect(session?.currentTaskId).toBe('1.1');
		expect(session?.declaredCoderScope).toEqual(['src/lane-a.ts']);
	});

	test('a shared-directory lane neither re-saves the plan nor records a root', async () => {
		const laneRoot = path.join(directory, 'shared-lane');
		fs.mkdirSync(laneRoot, { recursive: true });
		const binding = await publishLeanTurboLaneScopeBinding({
			primaryDirectory: directory,
			laneRoot,
			isolated: false,
			plan,
			lane: LANE_A,
			parentSessionId: 'architect-session',
			childSessionId: 'shared-session',
		});
		expect(binding).not.toBeNull();
		// savePlan must not run for a non-provisioned lane: concurrent lanes would
		// otherwise churn the authoritative plan ledger (AGENTS.md invariant 5).
		expect(fs.existsSync(path.join(laneRoot, '.swarm', 'plan.json'))).toBe(
			false,
		);
		// The workspace root is only ever recorded from provisioning output.
		expect(
			swarmState.agentSessions.get('shared-session')?.workspaceDirectory,
		).toBeUndefined();
	});
});

describe('lean turbo lane scope fails closed (#2002)', () => {
	let directory: string;
	let cleanup: () => void;

	async function publish(
		lane: { laneId: string; taskIds: string[]; files: string[] },
		childSessionId = 'child-session',
		parentSessionId = 'architect-session',
	) {
		const laneRoot = path.join(directory, `lane-${childSessionId}`);
		fs.mkdirSync(laneRoot, { recursive: true });
		return {
			laneRoot,
			binding: await publishLeanTurboLaneScopeBinding({
				primaryDirectory: directory,
				laneRoot,
				isolated: true,
				plan,
				lane,
				parentSessionId,
				childSessionId,
			}),
		};
	}

	beforeEach(() => {
		resetSwarmState();
		clearScopeBindings();
		const created = createSafeTestDir('lean-lane-scope-closed-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	});

	afterEach(() => {
		clearScopeBindings();
		resetSwarmState();
		cleanup();
	});

	test('a lane with no task ids publishes nothing', async () => {
		const { binding } = await publish({
			laneId: 'lane-empty',
			taskIds: [],
			files: ['src/lane-a.ts'],
		});
		expect(binding).toBeNull();
	});

	test('a non-strict representative task id publishes nothing', async () => {
		const { binding } = await publish({
			laneId: 'lane-bad-id',
			taskIds: ['T1'],
			files: ['src/lane-a.ts'],
		});
		expect(binding).toBeNull();
	});

	test('a lane whose tasks are absent from the plan publishes nothing', async () => {
		const { binding } = await publish({
			laneId: 'lane-unknown',
			taskIds: ['9.9'],
			files: ['src/lane-a.ts'],
		});
		expect(binding).toBeNull();
	});

	test('a lane with no files publishes nothing', async () => {
		const { binding } = await publish({
			laneId: 'lane-no-files',
			taskIds: ['1.1'],
			files: [],
		});
		expect(binding).toBeNull();
	});

	test('a child session equal to its parent publishes nothing', async () => {
		const { binding } = await publish(LANE_A, 'architect-session');
		expect(binding).toBeNull();
	});

	test('an unpublished lane coder is blocked with SCOPE_NOT_DECLARED', async () => {
		const { binding } = await publish({
			laneId: 'lane-blocked',
			taskIds: ['T1'],
			files: ['src/lane-a.ts'],
		});
		expect(binding).toBeNull();
		// Pre-fix behaviour is preserved exactly: no binding, no write.
		swarmState.activeAgent.set('child-session', 'coder');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'child-session', callID: 'w0' },
				{ args: { path: 'src/lane-a.ts', content: 'no' } },
			),
		).rejects.toThrow('SCOPE_NOT_DECLARED');
	});
});

describe('lean turbo lane authority never exceeds the plan (#2002)', () => {
	test('lane files outside the plan authority are dropped', () => {
		const files = resolveLeanTurboLaneAuthorityFiles(plan, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			// A stale on-disk declared scope can hand the planner files the
			// authoritative plan does not attribute to this task. Those must never
			// become write authority.
			files: ['src/lane-a.ts', 'src/not-in-plan.ts', 'src/lane-b.ts'],
		});
		expect(files).toEqual(['src/lane-a.ts']);
	});

	test('a lane file nested under a plan directory entry is kept, narrowed', () => {
		const dirPlan: Plan = {
			...plan,
			phases: [
				{
					...plan.phases[0],
					tasks: [
						{ ...plan.phases[0].tasks[0], files_touched: ['src/feature'] },
					],
				},
			],
		};
		expect(
			resolveLeanTurboLaneAuthorityFiles(dirPlan, {
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/feature/a.ts', 'src/other/b.ts'],
			}),
		).toEqual(['src/feature/a.ts']);
	});

	test('a multi-task lane is authorized for the union of its own plan tasks only', () => {
		expect(
			resolveLeanTurboLaneAuthorityFiles(plan, {
				laneId: 'lane-1',
				taskIds: ['1.1', '1.2'],
				files: ['src/lane-a.ts', 'src/lane-b.ts', 'src/elsewhere.ts'],
			}),
		).toEqual(['src/lane-a.ts', 'src/lane-b.ts']);
	});

	test('absolute and traversing lane paths are refused, not normalized in', () => {
		expect(
			resolveLeanTurboLaneAuthorityFiles(plan, {
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['/etc/passwd', '../../outside.ts'],
			}),
		).toBeNull();
	});
});
