/**
 * Issue #2002 (Lean Turbo half) — wiring proof.
 *
 * `tests/unit/turbo/lean/lean-turbo-lane-scope.test.ts` proves the publisher
 * itself is correct. This file proves the runner actually CALLS it, on the real
 * production path (`runPhase` → `_processLane` → `dispatchLane` →
 * `_doDispatch`), before the lane's coder prompt is sent — and that a failed
 * publication fails the lane closed instead of running an unscoped coder.
 *
 * No mock.module: the runner's `_internals` / `_sessionOps` DI seams are used.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import { createScopeGuardHook } from '../../../../src/hooks/scope-guard';
import { clearScopeBindings } from '../../../../src/scope/scope-binding';
import { resolveAuthorizedScopeBinding } from '../../../../src/scope/scope-persistence';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../../src/state';
import {
	LANE_SCOPE_DENIED_CODE,
	LeanTurboRunner,
} from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';
import * as leanState from '../../../../src/turbo/lean/state';
import { isTransientProviderError } from '../../../../src/utils/provider-error-classification';
import { safeRmRecursive } from '../../../helpers/safe-test-dir';

const SESSION_ID = 'sess-lane-scope-wiring';
let tmpDir: string;
let originals: Partial<typeof LeanTurboRunner._internals>;

const PLAN = {
	schema_version: '1.0.0',
	title: 'Lane Scope Wiring',
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

beforeEach(() => {
	resetSwarmState();
	clearScopeBindings();
	startAgentSession(SESSION_ID, 'architect');
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lane-scope-wiring-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	writePlan();

	originals = {
		assertCleanWorkingTree: LeanTurboRunner._internals.assertCleanWorkingTree,
		startupOrphanRecovery: LeanTurboRunner._internals.startupOrphanRecovery,
		provisionWorktree: LeanTurboRunner._internals.provisionWorktree,
		removeWorktree: LeanTurboRunner._internals.removeWorktree,
		removeLaneProfileFromDisk:
			LeanTurboRunner._internals.removeLaneProfileFromDisk,
		attemptMergeBackFromDirty:
			LeanTurboRunner._internals.attemptMergeBackFromDirty,
		postMergeCleanup: LeanTurboRunner._internals.postMergeCleanup,
		publishLeanTurboLaneScopeBinding:
			LeanTurboRunner._internals.publishLeanTurboLaneScopeBinding,
	};
	LeanTurboRunner._internals.assertCleanWorkingTree = mock(() =>
		Promise.resolve({ clean: true }),
	) as never;
	LeanTurboRunner._internals.startupOrphanRecovery = mock(() =>
		Promise.resolve(undefined),
	) as never;
	LeanTurboRunner._internals.attemptMergeBackFromDirty = mock(() =>
		Promise.resolve({
			merged: true,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		}),
	) as never;
	LeanTurboRunner._internals.removeWorktree = mock(() =>
		Promise.resolve({ removed: true }),
	) as never;
	LeanTurboRunner._internals.removeLaneProfileFromDisk = mock(() =>
		Promise.resolve(undefined),
	) as never;
	LeanTurboRunner._internals.postMergeCleanup = mock(() =>
		Promise.resolve(undefined),
	) as never;
});

afterEach(() => {
	for (const [key, value] of Object.entries(originals)) {
		(LeanTurboRunner._internals as Record<string, unknown>)[key] = value;
	}
	clearScopeBindings();
	resetSwarmState();
	leanState.repairStateUnreadable(tmpDir);
	try {
		safeRmRecursive(tmpDir);
	} catch {
		/* best-effort */
	}
});

describe('runner publishes lane write authority (#2002)', () => {
	test('runPhase authorizes the lane coder before its prompt is sent', async () => {
		const runner = makeRunner();
		let childSessionId = '';
		let bindingAtPromptTime: unknown = null;
		injectSessionOps(runner, {
			create: mock(() => {
				childSessionId = 'lane-child-1';
				return Promise.resolve({ data: { id: childSessionId }, error: null });
			}),
			prompt: mock(() => {
				// The authority must already exist when the coder starts working.
				bindingAtPromptTime = resolveAuthorizedScopeBinding({
					directory: tmpDir,
					taskId: '1.1',
					activeSessionId: childSessionId,
				});
				return Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				});
			}),
			delete: mock(() => Promise.resolve()),
		});

		const result = await runner.runPhase(1);
		expect(result.ok).toBe(true);
		expect(result.lanes).toHaveLength(1);
		expect(bindingAtPromptTime).not.toBeNull();
		expect((bindingAtPromptTime as { files: string[] } | null)?.files).toEqual([
			'src/a.ts',
		]);
		expect(swarmState.agentSessions.get(childSessionId)?.currentTaskId).toBe(
			'1.1',
		);
	});

	test('the authorized lane coder can write in scope and is blocked outside it', async () => {
		const runner = makeRunner();
		const outcomes: Array<'allowed' | 'blocked'> = [];
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-2' }, error: null }),
			),
			prompt: mock(async () => {
				const hook = createScopeGuardHook({ enabled: true }, tmpDir);
				try {
					await hook.toolBefore(
						{ tool: 'write', sessionID: 'lane-child-2', callID: 'c1' },
						{ args: { path: 'src/a.ts', content: 'ok' } },
					);
					outcomes.push('allowed');
				} catch {
					outcomes.push('blocked');
				}
				try {
					await hook.toolBefore(
						{ tool: 'write', sessionID: 'lane-child-2', callID: 'c2' },
						{ args: { path: 'src/elsewhere.ts', content: 'no' } },
					);
					outcomes.push('allowed');
				} catch {
					outcomes.push('blocked');
				}
				return {
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				};
			}),
			delete: mock(() => Promise.resolve()),
		});

		await runner.runPhase(1);
		expect(outcomes).toEqual(['allowed', 'blocked']);
	});

	test('an isolated lane gets the plan materialized and its root recorded', async () => {
		const laneRoot = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'lane-scope-worktree-')),
		);
		LeanTurboRunner._internals.provisionWorktree = mock(() =>
			Promise.resolve({ worktreePath: laneRoot, branchName: 'swarm-lane/x' }),
		) as never;

		const runner = makeRunner({ worktree_isolation: true });
		let planMaterialized = false;
		let recordedRoot: string | undefined;
		let laneRootBinding: unknown = null;
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-3' }, error: null }),
			),
			prompt: mock(() => {
				planMaterialized = fs.existsSync(
					path.join(laneRoot, '.swarm', 'plan.json'),
				);
				recordedRoot =
					swarmState.agentSessions.get('lane-child-3')?.workspaceDirectory;
				laneRootBinding = resolveAuthorizedScopeBinding({
					directory: laneRoot,
					taskId: '1.1',
					activeSessionId: 'lane-child-3',
				});
				return Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				});
			}),
			delete: mock(() => Promise.resolve()),
		});

		try {
			await runner.runPhase(1);
			expect(planMaterialized).toBe(true);
			expect(recordedRoot).toBe(laneRoot);
			expect(laneRootBinding).not.toBeNull();
			// The lane binding must not authorize the project root.
			expect(
				resolveAuthorizedScopeBinding({
					directory: tmpDir,
					taskId: '1.1',
					activeSessionId: 'lane-child-3',
				}),
			).toBeNull();
		} finally {
			safeRmRecursive(laneRoot);
		}
	});

	test('dispatchLane without a plan publishes nothing (fail closed) and disables write tools', async () => {
		const runner = makeRunner();
		let promptTools: { write: boolean; edit: boolean; patch: boolean } | null =
			null;
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-4' }, error: null }),
			),
			prompt: mock((args: { body: { tools: typeof promptTools } }) => {
				promptTools = args.body.tools;
				return Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				});
			}),
			delete: mock(() => Promise.resolve()),
		});
		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');
		expect(result.ok).toBe(true);
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: 'lane-child-4',
			}),
		).toBeNull();
		// Issue #2002 hardening: a plan-less lane can never be dispatched
		// writable — see tests/unit/turbo/lean/lean-turbo-lane-dispatch-tools-gate.test.ts
		// for the full positive/negative coverage of this invariant.
		expect(promptTools).toEqual({ write: false, edit: false, patch: false });
	});
});

describe('runner fails the lane closed when authority cannot be published', () => {
	test('a publication throw tears down the session and fails permanently', async () => {
		LeanTurboRunner._internals.publishLeanTurboLaneScopeBinding = mock(() => {
			throw new Error('disk exploded');
		}) as never;

		const runner = makeRunner();
		const create = mock(() =>
			Promise.resolve({ data: { id: 'lane-child-5' }, error: null }),
		);
		const prompt = mock(() =>
			Promise.resolve({
				data: { parts: [{ type: 'text', text: 'Done' }] },
				error: null,
			}),
		);
		const del = mock(() => Promise.resolve());
		injectSessionOps(runner, { create, prompt, delete: del });

		const result = await runner.runPhase(1);
		expect(result.lanes[0]?.status).toBe('failed');
		expect(result.lanes[0]?.error).toContain(LANE_SCOPE_DENIED_CODE);
		// The code must stay outside every provider-transient / quota pattern, or
		// a broken authority handshake would be retried across fallback models.
		expect(isTransientProviderError(LANE_SCOPE_DENIED_CODE)).toBe(false);
		// The coder is never prompted, and its session is torn down.
		expect(prompt).not.toHaveBeenCalled();
		expect(del).toHaveBeenCalled();
		// Classified permanent: no model-fallback retry creates a second session.
		expect(create).toHaveBeenCalledTimes(1);
	});

	test('an unauthorizable lane still runs but publishes no binding', async () => {
		LeanTurboRunner._internals.publishLeanTurboLaneScopeBinding = mock(() =>
			Promise.resolve(null),
		) as never;

		const runner = makeRunner();
		const prompt = mock(() =>
			Promise.resolve({
				data: { parts: [{ type: 'text', text: 'Done' }] },
				error: null,
			}),
		);
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-6' }, error: null }),
			),
			prompt,
			delete: mock(() => Promise.resolve()),
		});

		const result = await runner.runPhase(1);
		expect(result.ok).toBe(true);
		expect(prompt).toHaveBeenCalled();
		// Pre-fix behaviour preserved: the coder runs with no authority and is
		// blocked by the ordinary scope gate on every write.
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: 'lane-child-6',
			}),
		).toBeNull();
		const advisories =
			swarmState.agentSessions.get(SESSION_ID)?.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((a: string) => a.includes('LEAN_TURBO_LANE_UNSCOPED')),
		).toBe(true);
	});

	test('LEAN_TURBO_LANE_UNSCOPED: an absent architect session is never minted — the advisory is emitted via criticalWarn (always-on stderr), not delivered', async () => {
		LeanTurboRunner._internals.publishLeanTurboLaneScopeBinding = mock(() =>
			Promise.resolve(null),
		) as never;

		// Undo this file's beforeEach registration of SESSION_ID so the
		// _publishLaneScope advisory push meets a genuinely absent session —
		// the case where it must emit via criticalWarn and mint nothing,
		// mirroring the dirty-tree site (tests/unit/turbo/lean/runner.test.ts).
		resetSwarmState();
		clearScopeBindings();
		expect(swarmState.agentSessions.get(SESSION_ID)).toBeUndefined();

		const runner = makeRunner();
		const prompt = mock(() =>
			Promise.resolve({
				data: { parts: [{ type: 'text', text: 'Done' }] },
				error: null,
			}),
		);
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-7' }, error: null }),
			),
			prompt,
			delete: mock(() => Promise.resolve()),
		});

		// Capture console.warn directly (not via mock.module — this file's
		// documented strategy is "No mock.module usage — everything goes
		// through the _internals / _sessionOps DI seams"). `criticalWarn`
		// (src/utils/logger.ts) writes to stderr through console.warn
		// unconditionally; `log()`/`warn()` only reach console under
		// OPENCODE_SWARM_DEBUG=1, and even then `warn()` tags its line `WARN:`
		// rather than `CRITICAL-WARN:`. Capturing here means the assertion below
		// fails if the production call is deleted OR swapped to `log`/`warn`, in
		// every environment — not just when debug logging happens to be off.
		const capturedWarnCalls: unknown[][] = [];
		const originalConsoleWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			capturedWarnCalls.push(args);
		};

		let result: Awaited<ReturnType<typeof runner.runPhase>>;
		try {
			result = await runner.runPhase(1);
		} finally {
			console.warn = originalConsoleWarn;
		}
		expect(result.ok).toBe(true);
		expect(prompt).toHaveBeenCalled();

		// No session may be minted for an absent id. `SESSION_ID` reaches the
		// runner from the `lean_turbo_run_phase` tool's zod `sessionID`
		// argument, so it is caller-supplied.
		//
		// NOT because 'architect' would be more permissive than 'unknown' — it
		// is not. scope-guard.ts early-returns for BOTH ('isArchitect' and
		// 'agentRole !== coder'), and on the shell path 'unknown' is strictly
		// MORE permissive, because noScopeLenient in guardrails/tool-before.ts
		// is `!isArch && !isCoder && …` and skips the authority check for
		// 'unknown' only. The reason is simply that minting writes a durable,
		// cross-hook identity assertion into swarmState.activeAgent for an id
		// the plugin never issued. See the block comment on
		// pushDirtyTreeDowngradeAdvisory in src/turbo/lean/runner.ts.
		//
		// The advisory is emitted via criticalWarn instead, so it stays
		// observable without creating an identity the plugin never issued.
		expect(swarmState.agentSessions.get(SESSION_ID)).toBeUndefined();
		expect(swarmState.activeAgent.get(SESSION_ID)).toBeUndefined();

		// Emission half of the guarantee: the unscoped-lane branch of
		// _publishLaneScope (src/turbo/lean/runner.ts) must have actually
		// called criticalWarn with the advisory code, the "not delivered"
		// wording, and the session id — not merely skipped minting. Deleting
		// the criticalWarn call, or swapping it for `log(...)`/`warn(...)`,
		// leaves the non-minting assertions above passing byte-identically
		// while this fails.
		const unscopedAdvisoryCall = capturedWarnCalls.find((call) =>
			call.some(
				(arg) =>
					typeof arg === 'string' &&
					arg.includes('CRITICAL-WARN:') &&
					arg.includes('LEAN_TURBO_LANE_UNSCOPED') &&
					arg.includes(
						`(advisory not delivered: session ${SESSION_ID} is not registered)`,
					),
			),
		);
		expect(unscopedAdvisoryCall).toBeDefined();
	});
});

describe('runner clears published lane authority on a post-publication dispatch failure (#2002)', () => {
	test('binding and child session do not survive session.prompt failing after publish succeeded', async () => {
		const runner = makeRunner();
		const childSessionId = 'lane-child-prompt-fail';
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: childSessionId }, error: null }),
			),
			prompt: mock(() => {
				// Authority must exist at prompt time — proves the failure happens
				// AFTER _publishLaneScope succeeded, not before.
				expect(
					resolveAuthorizedScopeBinding({
						directory: tmpDir,
						taskId: '1.1',
						activeSessionId: childSessionId,
					}),
				).not.toBeNull();
				expect(swarmState.agentSessions.get(childSessionId)).toBeDefined();
				return Promise.resolve({ data: null, error: 'provider rejected' });
			}),
			delete: mock(() => Promise.resolve()),
		});
		const lane: LeanTurboLane = {
			laneId: 'lane-prompt-fail',
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
		// The published binding must not outlive the failed dispatch — a stale
		// binding with up to a 1h TTL would otherwise keep authorizing writes
		// for a session that no longer has a live coder attached to it.
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: childSessionId,
			}),
		).toBeNull();
		// The child AgentSessionState must not outlive the failed dispatch either
		// (pre-fix: it stayed in swarmState for up to 2h).
		expect(swarmState.agentSessions.get(childSessionId)).toBeUndefined();
	});

	test('binding and child session do not survive an exception thrown after publish succeeded', async () => {
		const runner = makeRunner();
		const childSessionId = 'lane-child-throw-fail';
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: childSessionId }, error: null }),
			),
			prompt: mock(() => {
				throw new Error('unexpected provider crash');
			}),
			delete: mock(() => Promise.resolve()),
		});
		const lane: LeanTurboLane = {
			laneId: 'lane-throw-fail',
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
