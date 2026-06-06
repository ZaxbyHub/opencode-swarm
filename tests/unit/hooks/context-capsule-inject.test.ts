/**
 * Tests for context-capsule-inject hook
 *
 * Uses the _internals DI seam pattern. No mock.module usage.
 * All _internals are overridden per-test and restored in afterEach.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	createContextCapsuleInjectHook,
} from '../../../src/hooks/context-capsule-inject.js';
import type {
	AgentRole,
	CapsuleDelegationReason,
} from '../../../src/types/context-capsule.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config with context_map enabled */
function makeEnabledConfig() {
	return {
		context_map: { enabled: true },
	} as Parameters<typeof createContextCapsuleInjectHook>[0];
}

/** Hook factory shortcut */
function makeHook(cfg = makeEnabledConfig(), dir = '/fake/dir') {
	return createContextCapsuleInjectHook(cfg, dir);
}

// ---------------------------------------------------------------------------
// DI seam overrides — stored per-test so we can restore
// ---------------------------------------------------------------------------

const savedInternals = { ..._internals };

function restoreInternals() {
	Object.assign(_internals, savedInternals);
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-1';

const CAPSULE_CONTENT = '[Context Capsule] File summaries and read policies.';

const mockCapsuleResult = {
	capsule: {
		content: CAPSULE_CONTENT,
		delegation_reason: 'new_task' as CapsuleDelegationReason,
	},
	metadata: {
		token_estimate: 42,
		cache_hits: 0,
		cache_misses: 1,
		stale_entries: 0,
		recommended_reads: ['src/foo.ts'],
		skipped_reads: [],
		success: true,
	},
};

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
	restoreInternals();
});

afterEach(() => {
	restoreInternals();
});

// ---------------------------------------------------------------------------
// 1. Factory behavior
// ---------------------------------------------------------------------------

describe('Factory behavior', () => {
	test('returns {} when config.context_map.enabled is false', () => {
		const hook = createContextCapsuleInjectHook(
			{ context_map: { enabled: false } } as Parameters<
				typeof createContextCapsuleInjectHook
			>[0],
			'/dir',
		);
		expect(hook).toEqual({});
	});

	test('returns {} when config.context_map is undefined', () => {
		const hook = createContextCapsuleInjectHook(
			{} as Parameters<typeof createContextCapsuleInjectHook>[0],
			'/dir',
		);
		expect(hook).toEqual({});
	});

	test('returns {} when config.context_map.enabled is undefined', () => {
		const hook = createContextCapsuleInjectHook(
			{ context_map: {} } as Parameters<
				typeof createContextCapsuleInjectHook
			>[0],
			'/dir',
		);
		expect(hook).toEqual({});
	});

	test('returns object with experimental.chat.system.transform key when enabled', () => {
		const hook = makeHook();
		expect(Object.keys(hook)).toContain('experimental.chat.system.transform');
		expect(typeof hook['experimental.chat.system.transform']).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// 2. Hook injection — skip conditions
// ---------------------------------------------------------------------------

describe('Hook injection — skip conditions', () => {
	test('skips when sessionID is missing', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['original message'] };
		await transform({ sessionID: undefined }, output);

		// buildCapsule must NOT have been called
		expect(_internals.buildCapsule).not.toHaveBeenCalled();
		expect(output.system).toEqual(['original message']);
	});

	test('skips when getActiveAgent returns undefined', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => undefined);
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['original message'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.buildCapsule).not.toHaveBeenCalled();
		expect(output.system).toEqual(['original message']);
	});

	test('skips when agent is architect', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'architect');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['original message'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.buildCapsule).not.toHaveBeenCalled();
		expect(output.system).toEqual(['original message']);
	});

	test('skips for OpenCode native agents (build, plan, general, explore, compaction, title, summary)', async () => {
		const nativeAgents = [
			'build',
			'plan',
			'general',
			'explore',
			'compaction',
			'title',
			'summary',
		] as const;

		for (const agent of nativeAgents) {
			_internals.buildCapsule = mock(() => mockCapsuleResult);
			_internals.getActiveAgent = mock(() => agent);
			_internals.getCurrentTaskId = mock(() => 'task-1');
			_internals.readScopeFile = mock(() => ['src/foo.ts']);
			_internals.recordTelemetry = mock(() => {});
			_internals.saveCapsule = mock(() => {});

			const hook = makeHook();
			const transform = hook['experimental.chat.system.transform'] as (
				input: { sessionID?: string },
				output: { system: string[] },
			) => Promise<void>;

			const output = { system: ['original message'] };
			await transform({ sessionID: SESSION_ID }, output);

			expect(_internals.buildCapsule).not.toHaveBeenCalled();
			expect(output.system).toEqual(['original message']);
		}
	});

	test('skips for unrecognized roles (e.g., mega_explorer)', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_explorer');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['original message'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.buildCapsule).not.toHaveBeenCalled();
		expect(output.system).toEqual(['original message']);
	});

	test('injects capsule.content into output.system when all conditions met', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['original message'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.buildCapsule).toHaveBeenCalledTimes(1);
		expect(output.system).toEqual(['original message', CAPSULE_CONTENT]);
	});

	test('records telemetry after successful injection', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['original message'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.recordTelemetry).toHaveBeenCalledTimes(1);
		const [entry] = (_internals.recordTelemetry as ReturnType<typeof mock>).mock
			.calls[0] as Parameters<typeof _internals.recordTelemetry>;
		expect(entry.task_id).toBe('task-1');
		expect(entry.agent_role).toBe('coder');
	});
});

// ---------------------------------------------------------------------------
// 3. Role extraction
// ---------------------------------------------------------------------------

describe('Role extraction', () => {
	type RoleTest = { input: string; expected: string | undefined };

	const cases: RoleTest[] = [
		{ input: 'mega_coder', expected: 'coder' },
		{ input: 'mega_reviewer', expected: 'reviewer' },
		{ input: 'mega_test_engineer', expected: 'test_engineer' },
		{ input: 'mega_critic', expected: 'critic' },
		{ input: 'mega_sme', expected: 'sme' },
		{ input: 'coder', expected: 'coder' },
		{ input: 'architect', expected: undefined },
		{ input: 'mega_explorer', expected: undefined },
		{ input: 'build', expected: undefined },
	];

	for (const { input, expected } of cases) {
		test(`"${input}" → ${expected === undefined ? 'skip (undefined)' : `"${expected}"`}`, async () => {
			_internals.buildCapsule = mock(() => mockCapsuleResult);
			_internals.getActiveAgent = mock(() => input);
			_internals.getCurrentTaskId = mock(() => 'task-1');
			_internals.readScopeFile = mock(() => ['src/foo.ts']);
			_internals.recordTelemetry = mock(() => {});
			_internals.saveCapsule = mock(() => {});

			const hook = makeHook();
			const transform = hook['experimental.chat.system.transform'] as (
				input: { sessionID?: string },
				output: { system: string[] },
			) => Promise<void>;

			const output = { system: ['original'] };
			await transform({ sessionID: SESSION_ID }, output);

			if (expected === undefined) {
				expect(_internals.buildCapsule).not.toHaveBeenCalled();
				expect(output.system).toEqual(['original']);
			} else {
				expect(_internals.buildCapsule).toHaveBeenCalledTimes(1);
				expect(output.system).toContain(CAPSULE_CONTENT);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// 4. _internals DI seam
// ---------------------------------------------------------------------------

describe('_internals DI seam', () => {
	test('all expected functions are present', () => {
		expect(typeof _internals.buildCapsule).toBe('function');
		expect(typeof _internals.recordTelemetry).toBe('function');
		expect(typeof _internals.getActiveAgent).toBe('function');
		expect(typeof _internals.getCurrentTaskId).toBe('function');
		expect(typeof _internals.readScopeFile).toBe('function');
		expect(typeof _internals.saveCapsule).toBe('function');
		expect(typeof _internals.getSession).toBe('function');
		expect(typeof _internals.resolveCapsuleDelegationReason).toBe('function');
		expect(typeof _internals.extractTaskGoal).toBe('function');
	});

	test('override works for all _internals functions', async () => {
		// Override all internals with mocks
		const mockBuildCapsule = mock(() => ({
			capsule: {
				content: 'custom capsule',
				delegation_reason: 'new_task' as CapsuleDelegationReason,
			},
			metadata: {
				token_estimate: 1,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
				success: true,
			},
		}));
		const mockRecordTelemetry = mock(() => {});
		const mockGetActiveAgent = mock(() => 'mega_reviewer');
		const mockGetCurrentTaskId = mock(() => 'custom-task');
		const mockReadScopeFile = mock(() => ['overridden.ts']);
		const mockSaveCapsule = mock(() => {});
		const mockGetSession = mock(() => undefined);
		const mockResolveDelegationReason = mock(
			() => 'new_task' as CapsuleDelegationReason,
		);
		const mockExtractTaskGoal = mock(() => 'Test task goal');

		_internals.buildCapsule = mockBuildCapsule;
		_internals.recordTelemetry = mockRecordTelemetry;
		_internals.getActiveAgent = mockGetActiveAgent;
		_internals.getCurrentTaskId = mockGetCurrentTaskId;
		_internals.readScopeFile = mockReadScopeFile;
		_internals.saveCapsule = mockSaveCapsule;
		_internals.getSession = mockGetSession;
		_internals.resolveCapsuleDelegationReason = mockResolveDelegationReason;
		_internals.extractTaskGoal = mockExtractTaskGoal;

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		// All mocks were called
		expect(mockBuildCapsule).toHaveBeenCalledTimes(1);
		expect(mockRecordTelemetry).toHaveBeenCalledTimes(1);
		expect(mockGetActiveAgent).toHaveBeenCalledTimes(1);
		expect(mockGetCurrentTaskId).toHaveBeenCalledTimes(1);
		expect(mockReadScopeFile).toHaveBeenCalledTimes(1);
		expect(mockSaveCapsule).toHaveBeenCalledTimes(1);
		expect(mockGetSession).toHaveBeenCalledTimes(1);
		expect(mockResolveDelegationReason).toHaveBeenCalledTimes(1);
		expect(mockExtractTaskGoal).toHaveBeenCalledTimes(1);

		// Capsule content used
		expect(output.system).toContain('custom capsule');
	});

	test('override is restored after test via afterEach', async () => {
		// This test runs after the previous one — verifies savedInternals snapshot works
		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		// After restore, real getActiveAgent returns undefined → hook skips
		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		// Real readScopeFile returns [] so no injection
		expect(output.system).toEqual(['msg']);
	});
});

// ---------------------------------------------------------------------------
// 5. Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases — hook never throws', () => {
	test('hook never throws when buildCapsule throws', async () => {
		_internals.buildCapsule = mock(() => {
			throw new Error('buildCapsule exploded');
		});
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		// Must NOT throw
		await expect(
			transform({ sessionID: SESSION_ID }, output),
		).resolves.toBeUndefined();

		// Original message unchanged
		expect(output.system).toEqual(['msg']);
	});

	test('hook never throws when recordTelemetry throws', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {
			throw new Error('telemetry exploded');
		});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		// Must NOT throw even though telemetry failed
		await expect(
			transform({ sessionID: SESSION_ID }, output),
		).resolves.toBeUndefined();

		// Capsule still injected
		expect(output.system).toEqual(['msg', CAPSULE_CONTENT]);
	});

	test('empty scope files → no injection', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => []);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.buildCapsule).not.toHaveBeenCalled();
		expect(output.system).toEqual(['msg']);
	});

	test('empty capsule content → no injection', async () => {
		_internals.buildCapsule = mock(() => ({
			capsule: {
				content: '   \n\t  ',
				delegation_reason: 'new_task' as CapsuleDelegationReason,
			},
			metadata: {
				token_estimate: 0,
				cache_hits: 0,
				cache_misses: 0,
				stale_entries: 0,
				recommended_reads: [],
				skipped_reads: [],
				success: true,
			},
		}));
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		// buildCapsule was called (to check content), but output unchanged
		expect(_internals.buildCapsule).toHaveBeenCalledTimes(1);
		expect(output.system).toEqual(['msg']);
	});
});

// ---------------------------------------------------------------------------
// 6. resolveCapsuleDelegationReason — unit tests
// ---------------------------------------------------------------------------

describe('resolveCapsuleDelegationReason', () => {
	test('critic role → critic_plan_review regardless of workflow state', () => {
		const criticSession = {
			currentTaskId: 'task-1',
			taskWorkflowStates: new Map([['task-1', 'tests_run']]),
		};

		// Override getSession so the hook uses our session
		_internals.getSession = mock(() => criticSession);

		const reason = _internals.resolveCapsuleDelegationReason(
			criticSession,
			'critic',
			'task-1',
		);
		expect(reason).toBe('critic_plan_review');
	});

	test('workflowState reviewer_run → reviewer_rejection_fix', () => {
		const session = {
			currentTaskId: 'task-1',
			taskWorkflowStates: new Map([['task-1', 'reviewer_run']]),
		};

		_internals.getSession = mock(() => session);

		const reason = _internals.resolveCapsuleDelegationReason(
			session,
			'coder',
			'task-1',
		);
		expect(reason).toBe('reviewer_rejection_fix');
	});

	test('workflowState tests_run → test_failure_fix', () => {
		const session = {
			currentTaskId: 'task-1',
			taskWorkflowStates: new Map([['task-1', 'tests_run']]),
		};

		_internals.getSession = mock(() => session);

		const reason = _internals.resolveCapsuleDelegationReason(
			session,
			'coder',
			'task-1',
		);
		expect(reason).toBe('test_failure_fix');
	});

	test('idle / coder_delegated / pre_check_passed → new_task', () => {
		const states: Array<'idle' | 'coder_delegated' | 'pre_check_passed'> = [
			'idle',
			'coder_delegated',
			'pre_check_passed',
		];

		for (const state of states) {
			const session = {
				currentTaskId: 'task-1',
				taskWorkflowStates: new Map([['task-1', state]]),
			};

			_internals.getSession = mock(() => session);

			const reason = _internals.resolveCapsuleDelegationReason(
				session,
				'coder',
				'task-1',
			);
			expect(reason).toBe('new_task');
		}
	});

	test('undefined session → new_task', () => {
		_internals.getSession = mock(() => undefined);

		const reason = _internals.resolveCapsuleDelegationReason(
			undefined,
			'coder',
			'task-1',
		);
		expect(reason).toBe('new_task');
	});
});

// ---------------------------------------------------------------------------
// 7. extractTaskGoal — unit tests
// ---------------------------------------------------------------------------

describe('extractTaskGoal', () => {
	test('reads plan.json and returns correct task description from real filesystem', () => {
		const prefix = path.join(os.tmpdir(), 'capsule-test-');
		const tempDir = fs.realpathSync(fs.mkdtempSync(prefix));

		try {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });

			const plan = {
				phases: [
					{
						tasks: [
							{
								id: '1.2',
								description: 'Build the context map service layer',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(plan, null, 2),
				'utf-8',
			);

			const result = _internals.extractTaskGoal('1.2', tempDir);
			expect(result).toBe('Build the context map service layer');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('extractTaskGoal returns empty string for unknown task ID — via hook integration', async () => {
		// When task ID doesn't match any task in plan.json, task_goal should be ''
		_internals.buildCapsule = mock(() => ({
			capsule: {
				content: CAPSULE_CONTENT,
				delegation_reason: 'new_task' as CapsuleDelegationReason,
			},
			metadata: {
				token_estimate: 42,
				cache_hits: 0,
				cache_misses: 1,
				stale_entries: 0,
				recommended_reads: ['src/foo.ts'],
				skipped_reads: [],
				success: true,
			},
		}));
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'unknown-task');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		// Override extractTaskGoal to simulate task not found
		_internals.extractTaskGoal = mock(() => '');

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.extractTaskGoal).toHaveBeenCalledWith(
			'unknown-task',
			'/fake/dir',
		);
		// buildCapsule was called with task_goal = ''
		const [capsuleInput] = (_internals.buildCapsule as ReturnType<typeof mock>)
			.mock.calls[0] as Parameters<typeof _internals.buildCapsule>;
		expect(capsuleInput.task_goal).toBe('');
	});

	test('extractTaskGoal returns description when task found — via hook integration', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		// Override extractTaskGoal to simulate found task
		_internals.extractTaskGoal = mock(() => 'Implement the foo feature');

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.extractTaskGoal).toHaveBeenCalledWith(
			'task-1',
			'/fake/dir',
		);
		const [capsuleInput] = (_internals.buildCapsule as ReturnType<typeof mock>)
			.mock.calls[0] as Parameters<typeof _internals.buildCapsule>;
		expect(capsuleInput.task_goal).toBe('Implement the foo feature');
	});

	describe('extractTaskGoal — real filesystem (no mocking)', () => {
		let tempDir: string;

		beforeEach(() => {
			const prefix = path.join(os.tmpdir(), 'capsule-extract-');
			tempDir = fs.realpathSync(fs.mkdtempSync(prefix));
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		test('returns task description when task ID matches a plan task', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });

			const plan = {
				phases: [
					{
						tasks: [{ id: '3.1', description: 'Refactor the capsule builder' }],
					},
				],
			};
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(plan, null, 2),
				'utf-8',
			);

			expect(_internals.extractTaskGoal('3.1', tempDir)).toBe(
				'Refactor the capsule builder',
			);
		});

		test('returns empty string when task ID does not match any plan task', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });

			const plan = {
				phases: [
					{
						tasks: [{ id: '1.1', description: 'Create the data model' }],
					},
				],
			};
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(plan, null, 2),
				'utf-8',
			);

			expect(_internals.extractTaskGoal('9.9', tempDir)).toBe('');
		});

		test('returns empty string when plan.json is missing', () => {
			expect(_internals.extractTaskGoal('1.1', tempDir)).toBe('');
		});

		test('returns empty string when plan.json has no phases array', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({ other: 'data' }),
				'utf-8',
			);

			expect(_internals.extractTaskGoal('1.1', tempDir)).toBe('');
		});

		test('searches across multiple phases for the matching task', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });

			const plan = {
				phases: [
					{ tasks: [{ id: '1.1', description: 'Phase one task' }] },
					{ tasks: [{ id: '2.1', description: 'Phase two task' }] },
					{ tasks: [{ id: '3.1', description: 'Phase three task' }] },
				],
			};
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(plan, null, 2),
				'utf-8',
			);

			expect(_internals.extractTaskGoal('1.1', tempDir)).toBe('Phase one task');
			expect(_internals.extractTaskGoal('2.1', tempDir)).toBe('Phase two task');
			expect(_internals.extractTaskGoal('3.1', tempDir)).toBe(
				'Phase three task',
			);
			expect(_internals.extractTaskGoal('4.1', tempDir)).toBe('');
		});
	});
});

// ---------------------------------------------------------------------------
// 8. saveCapsule integration
// ---------------------------------------------------------------------------

describe('saveCapsule integration', () => {
	test('saveCapsule is called with capsule and directory after injection', async () => {
		const mockSaveCapsule = mock(() => {});
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mockSaveCapsule;

		const customDir = '/custom/dir';
		const hook = makeHook(makeEnabledConfig(), customDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(mockSaveCapsule).toHaveBeenCalledTimes(1);
		const [capsuleArg, directoryArg] = mockSaveCapsule.mock.calls[0];
		expect(capsuleArg.content).toBe(CAPSULE_CONTENT);
		expect(directoryArg).toBe(customDir);
	});

	test('saveCapsule failure does NOT break the hook', async () => {
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {
			throw new Error('saveCapsule exploded');
		});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		// Must NOT throw
		await expect(
			transform({ sessionID: SESSION_ID }, output),
		).resolves.toBeUndefined();

		// Capsule still injected
		expect(output.system).toEqual(['msg', CAPSULE_CONTENT]);
	});
});

// ---------------------------------------------------------------------------
// 9. Telemetry delegation_reason
// ---------------------------------------------------------------------------

describe('Telemetry delegation_reason', () => {
	test('telemetry uses capsule.delegation_reason, not hardcoded value', async () => {
		const capsuleWithReason = {
			capsule: {
				content: CAPSULE_CONTENT,
				delegation_reason: 'test_failure_fix' as CapsuleDelegationReason,
			},
			metadata: {
				token_estimate: 42,
				cache_hits: 0,
				cache_misses: 1,
				stale_entries: 0,
				recommended_reads: ['src/foo.ts'],
				skipped_reads: [],
				success: true,
			},
		};

		_internals.buildCapsule = mock(() => capsuleWithReason);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		expect(_internals.recordTelemetry).toHaveBeenCalledTimes(1);
		const [entry] = (_internals.recordTelemetry as ReturnType<typeof mock>).mock
			.calls[0] as Parameters<typeof _internals.recordTelemetry>;
		// The delegation_reason in telemetry should match capsule.delegation_reason
		expect(entry.delegation_reason).toBe('test_failure_fix');
		// Not the default 'new_task'
		expect(entry.delegation_reason).not.toBe('new_task');
	});
});

// ---------------------------------------------------------------------------
// 10. getSession DI seam
// ---------------------------------------------------------------------------

describe('getSession DI seam', () => {
	test('getSession is called by injectCapsule with the sessionID', async () => {
		// Mock getSession to return a fake session with reviewer_run workflow state.
		// We also mock resolveCapsuleDelegationReason directly to isolate the
		// getSession wiring test from the real delegation reason logic.
		const fakeSession = {
			currentTaskId: 'task-1',
			taskWorkflowStates: new Map([['task-1', 'reviewer_run']]),
		};

		_internals.getSession = mock(() => fakeSession);
		_internals.resolveCapsuleDelegationReason = mock(
			() => 'reviewer_rejection_fix' as CapsuleDelegationReason,
		);
		_internals.buildCapsule = mock(() => mockCapsuleResult);
		_internals.getActiveAgent = mock(() => 'mega_coder');
		_internals.getCurrentTaskId = mock(() => 'task-1');
		_internals.readScopeFile = mock(() => ['src/foo.ts']);
		_internals.recordTelemetry = mock(() => {});
		_internals.saveCapsule = mock(() => {});
		_internals.extractTaskGoal = mock(() => '');

		const hook = makeHook();
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string },
			output: { system: string[] },
		) => Promise<void>;

		const output = { system: ['msg'] };
		await transform({ sessionID: SESSION_ID }, output);

		// getSession was called with the sessionID
		expect(_internals.getSession).toHaveBeenCalledWith(SESSION_ID);
	});

	test('getSession returns session so resolveCapsuleDelegationReason can use workflow state', () => {
		// Direct unit test: verify that when getSession returns a session with
		// taskWorkflowStates, resolveCapsuleDelegationReason uses it correctly.
		const fakeSession = {
			currentTaskId: 'task-1',
			taskWorkflowStates: new Map([['task-1', 'reviewer_run']]),
		};

		_internals.getSession = mock(() => fakeSession);

		const reason = _internals.resolveCapsuleDelegationReason(
			_internals.getSession(SESSION_ID)!,
			'coder',
			'task-1',
		);
		expect(reason).toBe('reviewer_rejection_fix');
	});
});
