/**
 * Issue #2002 hardening — `dispatchLane`'s file-modifying tools are gated on
 * whether a `plan` was supplied, not merely on the parameter existing by
 * convention.
 *
 * `dispatchLane(lane, agentName, worktreeDirectory?, model?, plan?)` cannot
 * make `plan` a strictly required TypeScript parameter without breaking
 * TypeScript's "no required parameter after an optional one" rule (it sits
 * after two optional params) — and dozens of existing tests
 * (`runner-parenting.test.ts`, `runner.adversarial.test.ts`,
 * `runner.timeout-adversarial.test.ts`) intentionally call `dispatchLane`
 * directly with no plan to exercise dispatch mechanics (session parenting,
 * timeouts, model fallback) unrelated to scope authorization.
 *
 * So the enforcement lives at the one place that actually matters: the
 * `tools` payload sent to `session.prompt`. Without a plan, no scope binding
 * can be minted (`_publishLaneScope` needs it), so `write`/`edit`/`patch`
 * are force-disabled — regardless of caller, typed or not. This is the
 * runtime branch a type-only signature change could never enforce.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import type { Plan } from '../../../../src/config/plan-schema';
import { clearScopeBindings } from '../../../../src/scope/scope-binding';
import { resolveAuthorizedScopeBinding } from '../../../../src/scope/scope-persistence';
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';
import * as leanState from '../../../../src/turbo/lean/state';

const SESSION_ID = 'sess-lane-tools-gate';

let tmpDir: string;

const PLAN: Plan = {
	schema_version: '1.0.0',
	title: 'Lane Dispatch Tools Gate',
	swarm: 'test-swarm',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'Phase 1',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					description: 'Task 1',
					status: 'pending',
					phase: 1,
					size: 'small',
					depends: [],
					acceptance: 'Done',
					files_touched: ['src/a.ts'],
				},
			],
		},
	],
};

function makeRunner() {
	return new LeanTurboRunner({
		directory: tmpDir,
		sessionID: SESSION_ID,
		generatedAgentNames: ['coder'],
		leanConfig: {
			...DEFAULT_LEAN_TURBO_CONFIG,
			worktree_isolation: false,
		} as never,
	});
}

function injectSessionOps(
	runner: LeanTurboRunner,
	ops: Record<string, unknown>,
): void {
	(runner as unknown as { _sessionOps: unknown })._sessionOps = ops;
}

const LANE: LeanTurboLane = {
	laneId: 'lane-tools-gate',
	taskIds: ['1.1'],
	files: ['src/a.ts'],
	status: 'pending',
};

beforeEach(() => {
	resetSwarmState();
	clearScopeBindings();
	startAgentSession(SESSION_ID, 'architect');
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lane-tools-gate-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	// resolveAuthorizedScopeBinding (scope-persistence.ts) reads
	// .swarm/plan.json from `directory` to recompute planId/planStructureHash
	// for its in-memory lookup — it does not accept a plan as a direct
	// argument. Write the same PLAN object dispatchLane is given so the
	// binding-resolution assertions below actually exercise the lookup
	// instead of always short-circuiting on a missing plan.json.
	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify(PLAN, null, 2),
		'utf-8',
	);
});

afterEach(() => {
	clearScopeBindings();
	resetSwarmState();
	leanState.repairStateUnreadable(tmpDir);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

describe('dispatchLane file-modifying tools gate (#2002)', () => {
	test('a plan-less dispatchLane call disables write/edit/patch even when the caller casts around the type', async () => {
		const runner = makeRunner();
		const childSessionId = 'lane-child-no-plan';
		let capturedTools:
			| { write: boolean; edit: boolean; patch: boolean }
			| undefined;
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: childSessionId }, error: null }),
			),
			prompt: mock(
				(args: {
					body: { tools: { write: boolean; edit: boolean; patch: boolean } };
				}) => {
					capturedTools = args.body.tools;
					return Promise.resolve({
						data: { parts: [{ type: 'text', text: 'Done' }] },
						error: null,
					});
				},
			),
			delete: mock(() => Promise.resolve()),
		});

		// A future/other caller that omits `plan` entirely — bypassing even the
		// TypeScript optional-param default via an explicit cast, exactly like
		// the pre-existing "publishes nothing" test does — must still never get
		// a writable lane.
		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result.ok).toBe(true);
		expect(capturedTools).toEqual({ write: false, edit: false, patch: false });
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: childSessionId,
			}),
		).toBeNull();
	});

	test('a dispatchLane call with a plan enables write/edit/patch and publishes a binding', async () => {
		const runner = makeRunner();
		const childSessionId = 'lane-child-with-plan';
		let capturedTools:
			| { write: boolean; edit: boolean; patch: boolean }
			| undefined;
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: childSessionId }, error: null }),
			),
			prompt: mock(
				(args: {
					body: { tools: { write: boolean; edit: boolean; patch: boolean } };
				}) => {
					capturedTools = args.body.tools;
					return Promise.resolve({
						data: { parts: [{ type: 'text', text: 'Done' }] },
						error: null,
					});
				},
			),
			delete: mock(() => Promise.resolve()),
		});

		const result = await runner.dispatchLane(
			LANE,
			'coder',
			undefined,
			undefined,
			PLAN,
		);

		expect(result.ok).toBe(true);
		expect(capturedTools).toEqual({ write: true, edit: true, patch: true });
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: childSessionId,
			}),
		).not.toBeNull();
	});
});
