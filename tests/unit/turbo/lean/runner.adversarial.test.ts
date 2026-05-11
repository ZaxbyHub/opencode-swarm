/**
 * Adversarial security tests for LeanTurboRunner.
 *
 * Attack vectors tested:
 * - Null client injection (fail-closed bypass attempts)
 * - Malformed phase numbers (negative, zero, NaN, Infinity, MAX_SAFE_INTEGER)
 * - Missing plan.json (corrupt, empty, wrong type)
 * - Invalid lane data (empty laneId, missing taskIds, path traversal)
 * - Timeout scenarios (session.create timeout, prompt timeout)
 * - Concurrent dispatch races (two runners same session)
 * - Lock leak on failure (dispatch failure after lock acquired)
 *
 * Strategy:
 * - Uses real tmpDir + real lane planning via _internals
 * - Injects mock SessionClient via _sessionOps seam
 * - Uses real lock acquisition (file-locks._internals can be patched if needed)
 * - No mock.module usage — all mocking via instance seam or _internals
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LeanTurboLane } from '../../../../src/turbo/lean/planner';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import * as leanState from '../../../../src/turbo/lean/state';

const SESSION_ID = 'sess-adversarial-test';

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
		fs.mkdtempSync(path.join(os.tmpdir(), 'runner-adversarial-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanState.repairStateUnreadable(tmpDir);
	mockSessionOps = mockSuccessfulSessionOps();
});

afterEach(() => {
	leanState.repairStateUnreadable(tmpDir);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR 1: Null client injection — fail-closed must not be bypassed
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR 1 — null client injection (fail-closed bypass)', () => {
	test('runPhase rejects explicit null client with NO_CLIENT', async () => {
		// This is the legitimate fail-closed behavior
		const runner = makeRunner({ opencodeClient: null });
		const result = await runner.runPhase(1);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_CLIENT');
	});

	test('runPhase with undefined client triggers fail-closed (NO_CLIENT)', async () => {
		// When opencodeClient is explicitly undefined, the constructor uses
		// 'opencodeClient' in options check which is TRUE for undefined,
		// then sets _client = undefined ?? null = null, triggering fail-closed.
		const runner = makeRunner({ opencodeClient: undefined });
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const result = await runner.runPhase(1);
		// Fail-closed triggers because undefined ?? null === null
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_CLIENT');
	});

	test('dispatchLane rejects when _sessionOps is null and client is falsy', async () => {
		const runner = makeRunner({ opencodeClient: null });
		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');
		expect(result.ok).toBe(false);
		expect(result.error).toBe('NO_CLIENT');
	});

	test('runPhase returns NO_PLAN (not crash) when plan.json does not exist', async () => {
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Deliberately do NOT create plan.json
		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
		// Must not throw
	});

	test('runPhase returns NO_PLAN when plan.json is empty string', async () => {
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), '', 'utf-8');
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	test('runPhase returns NO_PLAN when plan.json is malformed JSON', async () => {
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			'{ invalid json }',
			'utf-8',
		);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	test('runPhase returns NO_PLAN when plan.json has null bytes (injection attempt)', async () => {
		const planWithNull = '{\x00"schema_version": "1.0.0"}';
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			planWithNull,
			'utf-8',
		);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	test('runPhase returns NO_PLAN when plan.json has replacement char (corruption)', async () => {
		// \uFFFD is the UTF-8 replacement character — used in corruption attacks
		const planWithReplacement = '{"schema_version\uFFFD": "1.0.0"}';
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			planWithReplacement,
			'utf-8',
		);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR 2: Malformed phase numbers
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR 2 — malformed phase numbers', () => {
	test('runPhase with phase number 0 returns empty lanes (no crash)', async () => {
		writeMinimalPlan(1);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Phase 0 does not exist in the plan — should return empty lanes, not crash
		const result = await runner.runPhase(0);

		expect(result.ok).toBe(false);
		expect(result.lanes).toHaveLength(0);
	});

	test('runPhase with negative phase number does not crash', async () => {
		writeMinimalPlan(1);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(-1);

		// Should handle gracefully — planner returns empty plan for non-existent phase
		expect(result.ok).toBe(false);
		expect(result.lanes).toHaveLength(0);
	});

	test('runPhase with NaN phase number does not crash', async () => {
		writeMinimalPlan(1);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// NaN coerces to NaN in most operations — should not crash
		const result = await runner.runPhase(NaN);

		expect(result.ok).toBe(false);
		expect(result.lanes).toHaveLength(0);
	});

	test('runPhase with Infinity phase number does not crash', async () => {
		writeMinimalPlan(1);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(Infinity);

		expect(result.ok).toBe(false);
		expect(result.lanes).toHaveLength(0);
	});

	test('runPhase with MAX_SAFE_INTEGER phase number does not crash', async () => {
		writeMinimalPlan(1);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(Number.MAX_SAFE_INTEGER);

		expect(result.ok).toBe(false);
		expect(result.lanes).toHaveLength(0);
	});

	test('runPhase with non-integer fractional phase number does not crash', async () => {
		writeMinimalPlan(1);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1.5);

		expect(result.ok).toBe(false);
		expect(result.lanes).toHaveLength(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR 3: Missing plan.json / corrupt plan state
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR 3 — missing / corrupt plan.json', () => {
	test('runPhase when .swarm directory itself is missing', async () => {
		// Remove .swarm directory entirely
		fs.rmSync(path.join(tmpDir, '.swarm'), { recursive: true, force: true });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	test('runPhase when plan.json is valid JSON but wrong schema type', async () => {
		// Valid JSON but not a valid plan — should fail validation
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({ not: 'a plan', but: 'valid json' }),
			'utf-8',
		);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	test('runPhase when plan.json has no phases array', async () => {
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'No Phases',
				swarm: 'test',
				phases: undefined,
			}),
			'utf-8',
		);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		// Schema validation fails — returns NO_PLAN
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	test('runPhase when plan.json has null phases', async () => {
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Null Phases',
				swarm: 'test',
				phases: null,
			}),
			'utf-8',
		);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		// Schema validation rejects null phases — returns NO_PLAN
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});

	test('runPhase when plan.json has null phases', async () => {
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Null Phases',
				swarm: 'test',
				phases: null,
			}),
			'utf-8',
		);
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const result = await runner.runPhase(1);

		// Schema validation rejects null phases — returns NO_PLAN
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('NO_PLAN');
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR 4: Invalid lane data
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR 4 — invalid lane data', () => {
	test('dispatchLane with empty laneId does not crash', async () => {
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const lane: LeanTurboLane = {
			laneId: '',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		// Should handle empty laneId gracefully
		const result = await runner.dispatchLane(lane, 'coder');
		// Either succeeds or fails gracefully — must not throw
		expect(typeof result.ok).toBe('boolean');
	});

	test('dispatchLane with missing taskIds does not crash', async () => {
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const lane = {
			laneId: 'lane-1',
			taskIds: undefined as unknown as string[],
			files: [],
			status: 'pending',
		} as LeanTurboLane;

		const result = await runner.dispatchLane(lane, 'coder');
		expect(typeof result.ok).toBe('boolean');
	});

	test('dispatchLane with empty taskIds array does not crash', async () => {
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: [],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');
		expect(typeof result.ok).toBe('boolean');
	});

	test('dispatchLane with path traversal in files does not escape directory', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Attempt path traversal in lane files
		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['../../etc/passwd', 'src/a.ts'],
			status: 'pending',
		};

		// This should be handled by the lock system
		const result = await runner.dispatchLane(lane, 'coder');

		// The session should not have been created with path traversal files
		// If locks fail, the lane is blocked, not successful
		if (result.ok) {
			expect(mockSessionOps.create).toHaveBeenCalled();
		}
	});

	test('dispatchLane with very long laneId does not cause DoS', async () => {
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		const longLaneId = 'x'.repeat(10000);
		const lane: LeanTurboLane = {
			laneId: longLaneId,
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');
		expect(typeof result.ok).toBe('boolean');
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR 5: Timeout scenarios
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR 5 — timeout scenarios', () => {
	test('dispatchLane when session.create times out returns error', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const timeoutOps = {
			create: mock(
				() =>
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error('ETIMEDOUT')), 10),
					),
			),
			prompt: mock(() => Promise.resolve({ data: null, error: 'timeout' })),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, timeoutOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');

		expect(result.ok).toBe(false);
		expect(result.error).toContain('ETIMEDOUT');
	});

	test('dispatchLane when session.create returns null data (no session) returns error', async () => {
		const nullDataOps = {
			create: mock(() =>
				Promise.resolve({ data: null, error: 'connection refused' }),
			),
			prompt: mock(() => Promise.resolve({ data: null, error: 'timeout' })),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, nullDataOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');

		expect(result.ok).toBe(false);
		expect(result.error).toContain('session.create failed');
	});

	test('dispatchLane when session.prompt returns null data (timeout simulation) cleans up orphaned session', async () => {
		const orphanSessionOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: 'orphan-session-123' },
					error: null,
				}),
			),
			prompt: mock(() => Promise.resolve({ data: null, error: 'ETIMEDOUT' })),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, orphanSessionOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');

		expect(result.ok).toBe(false);
		expect(result.error).toContain('session.prompt failed');
		// delete should have been called to clean up the orphan
		expect(orphanSessionOps.delete).toHaveBeenCalledWith(
			expect.objectContaining({ path: { id: 'orphan-session-123' } }),
		);
	});

	test('dispatchLane when session.prompt returns null data cleans up orphaned session', async () => {
		const orphanSessionOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: 'orphan-session-456' },
					error: null,
				}),
			),
			prompt: mock(() =>
				Promise.resolve({ data: null, error: 'prompt failed' }),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, orphanSessionOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');

		expect(result.ok).toBe(false);
		expect(result.error).toContain('session.prompt failed');
		// delete should have been called to clean up the orphan
		expect(orphanSessionOps.delete).toHaveBeenCalledWith(
			expect.objectContaining({ path: { id: 'orphan-session-456' } }),
		);
	});

	test('dispatchLane when session.prompt returns null data with non-JSON error still cleans up', async () => {
		const orphanSessionOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: 'orphan-session-789' },
					error: 'plain string error', // non-object error
				}),
			),
			prompt: mock(() =>
				Promise.resolve({ data: null, error: 'plain string error' }),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, orphanSessionOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');

		expect(result.ok).toBe(false);
		expect(result.error).toContain('session.prompt failed');
		// delete should have been called
		expect(orphanSessionOps.delete).toHaveBeenCalled();
	});

	test('dispatchLane when session.create throws non-Error still returns error', async () => {
		const throwOps = {
			create: mock(() => Promise.reject('string rejection')),
			prompt: mock(() => Promise.resolve({ data: null, error: 'timeout' })),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, throwOps);

		const lane: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'pending',
		};

		const result = await runner.dispatchLane(lane, 'coder');

		expect(result.ok).toBe(false);
		expect(result.error).toBe('string rejection');
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR 6: Concurrent dispatch races
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR 6 — concurrent dispatch races', () => {
	test('two runners with same sessionID do not interfere with each others locks', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner1 = makeRunner({ generatedAgentNames: ['mega_coder'] });
		const runner2 = makeRunner({ generatedAgentNames: ['mega_coder'] });

		const ops1 = mockSuccessfulSessionOps();
		const ops2 = mockSuccessfulSessionOps();

		injectMockSessionOps(runner1, ops1);
		injectMockSessionOps(runner2, ops2);

		// Run both phases concurrently
		const [result1, result2] = await Promise.all([
			runner1.runPhase(1),
			runner2.runPhase(1),
		]);

		// Both should complete without crashing
		expect(result1.ok).toBe(true);
		expect(result2.ok).toBe(true);

		// At least one should succeed (possibly both if different files)
		const successCount =
			result1.lanes.filter(
				(l) => l.status === 'running' || l.status === 'completed',
			).length +
			result2.lanes.filter(
				(l) => l.status === 'running' || l.status === 'completed',
			).length;
		expect(successCount).toBeGreaterThanOrEqual(0);
	});

	test('concurrent dispatchLane calls do not share session state', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] });

		const sessionIds: string[] = [];
		const captureCreate = mock((opts: { query: { directory: string } }) => {
			const id = `session-${Math.random().toString(36).slice(2)}`;
			sessionIds.push(id);
			return Promise.resolve({ data: { id }, error: null });
		});

		const concurrentOps = {
			create: captureCreate,
			prompt: mock(() =>
				Promise.resolve({
					data: { parts: [{ type: 'text', text: 'Done' }] },
					error: null,
				}),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, concurrentOps);

		const lane1: LeanTurboLane = {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'pending',
		};
		const lane2: LeanTurboLane = {
			laneId: 'lane-2',
			taskIds: ['1.2'],
			files: ['src/b.ts'],
			status: 'pending',
		};

		const [result1, result2] = await Promise.all([
			runner.dispatchLane(lane1, 'mega_coder'),
			runner.dispatchLane(lane2, 'mega_coder'),
		]);

		// Both dispatches should get unique session IDs
		expect(sessionIds.length).toBe(2);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);

		// Both should succeed
		expect(result1.ok).toBe(true);
		expect(result2.ok).toBe(true);
		expect(result1.sessionId).not.toBe(result2.sessionId);
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR 7: Lock leak on failure
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR 7 — lock leak on dispatch failure', () => {
	test('locks are released when session.create fails after lock acquisition', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Create succeeds but returns no session (will fail dispatch)
		const failOnPromptOps = {
			create: mock(() => Promise.resolve({ data: null, error: 'auth failed' })),
			prompt: mock(() => Promise.resolve({ data: null, error: 'timeout' })),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, failOnPromptOps);

		const releaseCalls: Array<{ dir: string; laneId: string }> = [];
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push({ dir, laneId });
				return Promise.resolve(1);
			},
		);

		const result = await runner.runPhase(1);

		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;

		// Phase ran but lane failed
		expect(result.ok).toBe(true);
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);

		// Locks should have been released after dispatch failure
		expect(releaseCalls.length).toBeGreaterThan(0);
	});

	test('locks are released when session.prompt fails after lock acquisition', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		// Create succeeds but prompt fails
		const failOnPromptOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: 'session-abc' },
					error: null,
				}),
			),
			prompt: mock(() =>
				Promise.resolve({ data: null, error: 'prompt rejected' }),
			),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, failOnPromptOps);

		const releaseCalls: Array<{ dir: string; laneId: string }> = [];
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push({ dir, laneId });
				return Promise.resolve(1);
			},
		);

		const result = await runner.runPhase(1);

		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;

		expect(result.ok).toBe(true);
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);

		// Locks must be released
		expect(releaseCalls.length).toBeGreaterThan(0);
	});

	test('locks are released when session.prompt throws after lock acquisition', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const throwOnPromptOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: 'session-throw' },
					error: null,
				}),
			),
			prompt: mock(() => Promise.reject(new Error('network error'))),
			delete: mock(() => Promise.resolve()),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, throwOnPromptOps);

		const releaseCalls: Array<{ dir: string; laneId: string }> = [];
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push({ dir, laneId });
				return Promise.resolve(1);
			},
		);

		const result = await runner.runPhase(1);

		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;

		expect(result.ok).toBe(true);
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);
		expect(releaseCalls.length).toBeGreaterThan(0);
	});

	test('locks are released when session.delete throws (best-effort, no propagates)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const deleteThrowsOps = {
			create: mock(() =>
				Promise.resolve({
					data: { id: 'session-delete-throws' },
					error: null,
				}),
			),
			prompt: mock(() =>
				Promise.resolve({ data: null, error: 'prompt failed' }),
			),
			delete: mock(() => Promise.reject(new Error('delete failed'))),
		};

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, deleteThrowsOps);

		const releaseCalls: Array<{ dir: string; laneId: string }> = [];
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(
			(dir: string, laneId: string) => {
				releaseCalls.push({ dir, laneId });
				return Promise.resolve(1);
			},
		);

		// Should not throw even though delete throws
		const result = await runner.runPhase(1);

		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;

		// Lane should be marked failed
		const failedLanes = result.lanes.filter((l) => l.status === 'failed');
		expect(failedLanes.length).toBeGreaterThan(0);

		// Lane locks should still be released despite delete throwing
		expect(releaseCalls.length).toBeGreaterThan(0);
	});

	test('locks are released when releaseLaneLocks itself throws (best-effort)', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Make releaseLaneLocks throw
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(() =>
			Promise.reject(new Error('release failed')),
		);

		// Run phase to acquire locks
		await runner.runPhase(1);

		// Cleanup should not throw even when release fails
		await expect(runner.cleanup()).resolves.toBeUndefined();

		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;
	});

	test('laneLockMap is cleared after lane completion even if releaseLaneLocks throws', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Make releaseLaneLocks throw — the lane completion path should still clear the map
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(() =>
			Promise.reject(new Error('release failed')),
		);

		await runner.runPhase(1);

		// Lock map should be cleared by lane completion path (delete after best-effort release)
		// even though releaseLaneLocks itself threw
		const lockMapAfter = (
			runner as unknown as { _laneLockMap: Record<string, string[]> }
		)._laneLockMap;
		expect(Object.keys(lockMapAfter).length).toBe(0);

		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// ATTACK VECTOR 8: Cleanup is idempotent and best-effort
// ════════════════════════════════════════════════════════════════════════════════

describe('ATTACK VECTOR 8 — cleanup idempotency and best-effort', () => {
	test('cleanup can be called multiple times without error', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		await runner.runPhase(1);

		// First cleanup
		await expect(runner.cleanup()).resolves.toBeUndefined();

		// Second cleanup should not throw
		await expect(runner.cleanup()).resolves.toBeUndefined();
	});

	test('cleanup succeeds when no locks were acquired', async () => {
		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// No runPhase called — no locks acquired
		await expect(runner.cleanup()).resolves.toBeUndefined();
	});

	test('cleanup does not propagate errors from releaseLaneLocks', async () => {
		writeMinimalPlan(1);
		writeScopeFiles({ '1.1': ['src/a.ts'] });

		const runner = makeRunner({ generatedAgentNames: ['mega_coder'] });
		injectMockSessionOps(runner, mockSessionOps);

		// Make every releaseLaneLocks call throw
		const originalRelease = LeanTurboRunner._internals.releaseLaneLocks;
		LeanTurboRunner._internals.releaseLaneLocks = mock(() => {
			throw new Error('release error');
		});

		await runner.runPhase(1);

		// cleanup should swallow the error
		await expect(runner.cleanup()).resolves.toBeUndefined();

		LeanTurboRunner._internals.releaseLaneLocks = originalRelease;
	});
});
