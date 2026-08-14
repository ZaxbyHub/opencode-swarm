/**
 * Issue #2002 (Lean Turbo half) — cleanup symmetry proof.
 *
 * `endAgentSession(sessionId)` was added to two Lean Turbo dispatch failure
 * paths (the `session.prompt` failure branch and the outer `_doDispatch`
 * catch — see `tests/unit/turbo/lean/lean-turbo-lane-scope-wiring.test.ts`,
 * describe block "runner clears published lane authority on a
 * post-publication dispatch failure (#2002)") but NOT to the other two
 * failure paths that can leave the same in-memory state behind:
 *
 *  (a) `_publishLaneScope`'s own throw path — `publishLeanTurboLaneScopeBinding`
 *      (`src/turbo/lean/lane-scope.ts`) calls `registerScopeBinding` (line 245)
 *      before `writeScopeBindingToDisk` (line 246), and `ensureAgentSession`
 *      for the child (line 256) before `recordSessionWorkspaceRoot` (line
 *      269). A throw from either disk/registration step can leave the
 *      binding and/or the child `AgentSessionState` registered even though
 *      the whole publish attempt is treated as failed.
 *  (b) `dispatchLane`'s timeout branch — the background completion handler
 *      deletes the orphan remote session on `result.ok && result.sessionId`
 *      but, pre-fix, never called `endAgentSession`.
 *
 * This file proves both paths now clean up the published binding AND the
 * child `AgentSessionState` symmetrically with the other two paths,
 * mirroring the assertion pattern in `lean-turbo-lane-scope-wiring.test.ts`
 * (state proven present at the point of failure, then proven absent after
 * the runner call resolves).
 *
 * No mock.module: everything goes through the `_internals` / `_sessionOps`
 * DI seams the runner already exposes. Item 2a's mocks reuse the same
 * `createScopeBinding` → `deriveChildScopeBinding` → `registerScopeBinding`
 * primitives `lane-scope.ts` itself uses, so the binding constructed here is
 * a real, resolvable binding — not a stand-in.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import {
	clearScopeBindings,
	createScopeBinding,
	deriveChildScopeBinding,
	getAuthorizedScopeBinding,
	registerScopeBinding,
} from '../../../../src/scope/scope-binding';
import {
	clearScopeBindingFromDisk,
	resolveAuthorizedScopeBinding,
} from '../../../../src/scope/scope-persistence';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../../src/state';
import {
	type PublishLeanTurboLaneScopeInput,
	publishLeanTurboLaneScopeBinding,
} from '../../../../src/turbo/lean/lane-scope';
import {
	LANE_SCOPE_DENIED_CODE,
	LeanTurboRunner,
} from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';
import * as leanState from '../../../../src/turbo/lean/state';

const SESSION_ID = 'sess-lane-cleanup-symmetry';

let tmpDir: string;
let originals: Partial<typeof LeanTurboRunner._internals>;

const PLAN = {
	schema_version: '1.0.0',
	title: 'Lane Cleanup Symmetry',
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

function writePlan(): void {
	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify(PLAN, null, 2),
		'utf-8',
	);
	const scopeDir = path.join(tmpDir, '.swarm', 'scopes');
	fs.mkdirSync(scopeDir, { recursive: true });
	fs.writeFileSync(
		path.join(scopeDir, 'scope-1.1.json'),
		JSON.stringify({ files: ['src/a.ts'] }),
		'utf-8',
	);
}

function makeRunner(leanConfig?: Record<string, unknown>) {
	return new LeanTurboRunner({
		directory: tmpDir,
		sessionID: SESSION_ID,
		generatedAgentNames: ['coder'],
		leanConfig: {
			...DEFAULT_LEAN_TURBO_CONFIG,
			worktree_isolation: false,
			...leanConfig,
		} as never,
	});
}

function injectSessionOps(
	runner: LeanTurboRunner,
	ops: Record<string, unknown>,
): void {
	(runner as unknown as { _sessionOps: unknown })._sessionOps = ops;
}

/**
 * Builds a real, resolvable child scope binding using the exact primitives
 * `publishLeanTurboLaneScopeBinding` uses, then registers it in memory (but
 * deliberately stops short of `writeScopeBindingToDisk` / `ensureAgentSession`
 * / `recordSessionWorkspaceRoot` — the caller decides how far to go before
 * throwing, to reproduce a specific real throw point).
 */
function registerRealChildBinding(
	input: PublishLeanTurboLaneScopeInput,
	dispatchCallId: string,
): void {
	const taskId = input.lane.taskIds[0];
	if (!taskId) throw new Error('test setup: lane has no taskIds');
	const parentBinding = createScopeBinding({
		directory: input.primaryDirectory,
		plan: input.plan,
		taskId,
		files: ['src/a.ts'],
		ownerSessionId: input.parentSessionId,
		ownerMessageId: dispatchCallId,
		source: 'plan',
		dispatchCallId,
		activation: 'pending_child',
	});
	if (!parentBinding) throw new Error('test setup: parentBinding was null');
	const childBinding = deriveChildScopeBinding(parentBinding, {
		childDirectory: input.laneRoot,
		childSessionId: input.childSessionId,
		parentCallId: dispatchCallId,
	});
	registerScopeBinding(childBinding);
}

beforeEach(() => {
	resetSwarmState();
	clearScopeBindings();
	startAgentSession(SESSION_ID, 'architect');
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lane-cleanup-symmetry-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	writePlan();

	originals = {
		publishLeanTurboLaneScopeBinding:
			LeanTurboRunner._internals.publishLeanTurboLaneScopeBinding,
		laneDispatchTimeoutMs: LeanTurboRunner._internals.laneDispatchTimeoutMs,
	};
});

afterEach(() => {
	for (const [key, value] of Object.entries(originals)) {
		(LeanTurboRunner._internals as Record<string, unknown>)[key] = value;
	}
	clearScopeBindings();
	resetSwarmState();
	leanState.repairStateUnreadable(tmpDir);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

describe('item 2a — _publishLaneScope throw path cleans up whatever was already published', () => {
	test('an unavailable lane root still installs an exact-generation deny before durable cleanup fails', async () => {
		const childSessionId = 'lane-child-unavailable-root';
		const binding = await publishLeanTurboLaneScopeBinding({
			primaryDirectory: tmpDir,
			laneRoot: tmpDir,
			isolated: false,
			plan: PLAN as never,
			lane: {
				laneId: 'lane-unavailable-root',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
			},
			parentSessionId: SESSION_ID,
			childSessionId,
		});
		expect(binding).not.toBeNull();
		if (!binding) throw new Error('test setup: binding was not published');

		const retired = clearScopeBindingFromDisk({
			directory: path.join(tmpDir, 'missing-lane-root'),
			binding,
		});
		expect(retired.ok).toBe(false);
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: childSessionId,
			}),
		).toBeNull();
	});

	test('a throw before the child session is registered still clears the in-memory binding', async () => {
		const childSessionId = 'lane-child-publish-throw-pre-session';
		let bindingResolvedBeforeThrow = false;

		// Mirrors the real `writeScopeBindingToDisk` throw point
		// (`src/turbo/lean/lane-scope.ts:246`): it runs AFTER
		// `registerScopeBinding` (line 245) but BEFORE `ensureAgentSession`
		// for the child (line 256). At this exact point a binding is
		// registered but no child session exists yet.
		LeanTurboRunner._internals.publishLeanTurboLaneScopeBinding = mock(
			async (input: PublishLeanTurboLaneScopeInput) => {
				registerRealChildBinding(input, 'test-dispatch-pre-session');
				bindingResolvedBeforeThrow =
					getAuthorizedScopeBinding({
						directory: input.laneRoot,
						plan: input.plan,
						taskId: input.lane.taskIds[0] as string,
						activeSessionId: input.childSessionId,
					}) !== null;
				throw new Error('writeScopeBindingToDisk exploded');
			},
		) as never;

		const runner = makeRunner();
		const create = mock(() =>
			Promise.resolve({ data: { id: childSessionId }, error: null }),
		);
		const prompt = mock(() =>
			Promise.resolve({
				data: { parts: [{ type: 'text', text: 'Done' }] },
				error: null,
			}),
		);
		const del = mock(() => Promise.resolve());
		injectSessionOps(runner, { create, prompt, delete: del });
		const lane: LeanTurboLane = {
			laneId: 'lane-publish-throw-pre-session',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};

		const result = await runner.dispatchLane(
			lane,
			'coder',
			undefined,
			undefined,
			PLAN as never,
		);

		expect(bindingResolvedBeforeThrow).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.error).toContain(LANE_SCOPE_DENIED_CODE);
		expect(prompt).not.toHaveBeenCalled();
		expect(del).toHaveBeenCalled();
		// The registered binding must not outlive the throw — pre-fix it
		// stayed live for up to its 1h TTL even though publication as a
		// whole was treated as failed.
		expect(
			getAuthorizedScopeBinding({
				directory: tmpDir,
				plan: PLAN as never,
				taskId: '1.1',
				activeSessionId: childSessionId,
			}),
		).toBeNull();
		// No child session was ever created on this path — confirm it stays
		// absent (nothing to leak here, but nothing should appear either).
		expect(swarmState.agentSessions.get(childSessionId)).toBeUndefined();
	});

	test('a throw after the child session is registered clears both the binding and the session', async () => {
		const childSessionId = 'lane-child-publish-throw-post-session';
		let bindingResolvedBeforeThrow = false;
		let sessionDefinedBeforeThrow = false;

		// Mirrors the real `recordSessionWorkspaceRoot` throw point
		// (`src/turbo/lean/lane-scope.ts:269`): it runs AFTER
		// `ensureAgentSession` for the child (line 256). At this point BOTH
		// the binding and the child AgentSessionState already exist.
		LeanTurboRunner._internals.publishLeanTurboLaneScopeBinding = mock(
			async (input: PublishLeanTurboLaneScopeInput) => {
				registerRealChildBinding(input, 'test-dispatch-post-session');
				ensureAgentSession(input.childSessionId, 'coder', input.laneRoot);
				bindingResolvedBeforeThrow =
					getAuthorizedScopeBinding({
						directory: input.laneRoot,
						plan: input.plan,
						taskId: input.lane.taskIds[0] as string,
						activeSessionId: input.childSessionId,
					}) !== null;
				sessionDefinedBeforeThrow =
					swarmState.agentSessions.get(input.childSessionId) !== undefined;
				throw new Error('recordSessionWorkspaceRoot exploded');
			},
		) as never;

		const runner = makeRunner();
		const create = mock(() =>
			Promise.resolve({ data: { id: childSessionId }, error: null }),
		);
		const prompt = mock(() =>
			Promise.resolve({
				data: { parts: [{ type: 'text', text: 'Done' }] },
				error: null,
			}),
		);
		const del = mock(() => Promise.resolve());
		injectSessionOps(runner, { create, prompt, delete: del });
		const lane: LeanTurboLane = {
			laneId: 'lane-publish-throw-post-session',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};

		const result = await runner.dispatchLane(
			lane,
			'coder',
			undefined,
			undefined,
			PLAN as never,
		);

		expect(bindingResolvedBeforeThrow).toBe(true);
		expect(sessionDefinedBeforeThrow).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.error).toContain(LANE_SCOPE_DENIED_CODE);
		expect(prompt).not.toHaveBeenCalled();
		expect(del).toHaveBeenCalled();
		// Neither the binding nor the child AgentSessionState may outlive the
		// throw — pre-fix the binding stayed live up to 1h and the session up
		// to 2h.
		expect(
			getAuthorizedScopeBinding({
				directory: tmpDir,
				plan: PLAN as never,
				taskId: '1.1',
				activeSessionId: childSessionId,
			}),
		).toBeNull();
		expect(swarmState.agentSessions.get(childSessionId)).toBeUndefined();
	});
});

describe('item 2b — dispatchLane timeout branch cleans up the child session', () => {
	test('a lane-dispatch timeout does not leave the published scope binding or child session behind once the background dispatch resolves', async () => {
		const childSessionId = `lane-timeout-cleanup-${Math.random().toString(36).slice(2)}`;
		let sessionDefinedAtPromptStart = false;

		const create = mock(() =>
			Promise.resolve({ data: { id: childSessionId }, error: null }),
		);
		// Slow enough that the dispatch timeout wins the race, but the
		// dispatch itself still succeeds afterward — this is the branch
		// where the background completion handler runs cleanup. The
		// timeout/sleep/wait margins here are generous (3x+ headroom) so real
		// disk I/O in `_publishLaneScope` (savePlan / writeScopeBindingToDisk)
		// has ample time to finish before the timeout fires, even on a slow
		// filesystem.
		const prompt = mock(() => {
			sessionDefinedAtPromptStart =
				swarmState.agentSessions.get(childSessionId) !== undefined;
			return Bun.sleep(600).then(() => ({
				data: { parts: [{ type: 'text', text: 'Done' }] },
				error: null,
			}));
		});
		const del = mock(() => Promise.resolve());
		const runner = makeRunner();
		injectSessionOps(runner, { create, prompt, delete: del });

		LeanTurboRunner._internals.laneDispatchTimeoutMs = 150;
		const lane: LeanTurboLane = {
			laneId: 'lane-timeout-cleanup',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};

		const result = await runner.dispatchLane(
			lane,
			'coder',
			undefined,
			undefined,
			PLAN as never,
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain('timed out');
		// _publishLaneScope (real implementation, not mocked here) ran to
		// completion before the slow `prompt` call started, so the child
		// session already existed when prompt began — proving there is
		// something real to clean up, not a no-op.
		expect(sessionDefinedAtPromptStart).toBe(true);
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: childSessionId,
			}),
		).not.toBeNull();

		// Wait for the background completion handler (prompt resolves ~600ms
		// after the 150ms timeout fired) to run its cleanup.
		await Bun.sleep(900);

		expect(del).toHaveBeenCalledWith(
			expect.objectContaining({ path: { id: childSessionId } }),
		);
		// The published binding and the child AgentSessionState must not
		// survive the timeout's orphan cleanup either — pre-fix both stayed
		// live (binding up to 1h, AgentSessionState up to 2h) even though the
		// remote orphan session was deleted.
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: childSessionId,
			}),
		).toBeNull();
		expect(swarmState.agentSessions.get(childSessionId)).toBeUndefined();
	});
});
