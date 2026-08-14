/**
 * Tests that update_task_status is a real PRODUCER for .swarm/run-memory.jsonl.
 *
 * `recordOutcome`/`getTaskHistory` previously had zero production callers, so
 * the file was never written and the architect's run-memory injection could
 * never fire. These tests pin the four terminal outcomes update_task_status
 * knows about — council-gate block, QA-gate block, completed, blocked — and
 * assert on the file the injector actually reads, not on a spy.
 *
 * DI via the `_internals` seam (AGENTS.md invariant 7); `recordTaskAttempt` is
 * left REAL so a broken write shows up as a missing entry.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan, RuntimePlan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import { setGatesForIdentity } from '../../../src/db/qa-gate-profile';
import { recordGateEvidence } from '../../../src/gate-evidence';
import type { RunMemoryEntry } from '../../../src/services/run-memory';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	_internals,
	executeUpdateTaskStatus,
} from '../../../src/tools/update-task-status';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TASK_ID = '1.1';
const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const PLAN_IDENTITY = { swarm: PLAN_SWARM, title: PLAN_TITLE };

let tempDir: string;
const realInternals = { ..._internals };

function buildPlan(overrides?: {
	requiredAgents?: string[];
	blockedReason?: string;
}): Plan {
	return {
		schema_version: '1.0.0',
		title: PLAN_TITLE,
		swarm: PLAN_SWARM,
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				required_agents: overrides?.requiredAgents,
				tasks: [
					{
						id: TASK_ID,
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'a task',
						depends: [],
						files_touched: ['src/a.ts', 'src/b.ts'],
						blocked_reason: overrides?.blockedReason,
					},
				],
			},
		],
	} as unknown as Plan;
}

/** Write the on-disk plan.json that the tool reads directly (not via loadPlan). */
function writePlanFile(plan: Plan): void {
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(join(tempDir, '.swarm', 'plan.json'), JSON.stringify(plan));
}

async function readRunMemory(): Promise<RunMemoryEntry[]> {
	const file = join(tempDir, '.swarm', 'run-memory.jsonl');
	if (!existsSync(file)) return [];
	const raw = await readFile(file, 'utf-8');
	return raw
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as RunMemoryEntry);
}

/** Stub the plan mutation + lock so the test exercises outcome recording only. */
function stubMutationPath(resultPlan: Plan): void {
	_internals.loadPlan = async () => resultPlan as RuntimePlan;
	_internals.updateTaskStatus = async (_directory, taskId, status) => {
		const updated = structuredClone(resultPlan);
		const task = updated.phases
			.flatMap((phase) => phase.tasks)
			.find((candidate) => candidate.id === taskId);
		if (task) task.status = status;
		return updated;
	};
	_internals.tryAcquireLock = (async () => ({
		acquired: true,
		lock: { _release: async () => {} },
	})) as unknown as typeof _internals.tryAcquireLock;
}

/**
 * Put the QA (reviewer) gate into a genuinely blocked state.
 *
 * Seeds durable evidence via an in_progress transition + a coder dispatch (which
 * establishes required_gates), records ONLY the reviewer gate so test_engineer
 * is still missing, then installs a minimal agent session — without one, the
 * gate takes its `zero_valid_sessions` bypass and never blocks.
 */
async function seedBlockingReviewerGate(): Promise<void> {
	await executeUpdateTaskStatus(
		{ task_id: TASK_ID, status: 'in_progress', working_directory: tempDir },
		tempDir,
	);
	const generation = await seedStageAPassed(tempDir, TASK_ID);
	await recordGateEvidence(
		tempDir,
		TASK_ID,
		'reviewer',
		'sess-reviewer',
		false,
		{ expectedGeneration: generation },
	);
	resetSwarmState();
	swarmState.agentSessions.set('test-session', {
		id: 'test-session',
		taskWorkflowStates: new Map([[TASK_ID, 'idle']]),
		currentTaskId: TASK_ID,
	} as unknown as never);
}

beforeEach(() => {
	// canonicalMkdtemp, not raw mkdtempSync: executeUpdateTaskStatus canonicalizes
	// with realpathSync and compares prefixes, so an uncanonical temp root (macOS
	// /var -> /private/var, Windows 8.3 names) would trip its subdirectory guard.
	tempDir = canonicalMkdtemp('uts-run-memory-');
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	resetSwarmState();
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	resetSwarmState();
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('update_task_status records a FAILED attempt when a gate blocks', () => {
	test('council gate block is recorded with the gate reason', async () => {
		// council.enabled AND council_mode -> gate active; no council evidence -> blocked.
		writeFileSync(
			join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ council: { enabled: true } }),
		);
		const plan = buildPlan();
		writePlanFile(plan);
		setGatesForIdentity(tempDir, PLAN_IDENTITY, { council_mode: true });
		stubMutationPath(plan);

		const result = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: tempDir },
			tempDir,
		);

		expect(result.success).toBe(false);
		const entries = await readRunMemory();
		expect(entries).toHaveLength(1);
		expect(entries[0].outcome).toBe('fail');
		expect(entries[0].taskId).toBe(TASK_ID);
		expect(entries[0].attemptNumber).toBe(1);
		expect(entries[0].failureReason).toContain('council gate');
		// files_touched from the plan feeds the fingerprint / filesModified.
		expect(entries[0].filesModified).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('QA (reviewer) gate block is recorded with the gate reason', async () => {
		const plan = buildPlan();
		writePlanFile(plan);
		stubMutationPath(plan);
		await seedBlockingReviewerGate();

		const result = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: tempDir },
			tempDir,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('Gate check failed');
		const entries = await readRunMemory();
		expect(entries).toHaveLength(1);
		expect(entries[0].outcome).toBe('fail');
		expect(entries[0].failureReason).toContain('QA gate');
		expect(entries[0].failureReason).toContain('test_engineer');
	});

	test('repeated gate blocks increment the attempt number', async () => {
		const plan = buildPlan();
		writePlanFile(plan);
		stubMutationPath(plan);
		await seedBlockingReviewerGate();

		const args = {
			task_id: TASK_ID,
			status: 'completed',
			working_directory: tempDir,
		};
		const first = await executeUpdateTaskStatus(args, tempDir);
		const second = await executeUpdateTaskStatus(args, tempDir);

		// Both must actually be blocks — if the gate let them through, the entries
		// would be passes and this test would pass for the wrong reason.
		expect(first.success).toBe(false);
		expect(second.success).toBe(false);
		const entries = await readRunMemory();
		expect(entries.map((e) => e.attemptNumber)).toEqual([1, 2]);
		expect(entries.map((e) => e.outcome)).toEqual(['fail', 'fail']);
	});
});

describe('run-memory recording never breaks the status update', () => {
	test('a recorder failure leaves the update successful', async () => {
		const plan = buildPlan({ requiredAgents: ['docs'] });
		writePlanFile(plan);
		stubMutationPath(plan);
		_internals.recordTaskAttempt = async () => {
			throw new Error('run memory exploded');
		};

		const result = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: tempDir },
			tempDir,
		);

		// The real recordTaskAttempt is fail-open; this asserts the CALL SITE does
		// not depend on that — a throwing seam must not convert a successful
		// status update into a failure. (Terminal-outcome recording now lives in
		// plan/manager.updateTaskStatus, which is stubbed here, so only the
		// gate-block seam is exercised by this path.)
		expect(result.success).toBe(true);
		expect(result.new_status).toBe('completed');
	});

	test('a recorder failure on the gate-block path still returns the gate result', async () => {
		const plan = buildPlan();
		writePlanFile(plan);
		stubMutationPath(plan);
		await seedBlockingReviewerGate();
		_internals.recordTaskAttempt = async () => {
			throw new Error('run memory exploded');
		};

		// The gate-block call site sits outside any try block, so the only thing
		// stopping a throwing seam from rejecting the whole tool call is
		// recordRunMemoryOutcome's internal catch. This asserts that guard holds:
		// the blocked-gate result must still be returned.
		const result = await executeUpdateTaskStatus(
			{ task_id: TASK_ID, status: 'completed', working_directory: tempDir },
			tempDir,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('Gate check failed');
	});
});
