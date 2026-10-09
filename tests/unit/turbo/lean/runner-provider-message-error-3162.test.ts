/**
 * Complement regression suite for #3162 — pins the Lean lane runner's
 * provider-error handling and its fallback wiring as shipped on main
 * (d480b3363), where `dispatchLane` reads the assistant message's
 * `info.error` through the shared `provider-message-error` reader and fails
 * the lane (abort + teardown + endAgentSession) instead of completing a
 * provider-refused request as a successful answer.
 *
 * Deeper than the base `runner-provider-error.test.ts`: formatted-error shape,
 * abort/scope-binding teardown observability, classifier readability both
 * ways, the `MessageOutputLengthError` carve-out, and the #1896 model-fallback
 * chain (activation, 403 non-failover, exhaustion) plus the timeout-race
 * interaction. Fixtures live in `runner-provider-error-3162-fixtures.ts`
 * (FR-006 split); no `mock.module`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveFallbackModel } from '../../../../src/agents/index';
import { resetScopedModelSelectionStateForTests } from '../../../../src/models/model-override-state';
import { clearScopeBindings } from '../../../../src/scope/scope-binding';
import { resolveAuthorizedScopeBinding } from '../../../../src/scope/scope-persistence';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../../src/state';
import {
	LANE_SCOPE_DENIED_CODE,
	type LaneDispatchResult,
	LeanTurboRunner,
} from '../../../../src/turbo/lean/runner';
import * as leanState from '../../../../src/turbo/lean/state';
import {
	dispatchWithModelFallback,
	type ModelOverride,
} from '../../../../src/utils/model-dispatch-fallback';
import { isTransientProviderError } from '../../../../src/utils/provider-error-classification';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';
import {
	CLEAN_RESULT,
	injectSessionOps,
	LANE,
	makeRunner,
	PLAN,
	providerRefusalResult,
	SESSION_ID,
	setTmpDir,
	truncatedReplyResult,
} from './runner-provider-error-3162-fixtures';

let tmpDir: string;

beforeEach(() => {
	resetSwarmState();
	clearScopeBindings();
	startAgentSession(SESSION_ID, 'architect');
	tmpDir = canonicalMkdtemp('lean-3162-runner-');
	setTmpDir(tmpDir);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	// resolveAuthorizedScopeBinding reads .swarm/plan.json from `directory` to
	// recompute planId/planStructureHash — write the same PLAN dispatchLane is
	// given so plan-backed cases exercise the real lookup (tools-gate suite
	// convention).
	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify(PLAN, null, 2),
		'utf-8',
	);
});

afterEach(() => {
	clearScopeBindings();
	resetSwarmState();
	resetScopedModelSelectionStateForTests();
	leanState.repairStateUnreadable(tmpDir);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

describe('#3162 dispatchLane provider errors recorded on the assistant message', () => {
	test('(a) a 429 info.error result fails dispatch with the formatted provider error and aborts the prompt', async () => {
		const runner = makeRunner();
		let capturedSignal: AbortSignal | undefined;
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-a' }, error: null }),
			),
			prompt: mock((args: { signal?: AbortSignal }) => {
				capturedSignal = args.signal;
				return Promise.resolve(
					providerRefusalResult(429, 'Rate limit exceeded for model'),
				);
			}),
			delete: mock(() => Promise.resolve()),
		});

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result.ok).toBe(false);
		// Pinned to the formatProviderMessageError shape — a raw
		// JSON.stringify(info.error) dump must not satisfy this.
		expect(result.error).toMatch(
			/^session\.prompt provider error: AI_APICallError \(HTTP 429\): /,
		);
		// The bounded display text keeps the sanitized provider message
		// (a constant-message mutant must not pass).
		expect(result.error).toContain('Rate limit exceeded for model');
		// The failure branch aborts the in-flight prompt signal.
		expect(capturedSignal?.aborted).toBe(true);
	});

	test('(b) the failure branch tears down the lane child session, its agent-session state, and the published scope binding', async () => {
		const runner = makeRunner();
		const CHILD_ID = 'lane-child-b';
		const deletedIds: string[] = [];
		const signalAbortedAtDelete: boolean[] = [];
		let childStateExistedAtPrompt = false;
		let bindingExistedAtPrompt = false;
		let promptSignal: AbortSignal | undefined;
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: CHILD_ID }, error: null }),
			),
			prompt: mock((args: { signal?: AbortSignal }) => {
				// Non-vacuity probes: on the plan-backed path the child
				// AgentSessionState AND the write-authority binding exist at
				// prompt time.
				childStateExistedAtPrompt = getAgentSession(CHILD_ID) !== undefined;
				bindingExistedAtPrompt =
					resolveAuthorizedScopeBinding({
						directory: tmpDir,
						taskId: '1.1',
						activeSessionId: CHILD_ID,
					}) !== null;
				promptSignal = args.signal;
				return Promise.resolve(
					providerRefusalResult(429, 'Rate limit exceeded'),
				);
			}),
			delete: mock((opts: { path: { id: string } }) => {
				// #2123 ordering: the prompt signal must be aborted BEFORE the
				// session delete is issued.
				signalAbortedAtDelete.push(promptSignal?.aborted === true);
				deletedIds.push(opts.path.id);
				return Promise.resolve();
			}),
		});

		const result = await runner.dispatchLane(
			LANE,
			'coder',
			undefined,
			undefined,
			PLAN,
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/^session\.prompt provider error: /);
		expect(childStateExistedAtPrompt).toBe(true);
		expect(bindingExistedAtPrompt).toBe(true);
		// endAgentSession runs synchronously inside the failure branch: the
		// child state AND its #2002 write-authority binding are gone.
		expect(getAgentSession(CHILD_ID)).toBeUndefined();
		expect(
			resolveAuthorizedScopeBinding({
				directory: tmpDir,
				taskId: '1.1',
				activeSessionId: CHILD_ID,
			}),
		).toBeNull();
		// teardownEphemeralSession is fire-and-forget (void'd); settle before
		// observing the session delete (C2 probe convention).
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(deletedIds).toContain(CHILD_ID);
		expect(signalAbortedAtDelete).toEqual([true]);
	});

	test('(c) the returned error stays classifier-readable: 429 transient, 403 refusal not', async () => {
		const transient = makeRunner();
		injectSessionOps(transient, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-c429' }, error: null }),
			),
			prompt: mock(() =>
				Promise.resolve(
					providerRefusalResult(429, 'Rate limit exceeded for model'),
				),
			),
			delete: mock(() => Promise.resolve()),
		});
		const transientResult = await transient.dispatchLane(LANE, 'coder');
		expect(transientResult.ok).toBe(false);
		expect(isTransientProviderError(transientResult.error ?? '')).toBe(true);

		const refusal = makeRunner();
		injectSessionOps(refusal, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-c403' }, error: null }),
			),
			prompt: mock(() =>
				Promise.resolve(providerRefusalResult(403, 'Insufficient access')),
			),
			delete: mock(() => Promise.resolve()),
		});
		const refusalResult = await refusal.dispatchLane(LANE, 'coder');
		expect(refusalResult.ok).toBe(false);
		// Same formatted-shape pin as the 429 leg — the 403 refusal also goes
		// through formatProviderMessageError, not a raw dump.
		expect(refusalResult.error).toMatch(
			/^session\.prompt provider error: AI_APICallError \(HTTP 403\): /,
		);
		expect(isTransientProviderError(refusalResult.error ?? '')).toBe(false);
	});

	test('(d) a clean message (info present, no error; info empty or null) still dispatches ok', async () => {
		// Production success responses carry message `info` with no `error`;
		// `info: {}` / `info: null` / an absent key must behave identically.
		const cleanShapes: Array<Record<string, unknown>> = [
			{ parts: [{ type: 'text', text: 'Done' }], info: { id: 'msg_ok' } },
			{ parts: [{ type: 'text', text: 'Done' }], info: {} },
			{ parts: [{ type: 'text', text: 'Done' }], info: null },
			{ parts: [{ type: 'text', text: 'Done' }] },
		];
		for (const data of cleanShapes) {
			const runner = makeRunner();
			injectSessionOps(runner, {
				create: mock(() =>
					Promise.resolve({ data: { id: 'lane-child-d' }, error: null }),
				),
				prompt: mock(() => Promise.resolve({ data, error: null })),
				delete: mock(() => Promise.resolve()),
			});
			const result = await runner.dispatchLane(LANE, 'coder');
			expect(result.ok).toBe(true);
			expect(result.sessionId).toBe('lane-child-d');
		}
	});

	test('(e) a truncated MessageOutputLengthError reply is NOT a refusal — the lane keeps its output', async () => {
		// Main's carve-out: a truncated-but-usable reply must keep the lane
		// behavior it had before the runner started reading info.error.
		const runner = makeRunner();
		injectSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'lane-child-e' }, error: null }),
			),
			prompt: mock(() => Promise.resolve(truncatedReplyResult())),
			delete: mock(() => Promise.resolve()),
		});

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result.ok).toBe(true);
		expect(result.sessionId).toBe('lane-child-e');
	});
});

describe('#3162 the #1896 model-fallback chain over provider-refused lanes', () => {
	test('(f) a provider-refused lane fails over to the configured fallback model (the #1896 chain runs)', async () => {
		const runner = makeRunner();
		const promptModels: Array<unknown> = [];
		let createCount = 0;
		injectSessionOps(runner, {
			create: mock(() => {
				createCount += 1;
				return Promise.resolve({
					data: { id: `lane-child-f-${createCount}` },
					error: null,
				});
			}),
			prompt: mock((args: { body: { model?: unknown } }) => {
				promptModels.push(args.body.model);
				// Primary attempt: provider-refused. Fallback attempt: clean.
				return promptModels.length === 1
					? Promise.resolve(
							providerRefusalResult(429, 'Rate limit exceeded for model'),
						)
					: Promise.resolve(CLEAN_RESULT);
			}),
			delete: mock(() => Promise.resolve()),
		});

		const fb = await dispatchWithModelFallback<LaneDispatchResult>({
			dispatch: makeDispatch(runner),
			scope: {
				sessionID: SESSION_ID,
				invocationID: `lean-runner:${LANE.laneId}`,
				swarmID: undefined,
				role: 'coder',
			},
			primaryModel: undefined,
			fallbackModels: ['prov/fb1'],
			resolveFallback: (index) =>
				resolveFallbackModel('coder', index, undefined),
			maxTransientRetriesPerModel: 0,
			classify: productionClassify,
		});

		expect(fb.result.ok).toBe(true);
		expect(promptModels).toHaveLength(2);
		expect(promptModels[0]).toBeUndefined();
		expect(promptModels[1]).toEqual({ providerID: 'prov', modelID: 'fb1' });
	});

	test('(g) a 403 refusal does NOT fail over — one attempt, chain stops (permanent)', async () => {
		const runner = makeRunner();
		const promptModels: Array<unknown> = [];
		let createCount = 0;
		injectSessionOps(runner, {
			create: mock(() => {
				createCount += 1;
				return Promise.resolve({
					data: { id: `lane-child-g-${createCount}` },
					error: null,
				});
			}),
			prompt: mock((args: { body: { model?: unknown } }) => {
				promptModels.push(args.body.model);
				return Promise.resolve(
					providerRefusalResult(403, 'Insufficient access'),
				);
			}),
			delete: mock(() => Promise.resolve()),
		});

		let thrown: Error | undefined;
		try {
			await dispatchWithModelFallback<LaneDispatchResult>({
				dispatch: makeDispatch(runner),
				scope: {
					sessionID: SESSION_ID,
					invocationID: `lean-runner:${LANE.laneId}`,
					swarmID: undefined,
					role: 'coder',
				},
				primaryModel: undefined,
				fallbackModels: ['prov/fb1'],
				resolveFallback: (index) =>
					resolveFallbackModel('coder', index, undefined),
				maxTransientRetriesPerModel: 0,
				classify: productionClassify,
			});
			throw new Error('expected the dispatch chain to throw on a 403 refusal');
		} catch (err) {
			if (
				err instanceof Error &&
				/expected the dispatch chain/.test(err.message)
			)
				throw err;
			thrown = err instanceof Error ? err : new Error(String(err));
		}

		// Deterministic auth/config failure: classified permanent, so the
		// fallback model is never attempted — the provider message surfaces.
		expect(promptModels).toHaveLength(1);
		expect(promptModels[0]).toBeUndefined();
		expect(thrown?.message).toMatch(
			/^session\.prompt provider error: AI_APICallError \(HTTP 403\): /,
		);
	});

	test('(h) a fully exhausted chain surfaces the last provider error after attempting every model', async () => {
		const runner = makeRunner();
		const promptModels: Array<unknown> = [];
		let createCount = 0;
		injectSessionOps(runner, {
			create: mock(() => {
				createCount += 1;
				return Promise.resolve({
					data: { id: `lane-child-h-${createCount}` },
					error: null,
				});
			}),
			prompt: mock((args: { body: { model?: unknown } }) => {
				promptModels.push(args.body.model);
				return Promise.resolve(
					providerRefusalResult(429, 'Rate limit exceeded for model'),
				);
			}),
			delete: mock(() => Promise.resolve()),
		});

		let thrown: Error | undefined;
		try {
			await dispatchWithModelFallback<LaneDispatchResult>({
				dispatch: makeDispatch(runner),
				scope: {
					sessionID: SESSION_ID,
					invocationID: `lean-runner:${LANE.laneId}`,
					swarmID: undefined,
					role: 'coder',
				},
				primaryModel: undefined,
				fallbackModels: ['prov/fb1'],
				resolveFallback: (index) =>
					resolveFallbackModel('coder', index, undefined),
				maxTransientRetriesPerModel: 0,
				classify: productionClassify,
			});
			throw new Error('expected the exhausted chain to throw');
		} catch (err) {
			if (
				err instanceof Error &&
				/expected the exhausted chain/.test(err.message)
			)
				throw err;
			thrown = err instanceof Error ? err : new Error(String(err));
		}

		// Every chain entry attempted with a distinct model; the last
		// provider error is what surfaces for the lane failure.
		expect(promptModels).toHaveLength(2);
		expect(promptModels[0]).toBeUndefined();
		expect(promptModels[1]).toEqual({ providerID: 'prov', modelID: 'fb1' });
		expect(thrown?.message).toMatch(/\(HTTP 429\)/);
	});
});

describe('#3162 lane dispatch timeout race', () => {
	test('(i) a timeout still fails the lane when the prompt later resolves with a provider error', async () => {
		const runner = makeRunner();
		const internals = LeanTurboRunner._internals as unknown as {
			laneDispatchTimeoutMs: number | undefined;
		};
		const priorTimeout = internals.laneDispatchTimeoutMs;
		internals.laneDispatchTimeoutMs = 5;
		try {
			injectSessionOps(runner, {
				create: mock(() =>
					Promise.resolve({ data: { id: 'lane-child-i' }, error: null }),
				),
				prompt: mock(
					() =>
						new Promise((resolve) =>
							setTimeout(
								() =>
									resolve(providerRefusalResult(429, 'Rate limit exceeded')),
								40,
							),
						),
				),
				delete: mock(() => Promise.resolve()),
			});

			const result = await runner.dispatchLane(LANE, 'coder');

			// The timeout wins the race and keeps its fail-the-lane behavior;
			// the late provider-error resolution must not crash or double-tear-down.
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/Lane dispatch timed out after 5ms/);
			// Let the late resolution settle so its marker path runs cleanly.
			await new Promise((resolve) => setTimeout(resolve, 80));
		} finally {
			internals.laneDispatchTimeoutMs = priorTimeout;
		}
	});
});

/** The production `classify` callback shape (`_processLane` in runner.ts). */
function productionClassify(err: unknown): 'transient' | 'permanent' {
	const msg = err instanceof Error ? err.message : String(err);
	if (/Lane dispatch timed out/i.test(msg)) return 'permanent';
	// Issue #2002: a failed write-authority handshake is a local invariant
	// break — never retried on another model.
	if (msg.includes(LANE_SCOPE_DENIED_CODE)) return 'permanent';
	return isTransientProviderError(msg) ? 'transient' : 'permanent';
}

/** The production dispatch callback shape (`_processLane` in runner.ts). */
function makeDispatch(runner: ReturnType<typeof makeRunner>) {
	return async (model: ModelOverride | undefined) => {
		const r = await runner.dispatchLane(
			LANE,
			'coder',
			undefined,
			model,
			undefined,
		);
		if (!r.ok) throw new Error(r.error ?? 'lane dispatch failed');
		return r;
	};
}
