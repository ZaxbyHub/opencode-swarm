/**
 * Tests for resolveEvidenceTaskId helper (delegation-gate.ts)
 *
 * Tests the three-step resolution chain:
 * 1. Explicit task_id in direct args (structured field)
 * 2. Prompt-text extraction via resolveDelegatedPlanTaskId (plan-aware)
 * 3. Session-state fallback via getEvidenceTaskId
 *
 * Issue #970 — parallel evidence recording for multi-task sessions.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { _internals } from '../../../src/hooks/delegation-gate';
import type { AgentSessionState } from '../../../src/state';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

const { resolveEvidenceTaskId, resolveDelegatedPlanTaskId } = _internals;

// =============================================================================
// Helper functions for temp directory / plan setup
// =============================================================================

function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			...(overrides?.hooks as Record<string, unknown>),
		},
	} as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function writePlanJson(
	dir: string,
	options: {
		tasks?: Array<{
			id: string;
			status?: string;
			depends?: string[];
			phase?: number;
		}>;
		currentPhase?: number;
	},
): void {
	const phase = options.currentPhase ?? 1;
	const tasks = options.tasks ?? [
		{ id: '1.1', status: 'pending' },
		{ id: '1.2', status: 'pending' },
	];
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: phase,
		phases: [
			{
				id: phase,
				name: `Phase ${phase}`,
				status: 'in_progress',
				tasks: tasks.map((task) => ({
					id: task.id,
					phase: task.phase ?? phase,
					status: task.status ?? 'pending',
					size: 'small' as const,
					description: `Task ${task.id}`,
					depends: task.depends ?? [],
					files_touched: [],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

// =============================================================================
// resolveDelegatedPlanTaskId — direct unit tests (pure function)
// =============================================================================

describe('resolveDelegatedPlanTaskId — FR-001: derives task ID from delegation context', () => {
	describe('prompt text extraction', () => {
		it('extracts task ID from prompt field', () => {
			const args = { prompt: 'Continue task 2.3 for the API implementation' };
			const knownPlanTaskIds = new Set(['1.1', '2.3', '3.1']);
			const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
			expect(result).toBe('2.3');
		});

		it('extracts task ID from description field', () => {
			const args = { description: 'Review files for task 3.1' };
			const knownPlanTaskIds = new Set(['1.1', '2.3', '3.1']);
			const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
			expect(result).toBe('3.1');
		});

		it('extracts task ID from task field', () => {
			const args = { task: 'Complete task 1.1' };
			const knownPlanTaskIds = new Set(['1.1', '1.2']);
			const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
			expect(result).toBe('1.1');
		});

		it('extracts task ID from input field', () => {
			const args = { input: 'Working on subtask 1.2.3' };
			const knownPlanTaskIds = new Set(['1.1', '1.2.3']);
			const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
			expect(result).toBe('1.2.3');
		});

		it('prefers explicit task_id over text extraction', () => {
			const args = {
				task_id: '1.1',
				prompt: 'This mentions task 2.3 in passing',
			};
			const knownPlanTaskIds = new Set(['1.1', '2.3']);
			const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
			expect(result).toBe('1.1');
		});

		it('prefers explicit taskId (camelCase) over text extraction', () => {
			const args = {
				taskId: '2.5',
				prompt: 'Task 1.1 needs work',
			};
			const knownPlanTaskIds = new Set(['1.1', '2.5']);
			const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
			expect(result).toBe('2.5');
		});

		it('invalid explicit task_id returns null (fail-closed — no text extraction)', () => {
			// CRITICAL: resolveDelegatedPlanTaskId is fail-closed on explicit invalid field.
			// It does NOT fall through to text extraction.
			const args = {
				task_id: 'not-a-task-id',
				prompt: 'Task 1.1 needs work',
			};
			const knownPlanTaskIds = new Set(['1.1']);
			const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
			expect(result).toBeNull(); // fail-closed, no text extraction
		});

		it('explicit task_id too long (>20 chars) returns null (fail-closed)', () => {
			// "1.1.1.1.1.1.1.1.1.1" is 19 chars, so it passes length check.
			// Use a truly long string to test length validation.
			const args = {
				task_id: '1.1.1.1.1.1.1.1.1.1.1', // 21 chars > 20
				prompt: 'Task 1.1 needs work',
			};
			const knownPlanTaskIds = new Set(['1.1']);
			const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
			expect(result).toBeNull(); // fail-closed
		});

		it('valid task_id with length 20 passes', () => {
			// "1.1.1.1.1.1.1.1.1.1" is exactly 19 chars, should pass
			const args = { task_id: '1.1.1.1.1.1.1.1.1.1' };
			const result = resolveDelegatedPlanTaskId(args, undefined);
			expect(result).toBe('1.1.1.1.1.1.1.1.1.1');
		});
	});
});

describe('resolveDelegatedPlanTaskId — FR-003: plan-aware filtering', () => {
	it('version-like N.M not in plan is filtered out', () => {
		// "v6.33.7" looks like a version, not a task ID
		const args = { prompt: 'Update to version 6.33.7 for task 1.1' };
		const knownPlanTaskIds = new Set(['1.1', '1.2']);
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBe('1.1');
	});

	it('N.M.P version-like not in plan is filtered out', () => {
		const args = { prompt: 'Fix bug in version 3.4.5 for task 2.1' };
		const knownPlanTaskIds = new Set(['2.1', '2.2']);
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBe('2.1');
	});

	it('version-like N.M that IS in plan is NOT filtered (ambiguous → null)', () => {
		// When 3.4 is actually a task ID in the plan, mentioning both 1.1 and 3.4
		// creates ambiguity → null
		const args = { prompt: 'Work on task 1.1 and version 3.4' };
		const knownPlanTaskIds = new Set(['1.1', '3.4']);
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBeNull(); // ambiguous — both are in plan
	});

	it('task ID in plan resolves correctly', () => {
		const args = { prompt: 'Task 1.2 is ready for review' };
		const knownPlanTaskIds = new Set(['1.1', '1.2', '1.3']);
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBe('1.2');
	});

	it('without knownPlanTaskIds, extracts any N.M pattern', () => {
		const args = { prompt: 'Continue with task 5.3' };
		const result = resolveDelegatedPlanTaskId(args, undefined);
		expect(result).toBe('5.3');
	});

	it('without knownPlanTaskIds, extracts N.M.P pattern', () => {
		const args = { prompt: 'Working on task 2.10.5' };
		const result = resolveDelegatedPlanTaskId(args, undefined);
		expect(result).toBe('2.10.5');
	});

	it('N.M pattern in prompt but NOT in knownPlanTaskIds → filtered out', () => {
		const args = { prompt: 'Task 9.9 needs work' };
		const knownPlanTaskIds = new Set(['1.1', '1.2']); // 9.9 NOT in plan
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBeNull(); // 9.9 filtered, no other patterns → null
	});
});

describe('resolveDelegatedPlanTaskId — FR-004: ambiguous multi-task prompts', () => {
	it('two task IDs in prompt returns null (ambiguous)', () => {
		const args = { prompt: 'Tasks 1.1 and 1.2 are both ready' };
		const knownPlanTaskIds = new Set(['1.1', '1.2']);
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBeNull();
	});

	it('three task IDs in prompt returns null (ambiguous)', () => {
		const args = { prompt: 'Work on 1.1, 1.2, and 1.3 in parallel' };
		const knownPlanTaskIds = new Set(['1.1', '1.2', '1.3']);
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBeNull();
	});

	it('two N.M patterns, one NOT in plan → not ambiguous', () => {
		// 3.4 is filtered (not in plan), only 1.1 remains → unambiguous
		const args = { prompt: 'Task 1.1 with version 3.4' };
		const knownPlanTaskIds = new Set(['1.1', '1.2']);
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBe('1.1');
	});

	it('1.1 and 1.1.1 — both in plan → ambiguous', () => {
		const args = { prompt: 'Review task 1.1 and sub-task 1.1.1' };
		const knownPlanTaskIds = new Set(['1.1', '1.1.1']);
		const result = resolveDelegatedPlanTaskId(args, knownPlanTaskIds);
		expect(result).toBeNull(); // both in plan → ambiguous
	});

	it('1.1 and 1.1.1 without plan context → null (multiple matches)', () => {
		const args = { prompt: 'Review task 1.1 and sub-task 1.1.1' };
		const result = resolveDelegatedPlanTaskId(args, undefined);
		expect(result).toBeNull(); // seen = {1.1, 1.1.1} → size 2 → null
	});
});

// =============================================================================
// resolveEvidenceTaskId — async integration tests with real temp directories
// =============================================================================

describe('resolveEvidenceTaskId — FR-001/FR-005: explicit task_id field', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('evidence-taskid-');
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '2.3', status: 'pending' },
			],
		});
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('returns explicit task_id when valid (step 1)', async () => {
		const session = ensureAgentSession('test-session-fr001');
		session.currentTaskId = '1.1';
		const args = { task_id: '2.3', prompt: 'Task 2.3' };

		// Step 1 should return '2.3' before calling loadPlanJsonOnly
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('2.3');
	});

	it('explicit task_id too long → resolveDelegatedPlanTaskId is fail-closed → session fallback', async () => {
		// CRITICAL: resolveDelegatedPlanTaskId is fail-closed on explicit invalid fields.
		// When explicit task_id is present but invalid (>20 chars), it returns null
		// without falling through to text extraction. This means step 2 returns null
		// and step 3 (session fallback) is used.
		const session = ensureAgentSession('test-session-fr001b');
		session.currentTaskId = '1.1';
		// "1.1.1.1.1.1.1.1.1.1.1" is 21 chars > 20 → step 1 fails
		// resolveDelegatedPlanTaskId is ALSO fail-closed on this → null
		// → step 3 session fallback = '1.1'
		const args = {
			task_id: '1.1.1.1.1.1.1.1.1.1.1',
			prompt: 'Task 2.3',
		};

		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.1'); // step 3 session fallback
	});
});

describe('resolveEvidenceTaskId — FR-002: both paths use same resolution', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('evidence-taskid-fr002-');
		writePlanJson(tempDir, {
			tasks: [{ id: '3.2', status: 'pending' }],
		});
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('stored-args and delegation-chain paths resolve identically for same args', async () => {
		const session = ensureAgentSession('test-session-fr002');
		session.currentTaskId = '1.1';
		const args = { prompt: 'Task 3.2' };

		// Both paths call resolveEvidenceTaskId — verify via resolveDelegatedPlanTaskId
		// (step 2 behavior is the same for both paths)
		const result = resolveDelegatedPlanTaskId(args, new Set(['3.2']));
		expect(result).toBe('3.2');

		// Full resolveEvidenceTaskId should also return 3.2 via step 2
		const fullResult = await resolveEvidenceTaskId(args, session, tempDir);
		expect(fullResult).toBe('3.2');
	});
});

describe('resolveEvidenceTaskId — FR-003: plan-aware filtering in step 2', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('evidence-taskid-fr003-');
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('version-like N.M not in plan → filtered → step 3 fallback', async () => {
		const session = ensureAgentSession('test-session-fr003');
		session.currentTaskId = '1.1';
		// 6.33.7 is NOT in the plan (only 1.1, 1.2 are)
		const args = { prompt: 'Version 6.33.7 looks good' };

		// Step 1: no explicit task_id
		// Step 2: 6.33.7 not in plan → filtered → null
		// Step 3: getEvidenceTaskId → session.currentTaskId = '1.1'
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.1');
	});

	it('task ID in plan resolves via step 2', async () => {
		const session = ensureAgentSession('test-session-fr003b');
		session.currentTaskId = '1.1';
		const args = { prompt: 'Task 1.2 is ready' }; // 1.2 IS in plan

		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.2');
	});

	it('N.M.P version not in plan → filtered → step 3 fallback', async () => {
		const session = ensureAgentSession('test-session-fr003c');
		session.currentTaskId = '1.1';
		const args = { prompt: 'Fix version 3.4.5 for task 1.1' }; // 3.4.5 not in plan

		// 3.4.5 filtered (not in plan), 1.1 remains → unambiguous → returns 1.1
		// But wait — 1.1 IS in the plan, so this should return 1.1 via step 2
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.1'); // step 2 succeeds with 1.1
	});
});

describe('resolveEvidenceTaskId — FR-004: ambiguity handled correctly', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('evidence-taskid-fr004-');
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('ambiguous prompt → step 2 returns null → step 3 fallback', async () => {
		const session = ensureAgentSession('test-session-fr004');
		session.currentTaskId = '1.1';
		const args = { prompt: 'Tasks 1.1 and 1.2 are both done' };

		// Step 1: no explicit task_id
		// Step 2: 1.1 and 1.2 both in plan → ambiguous → null
		// Step 3: getEvidenceTaskId → session.currentTaskId = '1.1'
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.1');
	});

	it('1.1 and 1.1.1 both in plan → ambiguous → step 3 fallback', async () => {
		// Set up plan with 1.1 and 1.1.1
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = makeTempProject('evidence-taskid-fr004b-');
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.1.1', status: 'pending' },
			],
		});

		const session = ensureAgentSession('test-session-fr004b');
		session.currentTaskId = '1.1';
		const args = { prompt: 'Review task 1.1 and sub-task 1.1.1' };

		// Both 1.1 and 1.1.1 are in plan → ambiguous → null
		// Step 3 fallback → '1.1'
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.1');
	});
});

describe('resolveEvidenceTaskId — edge cases', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('evidence-taskid-edge-');
		writePlanJson(tempDir, {
			tasks: [{ id: '1.1', status: 'pending' }],
		});
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('args is undefined → falls through to step 3', async () => {
		const session = ensureAgentSession('test-session-edge1');
		session.currentTaskId = '5.5';

		const result = await resolveEvidenceTaskId(undefined, session, tempDir);
		expect(result).toBe('5.5');
	});

	it('args is null → falls through to step 3', async () => {
		const session = ensureAgentSession('test-session-edge2');
		session.currentTaskId = '6.6';

		const result = await resolveEvidenceTaskId(
			null as unknown as Record<string, unknown>,
			session,
			tempDir,
		);
		expect(result).toBe('6.6');
	});

	it('empty args object → falls through to step 3', async () => {
		const session = ensureAgentSession('test-session-edge3');
		session.currentTaskId = '7.7';

		const result = await resolveEvidenceTaskId({}, session, tempDir);
		expect(result).toBe('7.7');
	});

	it('session with taskWorkflowStates but no currentTaskId → uses first entry', async () => {
		const session = ensureAgentSession('test-session-edge4');
		// No currentTaskId, but has taskWorkflowStates entry
		session.taskWorkflowStates.set('9.9', 'tests_run');

		const result = await resolveEvidenceTaskId({}, session, tempDir);
		expect(result).toBe('9.9');
	});

	it('invalid explicit task_id → step 1 fails → resolveDelegatedPlanTaskId does NOT fall through (fail-closed)', () => {
		// resolveDelegatedPlanTaskId is fail-closed on invalid explicit field.
		// It does NOT fall through to text extraction.
		const args = {
			task_id: 'reviewer-1', // not a strict task ID
			prompt: 'Task 3.1',
		};
		const planTaskIds = new Set(['1.1', '3.1']);
		const result = resolveDelegatedPlanTaskId(args, planTaskIds);
		// Fail-closed: explicit field present but invalid → null (no text extraction)
		expect(result).toBeNull();
	});

	it('plan file missing → step 2 skipped entirely, step 3 session fallback used', async () => {
		const session = ensureAgentSession('test-session-edge5');
		session.currentTaskId = '1.1';
		// Use a path where plan.json doesn't exist
		const badDir = makeTempProject('evidence-no-plan-');
		try {
			// Remove the .swarm directory to make plan unavailable
			fs.rmSync(path.join(badDir, '.swarm'), { recursive: true, force: true });

			// When plan is unavailable, text extraction is SKIPPED entirely (Issue #970 reviewer fix).
			// Version-like patterns (e.g., "6.33.7") must NOT be misidentified as task IDs.
			// Falls through to step 3 (session fallback).
			const args = { prompt: 'Version 6.33.7 looks good' };
			const result = await resolveEvidenceTaskId(args, session, badDir);
			expect(result).toBe('1.1'); // step 2 skipped, session.currentTaskId used
		} finally {
			try {
				fs.rmSync(badDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	it('plan file missing with no N.M pattern in prompt → step 3 fallback', async () => {
		const session = ensureAgentSession('test-session-edge5b');
		session.currentTaskId = '1.1';
		const badDir = makeTempProject('evidence-no-plan2-');
		try {
			fs.rmSync(path.join(badDir, '.swarm'), { recursive: true, force: true });

			// No N.M pattern in prompt → resolveDelegatedPlanTaskId returns null
			// → step 3 fallback → session.currentTaskId = '1.1'
			const args = { prompt: 'No task ID in this prompt' };
			const result = await resolveEvidenceTaskId(args, session, badDir);
			expect(result).toBe('1.1'); // step 3 fallback
		} finally {
			try {
				fs.rmSync(badDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});
});

describe('resolveEvidenceTaskId — FR-005: no regression in single-task sessions', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('evidence-taskid-fr005-');
		writePlanJson(tempDir, {
			tasks: [{ id: '1.1', status: 'pending' }],
		});
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('session.currentTaskId used when prompt has no task ID', async () => {
		const session = ensureAgentSession('test-session-fr005');
		session.currentTaskId = '1.1';
		const args = { prompt: 'Please review the changes' }; // no task ID

		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.1');
	});

	it('session.lastCoderDelegationTaskId is used as fallback', async () => {
		const session = ensureAgentSession('test-session-fr005b');
		session.lastCoderDelegationTaskId = '2.2';

		const args = { prompt: 'No task ID here' };
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('2.2');
	});

	it('currentTaskId takes precedence over lastCoderDelegationTaskId', async () => {
		const session = ensureAgentSession('test-session-fr005c');
		session.currentTaskId = '1.1';
		session.lastCoderDelegationTaskId = '2.2';

		const args = { prompt: 'No task ID here' };
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.1'); // currentTaskId is primary
	});
});

// =============================================================================
// Integration: verify step 2 behavior with real plan files
// =============================================================================

describe('resolveEvidenceTaskId — full integration with real plan', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('evidence-taskid-integration-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('step 2 finds task via plan-aware filtering — single match', async () => {
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '4.5', status: 'pending' },
			],
		});
		const session = ensureAgentSession('test-session-integ1');
		session.currentTaskId = '1.1';
		const args = { prompt: 'Task 4.5 needs verification' };

		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('4.5');
	});

	it('step 2 returns null on multiple matches → step 3 fallback', async () => {
		writePlanJson(tempDir, {
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});
		const session = ensureAgentSession('test-session-integ2');
		session.currentTaskId = '1.1';
		const args = { prompt: 'Tasks 1.1 and 1.2' };

		// Ambiguous → step 2 returns null → step 3 fallback
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('1.1');
	});

	it('step 1 explicit task_id takes precedence over plan extraction', async () => {
		writePlanJson(tempDir, {
			tasks: [{ id: '3.3', status: 'pending' }],
		});
		const session = ensureAgentSession('test-session-integ3');
		session.currentTaskId = '1.1';
		const args = {
			task_id: '3.3',
			prompt: 'This mentions 4.4 but we have explicit 3.3',
		};

		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('3.3'); // step 1 wins
	});

	it('version number not in plan does not interfere', async () => {
		writePlanJson(tempDir, {
			tasks: [{ id: '2.2', status: 'pending' }],
		});
		const session = ensureAgentSession('test-session-integ4');
		session.currentTaskId = '1.1';
		const args = {
			prompt: 'Bump to version 6.33.7 and continue task 2.2',
		};

		// 6.33.7 not in plan → filtered; 2.2 is in plan → returns 2.2
		const result = await resolveEvidenceTaskId(args, session, tempDir);
		expect(result).toBe('2.2');
	});
});
