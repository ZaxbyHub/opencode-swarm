/**
 * Adversarial security tests for LeanTurboRunner — timeout and concurrency focus.
 *
 * Attack vectors tested (extending runner.adversarial.test.ts):
 * - Zero/negative timeout bypass (no timeout applied when timeoutMs <= 0)
 * - Non-Error rejection from _doDispatch (orphan cleanup may be skipped)
 * - Session orphan creation when timeout fires after session.create but before prompt
 * - Lock leak when dispatchLane has no timeout (infinite hang with locks held)
 * - Empty files array lane dispatch
 * - Concurrent timeout races on _timedOutLanes Map
 *
 * Strategy:
 * - Uses real tmpDir + real lane planning via _internals
 * - Injects mock SessionClient via _sessionOps seam
 * - Uses real lock acquisition via file-locks._internals
 * - No mock.module usage — all mocking via instance seam or _internals
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LeanTurboLane } from '../../../../src/turbo/lean/planner';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import * as leanState from '../../../../src/turbo/lean/state';

const SESSION_ID = 'sess-timeout-adversarial';

interface MockSessionOps {
	create: ReturnType<typeof mock>;
	prompt: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
}

let tmpDir: string;
let mockSessionOps: MockSessionOps;

function makeRunner(options?: {
	opencodeClient?: null;
	generatedAgentNames?: string[];
}) {
	return new LeanTurboRunner({
		directory: tmpDir,
		sessionID: SESSION_ID,
		...options,
	});
}

function injectMockSessionOps(runner: LeanTurboRunner, ops: MockSessionOps) {
	(runner as unknown as { _sessionOps: MockSessionOps })._sessionOps = ops;
}

function writeMinimalPlan(phaseNumber = 1) {
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: phaseNumber,
		phases: [
			{
				id: phaseNumber,
				name: `Phase ${phaseNumber}`,
				status: 'in_progress',
				tasks: [
					{
						id: `${phaseNumber}.1`,
						description: 'Task 1',
						status: 'pending',
						phase: phaseNumber,
						size: 'small',
						depends: [],
						acceptance: 'Done',
					},
					{
						id: `${phaseNumber}.2`,
						description: 'Task 2',
						status: 'pending',
						phase: phaseNumber,
						size: 'small',
						depends: [],
						acceptance: 'Done',
					},
				],
			},
		],
		lean: {
			max_parallel_coders: 4,
			require_declared_scope: false,
			conflict_policy: 'serialize',
			degrade_on_risk: true,
			phase_reviewer: false,
			phase_critic: false,
			integrated_diff_required: false,
			allow_docs_only_without_reviewer: false,
			worktree_isolation: false,
		},
	};

	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);
}

function writeScopeFiles(taskFiles: Record<string, string[]>) {
	const scopeDir = path.join(tmpDir, '.swarm', 'scopes');
	fs.mkdirSync(scopeDir, { recursive: true });
	for (const [taskId, files] of Object.entries(taskFiles)) {
		fs.writeFileSync(
			path.join(scopeDir, `scope-${taskId}.json`),
			JSON.stringify({ files }),
			'utf-8',
		);
	}
}

function mockSuccessfulSessionOps() {
	const mockCreate = mock(() =>
		Promise.resolve({
			data: { id: `session-${Math.random().toString(36).slice(2)}` },
			error: null,
		}),
	);
	const mockPrompt = mock(() =>
		Promise.resolve({
			data: { parts: [{ type: 'text', text: 'Done' }] },
			error: null,
		}),
	);
	const mockDelete = mock(() => Promise.resolve());
	return { create: mockCreate, prompt: mockPrompt, delete: mockDelete };
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'runner-timeout-adversarial-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	mockSessionOps = mockSuccessfulSessionOps();
	// Reset timeout to undefined before each test
	LeanTurboRunner._internals.laneDispatchTimeoutMs = undefined;
});

afterEach(() => {
	leanState.repairStateUnreadable(tmpDir);
	LeanTurboRunner._internals.laneDispatchTimeoutMs = undefined;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T1: Zero/negative timeout bypass
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T1 — zero/negative timeout bypass', () => {
	test('laneDispatchTimeoutMs=0 results in NO timeout wrapper (dispatch runs unbounded)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Session that takes longer than any reasonable timeout
		const slowCreate = mock(() =>
			Bun.sleep(300).then(() =>
				Promise.resolve({
					data: { id: `session-${Math.random().toString(36).slice(2)}` },
					error: null,
				}),
			),
		);
		const slowPrompt = mock(() =>
			Bun.sleep(300).then(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
		);
		const slowOps = {
			create: slowCreate,
			prompt: slowPrompt,
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, slowOps);

		// Set timeout to 0 — should NOT create a timeout wrapper
		LeanTurboRunner._internals.laneDispatchTimeoutMs = 0;

		const startTime = Date.now();
		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};
		const result = await runner.dispatchLane(lane, 'mega_coder');
		const elapsed = Date.now() - startTime;

		// With timeout=0, no timeout wrapper is created
		// Dispatch should complete (takes ~600ms for slow mock)
		// If timeout was applied, result would be error "timed out" and elapsed < 100ms
		expect(result.ok).toBe(true);
		expect(elapsed).toBeGreaterThan(200); // Confirms no timeout was applied
	});

	test('laneDispatchTimeoutMs=-100 results in NO timeout wrapper (dispatch runs unbounded)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const slowOps = {
			create: mock(() =>
				Bun.sleep(100).then(() =>
					Promise.resolve({
						data: { id: `session-${Math.random().toString(36).slice(2)}` },
						error: null,
					}),
				),
			),
			prompt: mock(() =>
				Bun.sleep(100).then(() =>
					Promise.resolve({
						data: { parts: [{ type: 'text', text: 'Done' }] },
						error: null,
					}),
				),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, slowOps);

		// Set negative timeout — should NOT create a timeout wrapper
		LeanTurboRunner._internals.laneDispatchTimeoutMs = -100;

		const startTime = Date.now();
		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};
		const result = await runner.dispatchLane(lane, 'mega_coder');
		const elapsed = Date.now() - startTime;

		// With negative timeout, no timeout wrapper is created
		expect(result.ok).toBe(true);
		expect(elapsed).toBeGreaterThan(50); // Confirms no timeout was applied
	});

	test('laneDispatchTimeoutMs=undefined results in NO timeout wrapper (dispatch runs unbounded)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const slowOps = {
			create: mock(() =>
				Bun.sleep(50).then(() =>
					Promise.resolve({
						data: { id: `session-${Math.random().toString(36).slice(2)}` },
						error: null,
					}),
				),
			),
			prompt: mock(() =>
				Bun.sleep(50).then(() =>
					Promise.resolve({
						data: { parts: [{ type: 'text', text: 'Done' }] },
						error: null,
					}),
				),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, slowOps);

		// Explicitly undefined — no timeout
		LeanTurboRunner._internals.laneDispatchTimeoutMs = undefined;

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};
		const result = await runner.dispatchLane(lane, 'mega_coder');

		// Should complete successfully since no timeout
		expect(result.ok).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T2: Lock leak when dispatchLane has no timeout
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T2 — lock leak when dispatchLane has no timeout', () => {
	test('locks are NOT released when laneDispatchTimeoutMs=undefined and dispatchLane hangs indefinitely', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Session that hangs forever (never resolves)
		const hangingOps = {
			create: mock(() => new Promise(() => {}) /* never resolves */),
			prompt: mock(() => new Promise(() => {})),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, hangingOps);

		// No timeout — dispatchLane will hang
		LeanTurboRunner._internals.laneDispatchTimeoutMs = undefined;

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};

		// Track release calls
		const releaseCalls: Array<{ dir: string; laneId: string }> = [];
		const origRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push({ dir, laneId });
				return Promise.resolve(1);
			},
		);

		// Start dispatch but don't await — we're testing that WITHOUT timeout,
		// if dispatchLane hangs, cleanup from runPhase's Promise.all won't help this lane
		const dispatchPromise = runner.dispatchLane(lane, 'mega_coder');

		// Wait a bit to see if release was called
		await Bun.sleep(100);

		LeanTurboRunner._internals.releaseLaneLocks = origRelease;

		// With no timeout and hanging dispatch, releaseLaneLocks is NOT called
		// because dispatchLane never returns (no timeout to trigger error path)
		// This is the "lock leak" scenario — locks acquired but no timeout to force cleanup
		expect(releaseCalls.length).toBe(0);

		// Cancel the hanging promise to clean up
		dispatchPromise.catch(() => {});
	});

	test('dispatchLane returns timeout error when session hangs and timeout is positive', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Session that hangs
		const hangingOps = {
			create: mock(() => new Promise(() => {})),
			prompt: mock(() => new Promise(() => {})),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, hangingOps);

		// Set a short positive timeout
		LeanTurboRunner._internals.laneDispatchTimeoutMs = 20;

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// With positive timeout, dispatchLane returns error after timeout
		// Note: releaseLaneLocks is called by _processLane (via runPhase), not dispatchLane directly
		expect(result.ok).toBe(false);
		expect(result.error).toContain('timed out');
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T3: Session orphan when timeout fires during _doDispatch
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T3 — session orphan when timeout fires after session.create', () => {
	test('orphan session is cleaned up when timeout fires after create but before prompt completes', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Fast create, slow prompt — timeout fires between them
		const sessionId = `orphan-session-${Math.random().toString(36).slice(2)}`;
		const fastCreate = mock(() =>
			Promise.resolve({
				data: { id: sessionId },
				error: null,
			}),
		);
		const slowPrompt = mock(() =>
			Bun.sleep(500).then(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
		);
		const deleteMock = mock(() => Promise.resolve());
		const hangingOps = {
			create: fastCreate,
			prompt: slowPrompt,
			delete: deleteMock,
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, hangingOps);

		// Set very short timeout so it fires while prompt is pending
		LeanTurboRunner._internals.laneDispatchTimeoutMs = 30;

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// Wait for background completion handler to run
		await Bun.sleep(600);

		// Timeout fired before prompt completed
		expect(result.ok).toBe(false);
		expect(result.error).toContain('timed out');

		// Orphan session should be cleaned up
		expect(deleteMock).toHaveBeenCalledWith(
			expect.objectContaining({ path: { id: sessionId } }),
		);
	});

	test('no orphan cleanup when dispatch completes BEFORE timeout fires', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const sessionId = `normal-session-${Math.random().toString(36).slice(2)}`;
		const fastCreate = mock(() =>
			Promise.resolve({
				data: { id: sessionId },
				error: null,
			}),
		);
		// Fast prompt too — completes before timeout
		const fastPrompt = mock(() =>
			Promise.resolve({
				data: { parts: [{ type: 'text', text: 'Done' }] },
				error: null,
			}),
		);
		const deleteMock = mock(() => Promise.resolve());
		const fastOps = {
			create: fastCreate,
			prompt: fastPrompt,
			delete: deleteMock,
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, fastOps);

		// Long timeout — dispatch completes first
		LeanTurboRunner._internals.laneDispatchTimeoutMs = 500;

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// Wait for any background handlers
		await Bun.sleep(100);

		// Dispatch succeeded — no orphan
		expect(result.ok).toBe(true);
		expect(result.sessionId).toBe(sessionId);

		// delete should NOT be called since no orphan was created
		expect(deleteMock).not.toHaveBeenCalled();
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T4: Non-Error rejection from _doDispatch
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T4 — non-Error rejection handling', () => {
	test('_doDispatch rejection with Error object triggers proper error result', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const errorOps = {
			create: mock(() => Promise.reject(new Error('ECONNREFUSED'))),
			prompt: mock(() => Promise.resolve({ data: null, error: 'timeout' })),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, errorOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// Error from _doDispatch is caught and returned as error result
		expect(result.ok).toBe(false);
		expect(result.error).toBe('ECONNREFUSED');
	});

	test('_doDispatch rejection with string triggers error result', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const stringRejectOps = {
			create: mock(() => Promise.reject('string rejection')),
			prompt: mock(() => Promise.resolve({ data: null, error: 'timeout' })),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, stringRejectOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// String rejection is converted to error message
		expect(result.ok).toBe(false);
		expect(result.error).toBe('string rejection');
	});

	test('_doDispatch rejection with null triggers error result', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const nullRejectOps = {
			create: mock(() => Promise.reject(null)),
			prompt: mock(() => Promise.resolve({ data: null, error: 'timeout' })),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, nullRejectOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// null rejection is stringified
		expect(result.ok).toBe(false);
		expect(result.error).toBe('null');
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T5: Empty files array lane
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T5 — empty files array lane dispatch', () => {
	test('dispatchLane succeeds with empty files array (0 locks acquired)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [], // Empty files array
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// Dispatch should succeed even with 0 files
		expect(result.ok).toBe(true);
		expect(mockSessionOps.create).toHaveBeenCalled();
		expect(mockSessionOps.prompt).toHaveBeenCalled();
	});

	test('runPhase with lane that has empty files does not crash', async () => {
		// Plan with tasks that have empty scopes
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
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
							description: 'Task with no scope',
							status: 'pending',
							phase: 1,
							size: 'small',
							depends: [],
							acceptance: 'Done',
						},
					],
				},
			],
			lean: {
				max_parallel_coders: 4,
				require_declared_scope: false, // Allow missing scope
				conflict_policy: 'serialize',
				degrade_on_risk: true,
				phase_reviewer: false,
				phase_critic: false,
				integrated_diff_required: false,
				allow_docs_only_without_reviewer: false,
				worktree_isolation: false,
			},
		};

		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);

		// No scope files — tasks will have empty scopes
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Should not throw even with empty file scopes
		const result = await runner.runPhase(1);

		// With all-serialized/degraded tasks, runner now persists state and returns ok:true
		// Truly empty phases (no lanes, no fallback) return NO_LANES
		if (result.ok) {
			expect(result.lanes).toEqual([]);
		} else {
			expect(result.reason).toBe('NO_LANES');
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T6: Concurrent timeout race on _timedOutLanes Map
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T6 — concurrent timeout race on _timedOutLanes', () => {
	test('two lanes with same laneId do not interfere on _timedOutLanes', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] });

		const sessionId1 = `session-1-${Math.random().toString(36).slice(2)}`;
		const sessionId2 = `session-2-${Math.random().toString(36).slice(2)}`;

		// Both lanes share the same laneId (adversarial input)
		const lane1: LeanTurboLane = {
			laneId: 'same-lane-id', // Same laneId
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};
		const lane2: LeanTurboLane = {
			laneId: 'same-lane-id', // Same laneId
			taskIds: ['1.2'],
			files: ['src/b.ts'],
			status: 'pending',
		};

		const createMock = mock((opts: { query: { directory: string } }) => {
			const id = opts.query.directory === tmpDir ? sessionId1 : sessionId2;
			return Promise.resolve({ data: { id }, error: null });
		});
		const promptMock = mock(() =>
			Bun.sleep(500).then(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
		);
		const deleteMock = mock(() => Promise.resolve());

		const concurrentOps = {
			create: createMock,
			prompt: promptMock,
			delete: deleteMock,
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, concurrentOps);

		LeanTurboRunner._internals.laneDispatchTimeoutMs = 20;

		// Dispatch both lanes with same laneId concurrently
		const [result1, result2] = await Promise.all([
			runner.dispatchLane(lane1, 'mega_coder'),
			runner.dispatchLane(lane2, 'mega_coder'),
		]);

		// Wait for background completions
		await Bun.sleep(600);

		// Both should get timeout errors
		expect(result1.ok).toBe(false);
		expect(result2.ok).toBe(false);
		expect(result1.error).toContain('timed out');
		expect(result2.error).toContain('timed out');

		// Both sessions should be cleaned up
		expect(deleteMock).toHaveBeenCalled();
	});

	test('rapid concurrent timeouts on different lanes do not corrupt _timedOutLanes state', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({
			'1.1': ['src/a.ts'],
			'1.2': ['src/b.ts'],
		});

		// 2 lanes that timeout quickly
		const lanes: LeanTurboLane[] = [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: ['src/a.ts'],
				status: 'pending',
			},
			{
				laneId: 'lane-2',
				taskIds: ['1.2'],
				files: ['src/b.ts'],
				status: 'pending',
			},
		];

		// Fast create (resolves immediately), prompt rejects after delay
		// This ensures _doDispatch settles when prompt rejects, triggering completion handler
		const rejectPromptOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: `session-${Math.random().toString(36).slice(2)}` },
					error: null,
				}),
			),
			prompt: mock(
				() =>
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error('Prompt rejected')), 20),
					),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, rejectPromptOps);

		LeanTurboRunner._internals.laneDispatchTimeoutMs = 5;

		// Fire all dispatches concurrently
		const results = await Promise.all(
			lanes.map((lane) => runner.dispatchLane(lane, 'mega_coder')),
		);

		// All should timeout (timeout fires at 5ms, prompt rejects at 20ms)
		for (const result of results) {
			expect(result.ok).toBe(false);
			expect(result.error).toContain('timed out');
		}

		// Wait for background completions to clean up _timedOutLanes
		// prompt rejects at 20ms, so by 100ms everything should be settled
		await Bun.sleep(100);

		// _timedOutLanes should be empty after all completions
		const timedOutLanes = (
			runner as unknown as { _timedOutLanes: Map<string, string> }
		)._timedOutLanes;
		expect(timedOutLanes.size).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T7: _timedOutLanes Map entry not cleaned after non-timeout error
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T7 — _timedOutLanes cleanup after non-timeout rejection', () => {
	test('_timedOutLanes entry is deleted when _doDispatch rejects with non-timeout error', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// create succeeds but prompt fails with non-timeout error
		const sessionId = `session-reject-${Math.random().toString(36).slice(2)}`;
		const rejectOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: sessionId },
					error: null,
				}),
			),
			prompt: mock(() => Promise.reject(new Error('Network partition'))),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, rejectOps);

		// Set a timeout (but non-timeout error will occur)
		LeanTurboRunner._internals.laneDispatchTimeoutMs = 100;

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		// Get reference to _timedOutLanes before dispatch
		const timedOutLanes = runner as unknown as {
			_timedOutLanes: Map<string, string>;
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// Wait for any background handlers
		await Bun.sleep(200);

		// Dispatch should fail with the rejection error
		expect(result.ok).toBe(false);
		expect(result.error).toBe('Network partition');

		// _timedOutLanes entry should be cleaned up
		expect(timedOutLanes._timedOutLanes.size).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T8: Very large session ID handling
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T8 — very large session ID handling', () => {
	test('dispatchLane handles extremely long session IDs without crashing', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const longSessionId = 'x'.repeat(10000);
		const longIdOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: longSessionId },
					error: null,
				}),
			),
			prompt: mock(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, longIdOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		// Should handle long session ID without crashing
		expect(typeof result.ok).toBe('boolean');
		expect(result.sessionId).toBe(longSessionId);
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR T9: Abort-before-delete ordering invariant
// Verifies that promptController.abort() fires before session.delete() on every
// exit path to prevent SQLiteError: FOREIGN KEY constraint failed.
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR T9 — abort-before-delete ordering invariant', () => {
	test('signal is aborted before delete when prompt returns null data (no-timeout production path)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		let capturedSignal: AbortSignal | undefined;
		let signalAbortedAtDelete = false;

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'session-ord-1' }, error: null }),
			),
			prompt: mock((args: { signal?: AbortSignal }) => {
				capturedSignal = args.signal;
				return Promise.resolve({ data: null, error: 'prompt failed' });
			}),
			delete: mock(() => {
				signalAbortedAtDelete = capturedSignal?.aborted ?? false;
				return Promise.resolve();
			}),
		} as unknown as MockSessionOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		expect(result.ok).toBe(false);
		expect(signalAbortedAtDelete).toBe(true);
	});

	test('signal is aborted before delete when prompt throws (no-timeout production path)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		let capturedSignal: AbortSignal | undefined;
		let signalAbortedAtDelete = false;

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'session-ord-2' }, error: null }),
			),
			prompt: mock((args: { signal?: AbortSignal }) => {
				capturedSignal = args.signal;
				return Promise.reject(new Error('mid-stream network failure'));
			}),
			delete: mock(() => {
				signalAbortedAtDelete = capturedSignal?.aborted ?? false;
				return Promise.resolve();
			}),
		} as unknown as MockSessionOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');

		expect(result.ok).toBe(false);
		expect(signalAbortedAtDelete).toBe(true);
	});

	test('signal is aborted before delete when timeout fires mid-prompt', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		let capturedSignal: AbortSignal | undefined;
		let signalAbortedAtDelete = false;

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, {
			create: mock(() =>
				Promise.resolve({ data: { id: 'session-ord-3' }, error: null }),
			),
			prompt: mock((args: { signal?: AbortSignal }) => {
				capturedSignal = args.signal;
				return Bun.sleep(200).then(() =>
					Promise.resolve({
						data: { parts: [{ type: 'text', text: 'Done' }] },
						error: null,
					}),
				);
			}),
			delete: mock(() => {
				signalAbortedAtDelete = capturedSignal?.aborted ?? false;
				return Promise.resolve();
			}),
		} as unknown as MockSessionOps);

		LeanTurboRunner._internals.laneDispatchTimeoutMs = 30;

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'mega_coder');
		await Bun.sleep(300);

		expect(result.ok).toBe(false);
		expect(result.error).toContain('timed out');
		expect(signalAbortedAtDelete).toBe(true);
	});
});
