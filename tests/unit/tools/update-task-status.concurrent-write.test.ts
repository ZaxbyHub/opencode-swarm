/**
 * Concurrent write verification tests for update-task-status.ts
 *
 * These tests verify the actual guarantees provided by the locking implementation:
 * 1. No file corruption - concurrent calls never produce invalid/corrupted plan.json
 * 2. Lock winners write correctly - a call that succeeds actually persists its status
 * 3. Lock losers fail visibly with recovery guidance - success: false with errors/recovery_guidance
 * 4. Sequential calls all succeed - lock releases properly after each call
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../../../src/state';
import {
	executeUpdateTaskStatus,
	type UpdateTaskStatusArgs,
} from '../../../src/tools/update-task-status';

describe('executeUpdateTaskStatus concurrent writes', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentSessions: typeof swarmState.agentSessions;
	let planPath: string;

	const TASK_IDS = [
		'1.1',
		'1.2',
		'1.3',
		'1.4',
		'1.5',
		'1.6',
		'1.7',
		'1.8',
		'1.9',
		'1.10',
	];

	const buildPlan = (taskStatuses: Record<string, string> = {}) => {
		const tasks = TASK_IDS.map((id, idx) => ({
			id,
			phase: 1,
			status: taskStatuses[id] ?? 'pending',
			size: 'small' as const,
			description: `Task ${idx + 1}`,
			depends: [] as string[],
			files_touched: [] as string[],
		}));
		return {
			schema_version: '1.0.0',
			title: 'Concurrent Write Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			migration_status: 'migrated',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks,
				},
			],
		};
	};

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'update-task-status-concurrent-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory with a valid plan containing 10 tasks
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		planPath = path.join(tempDir, '.swarm', 'plan.json');
		fs.writeFileSync(planPath, JSON.stringify(buildPlan(), null, 2));

		// Save and clear agent sessions to avoid state machine issues
		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();
	});

	afterEach(() => {
		// Restore agent sessions
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions) {
			swarmState.agentSessions.set(key, value);
		}

		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('no-corruption guarantee under concurrent load', () => {
		test('plan.json remains valid JSON after 10 parallel updates', async () => {
			// Arrange: 10 parallel updates for 10 different tasks
			const statuses: UpdateTaskStatusArgs['status'][] = [
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
			];

			const updatePromises = TASK_IDS.map((taskId, index) =>
				executeUpdateTaskStatus(
					{ task_id: taskId, status: statuses[index] },
					tempDir,
				),
			);

			// Act: Execute all updates in parallel
			await Promise.allSettled(updatePromises);

			// Assert: plan.json is valid JSON (no corruption)
			let planContent: string;
			let parsedPlan: ReturnType<typeof buildPlan>;
			try {
				planContent = fs.readFileSync(planPath, 'utf-8');
				parsedPlan = JSON.parse(planContent);
			} catch {
				throw new Error(
					`plan.json is corrupted or unreadable after concurrent updates: ${JSON.stringify(
						{ canRead: fs.existsSync(planPath) },
					)}`,
				);
			}

			// Assert: file has correct structure - all 10 tasks present
			expect(parsedPlan.phases).toHaveLength(1);
			expect(parsedPlan.phases[0].tasks).toHaveLength(10);

			const taskIds = parsedPlan.phases[0].tasks.map(
				(t: { id: string }) => t.id,
			);
			for (const expectedId of TASK_IDS) {
				expect(taskIds).toContain(expectedId);
			}
		});

		test('plan.json structure is preserved - no truncated or partial writes', async () => {
			// Run parallel updates
			const statuses: UpdateTaskStatusArgs['status'][] = [
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
				'blocked',
				'blocked',
				'blocked',
				'blocked',
				'blocked',
			];

			const updatePromises = TASK_IDS.map((taskId, index) =>
				executeUpdateTaskStatus(
					{ task_id: taskId, status: statuses[index] },
					tempDir,
				),
			);

			await Promise.allSettled(updatePromises);

			// Verify complete file structure
			const planContent = fs.readFileSync(planPath, 'utf-8');
			const plan = JSON.parse(planContent);

			// All required top-level fields present
			expect(plan.schema_version).toBe('1.0.0');
			expect(plan.title).toBe('Concurrent Write Test Plan');
			expect(plan.swarm).toBe('test-swarm');
			expect(plan.current_phase).toBe(1);
			expect(plan.migration_status).toBe('migrated');

			// Phase structure intact
			expect(plan.phases).toHaveLength(1);
			expect(plan.phases[0].id).toBe(1);
			expect(plan.phases[0].name).toBe('Phase 1');
			expect(plan.phases[0].status).toBe('in_progress');

			// All 10 tasks have all required fields
			for (const task of plan.phases[0].tasks) {
				expect(task).toHaveProperty('id');
				expect(task).toHaveProperty('phase');
				expect(task).toHaveProperty('status');
				expect(task).toHaveProperty('size');
				expect(task).toHaveProperty('description');
				expect(task).toHaveProperty('depends');
				expect(task).toHaveProperty('files_touched');
			}
		});
	});

	describe('lock winner persists data correctly', () => {
		test('a winning call that returns success actually persists its status', async () => {
			// Run 10 parallel updates. The lock is on plan.json (not per-task), and
			// file-locks.ts now retries with backoff (F-09, retries:5), so one OR MORE
			// callers serialize through the lock and win; the loser count depends on
			// timing. Every winner's status must be durably persisted (asserted below).
			const statuses: UpdateTaskStatusArgs['status'][] = [
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
			];

			const updatePromises = TASK_IDS.map((taskId, index) =>
				executeUpdateTaskStatus(
					{ task_id: taskId, status: statuses[index] },
					tempDir,
				),
			);

			const results = await Promise.all(updatePromises);

			// Find the winner(s) - calls that returned success: true
			const winners = results.filter((r) => r.success);

			// F-09 serialization rationale: file-locks.ts now uses proper-lockfile
			// `retries:5` + exponential backoff (src/parallel/file-locks.ts:163-172)
			// instead of the old `retries:0`. Contending callers therefore SERIALIZE
			// and more than one can win within the retry budget; the exact winner
			// count is timing/platform-dependent (it is NOT deterministically 1, and
			// NOT necessarily all 10 — some contenders still exhaust the bounded retry
			// budget and return success:false). The real correctness guarantee is the
			// per-winner "status actually persisted" check below: every call that
			// reported success must have its status durably written to plan.json with
			// no lost update. That holds because the mutation (updateTaskStatus:
			// loadPlan→modify→savePlan) runs INSIDE the lock, so each serialized winner
			// reads fresh state.
			expect(winners.length).toBeGreaterThanOrEqual(1);

			// For each winner, verify its task's status in the final plan.json matches what it wrote
			const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
			const taskStatusMap = new Map(
				plan.phases[0].tasks.map((t: { id: string; status: string }) => [
					t.id,
					t.status,
				]),
			);

			for (const winner of winners) {
				expect(winner.task_id).toBeDefined();
				expect(winner.new_status).toBeDefined();
				const persistedStatus = taskStatusMap.get(winner.task_id!);
				expect(persistedStatus).toBe(winner.new_status);
			}

			// Any loser (retry budget exhausted) must fail visibly with recovery guidance,
			// never silently — so the bounded winner count is not a weak assertion.
			const losers = results.filter((r) => !r.success);
			for (const loser of losers) {
				expect(typeof loser.recovery_guidance).toBe('string');
				expect(loser.recovery_guidance!.toLowerCase()).toContain('retry');
			}
		});

		test('status that won the lock is durable - persists after subsequent reads', async () => {
			const statuses: UpdateTaskStatusArgs['status'][] = [
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
			];

			const updatePromises = TASK_IDS.map((taskId, index) =>
				executeUpdateTaskStatus(
					{ task_id: taskId, status: statuses[index] },
					tempDir,
				),
			);

			await Promise.allSettled(updatePromises);

			// Read the plan multiple times - status should be consistent
			const plan1 = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
			const plan2 = JSON.parse(fs.readFileSync(planPath, 'utf-8'));

			expect(plan1).toEqual(plan2);

			// Status should match one of the intended statuses (not corrupted)
			const validStatuses = new Set(['in_progress', 'blocked', 'pending']);
			for (const task of plan1.phases[0].tasks) {
				expect(validStatuses.has(task.status)).toBe(true);
			}
		});
	});

	describe('lock losers return actionable errors not silent corruption', () => {
		test('a failing call returns success false with errors or recovery_guidance', async () => {
			const statuses: UpdateTaskStatusArgs['status'][] = [
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
				'in_progress',
			];

			const updatePromises = TASK_IDS.map((taskId, index) =>
				executeUpdateTaskStatus(
					{ task_id: taskId, status: statuses[index] },
					tempDir,
				),
			);

			const results = await Promise.all(updatePromises);

			// Find the loser(s) - calls that returned success: false
			const losers = results.filter((r) => !r.success);

			// If there are losers (which is expected given lock contention), each must have
			// either errors array OR recovery_guidance field
			for (const loser of losers) {
				const hasErrors =
					Array.isArray(loser.errors) && loser.errors.length > 0;
				const hasRecoveryGuidance =
					typeof loser.recovery_guidance === 'string' &&
					loser.recovery_guidance.length > 0;

				expect(hasErrors && hasRecoveryGuidance).toBe(true);

				// Should not have task_id or new_status since it didn't actually update
				expect(loser.task_id).toBeUndefined();
				expect(loser.new_status).toBeUndefined();
			}
		});

		test('lock contention error message is informative', async () => {
			const statuses: UpdateTaskStatusArgs['status'][] =
				Array(10).fill('in_progress');

			const updatePromises = TASK_IDS.map((taskId, index) =>
				executeUpdateTaskStatus(
					{ task_id: taskId, status: statuses[index] },
					tempDir,
				),
			);

			const results = await Promise.all(updatePromises);
			const losers = results.filter((r) => !r.success);

			for (const loser of losers) {
				// Message should indicate what happened
				expect(loser.message).toBeTruthy();
				expect(loser.message.length).toBeGreaterThan(0);

				// Should have recovery guidance that tells user to retry
				expect(loser.recovery_guidance!.toLowerCase()).toContain('retry');
			}
		});
	});

	describe('sequential calls all succeed and all persist', () => {
		test('10 sequential updates all return success true', async () => {
			const statuses: UpdateTaskStatusArgs['status'][] = [
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
			];

			// Execute sequentially (one at a time)
			const results: Awaited<ReturnType<typeof executeUpdateTaskStatus>>[] = [];
			for (let i = 0; i < TASK_IDS.length; i++) {
				const result = await executeUpdateTaskStatus(
					{ task_id: TASK_IDS[i], status: statuses[i] },
					tempDir,
				);
				results.push(result);
			}

			// Assert: ALL 10 returned success
			for (let i = 0; i < results.length; i++) {
				expect(results[i].success).toBe(true);
				expect(results[i].task_id).toBe(TASK_IDS[i]);
				expect(results[i].new_status).toBe(statuses[i]);
			}
		});

		test('10 sequential updates all persist correctly to plan.json', async () => {
			const statuses: UpdateTaskStatusArgs['status'][] = [
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
			];

			// Execute sequentially
			for (let i = 0; i < TASK_IDS.length; i++) {
				await executeUpdateTaskStatus(
					{ task_id: TASK_IDS[i], status: statuses[i] },
					tempDir,
				);
			}

			// Read plan.json and verify all 10 statuses match
			const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
			const taskStatusMap = new Map(
				plan.phases[0].tasks.map((t: { id: string; status: string }) => [
					t.id,
					t.status,
				]),
			);

			for (let i = 0; i < TASK_IDS.length; i++) {
				const persistedStatus = taskStatusMap.get(TASK_IDS[i]);
				expect(persistedStatus).toBe(statuses[i]);
			}
		});

		test('each sequential update is immediately durable', async () => {
			// Run updates sequentially, verifying durability after each one
			const statuses: UpdateTaskStatusArgs['status'][] = [
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
				'in_progress',
				'blocked',
			];

			for (let i = 0; i < TASK_IDS.length; i++) {
				// Update status
				await executeUpdateTaskStatus(
					{ task_id: TASK_IDS[i], status: statuses[i] },
					tempDir,
				);

				// Immediately read and verify it persisted
				const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
				const task = plan.phases[0].tasks.find(
					(t: { id: string }) => t.id === TASK_IDS[i],
				);
				expect(task?.status).toBe(statuses[i]);

				// Also verify all previous updates are still correct
				for (let j = 0; j <= i; j++) {
					const prevTask = plan.phases[0].tasks.find(
						(t: { id: string }) => t.id === TASK_IDS[j],
					);
					expect(prevTask?.status).toBe(statuses[j]);
				}
			}
		});
	});
});
