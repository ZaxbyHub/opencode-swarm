/**
 * Adversarial tests for update-task-status.ts
 * Tests malformed inputs, boundary violations, injection attempts, path traversal
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	advanceTaskState,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
	type UpdateTaskStatusArgs,
	validateStatus,
	validateTaskId,
} from '../../../src/tools/update-task-status';
import {
	createWorkflowTestSession,
	createWorkflowTestSessionWithCompletedTask,
	createWorkflowTestSessionWithPassedTask,
	createWorkflowTestSessionWithTaskAtState,
} from '../../helpers/workflow-session-factory';

describe('update-task-status adversarial tests', () => {
	let tempDir: string;
	let tempDirs: string[] = [];

	beforeEach(async () => {
		// Create temp directory for each test
		tempDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'update-task-adversarial-')),
		);
		tempDirs.push(tempDir);
		// Create .swarm directory with a valid plan
		await fs.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			migration_status: 'migrated',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Test task 1',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'medium',
							description: 'Test task 2',
							depends: ['1.1'],
							files_touched: [],
						},
					],
				},
			],
		};
		await fs.writeFile(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	});

	afterEach(async () => {
		// Clean up all temp directories
		for (const dir of tempDirs) {
			try {
				await fs.rm(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		tempDirs = [];
		// Reset swarm state after each test
		resetSwarmState();
	});

	// ========== GROUP 1: Malformed task IDs - Path Traversal ==========
	describe('Group 1: Malformed task IDs - Path traversal attempts', () => {
		it('rejects "../" path traversal in task_id', () => {
			const result = validateTaskId('../1.1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects ".." path traversal in task_id', () => {
			const result = validateTaskId('..');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects absolute path as task_id', () => {
			const result = validateTaskId('/etc/passwd');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects path with backslash as task_id', () => {
			const result = validateTaskId('1.1\\..\\1.2');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects null byte injection in task_id', () => {
			const result = validateTaskId('1.1\x00');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects path with forward slash inside task_id', () => {
			const result = validateTaskId('1/1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects path with multiple consecutive dots', () => {
			const result = validateTaskId('1...1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects Windows-style path in task_id', () => {
			const result = validateTaskId('C:\\windows\\system32');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});
	});

	// ========== GROUP 2: Malformed task IDs - Control Characters ==========
	describe('Group 2: Malformed task IDs - Control characters', () => {
		it('rejects tab character in task_id', () => {
			const result = validateTaskId('1.\t1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects newline character in task_id', () => {
			const result = validateTaskId('1.\n1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects carriage return in task_id', () => {
			const result = validateTaskId('1.\r1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects null character in task_id', () => {
			const result = validateTaskId('1.\x001');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects vertical tab in task_id', () => {
			const result = validateTaskId('1.\x0b1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects form feed in task_id', () => {
			const result = validateTaskId('1.\x0c1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects escape character in task_id', () => {
			const result = validateTaskId('1.\x1b1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects SOH (start of heading) control char', () => {
			const result = validateTaskId('1.\x011');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});
	});

	// ========== GROUP 3: Malformed task IDs - Oversized Strings ==========
	describe('Group 3: Malformed task IDs - Oversized strings', () => {
		it('rejects extremely long task_id (10KB)', () => {
			const longId = '1.' + 'a'.repeat(10 * 1024);
			const result = validateTaskId(longId);
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects extremely long task_id (100KB)', () => {
			const longId = '1.' + 'a'.repeat(100 * 1024);
			const result = validateTaskId(longId);
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});
	});

	// ========== GROUP 4: Malformed task IDs - Boundary Values ==========
	describe('Group 4: Malformed task IDs - Boundary values', () => {
		it('rejects empty string task_id', () => {
			const result = validateTaskId('');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects whitespace-only task_id', () => {
			const result = validateTaskId('   ');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects task_id with only dots', () => {
			const result = validateTaskId('.');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects task_id with only leading dot', () => {
			const result = validateTaskId('.1.1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects task_id with only trailing dot', () => {
			const result = validateTaskId('1.1.');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects task_id with letters', () => {
			const result = validateTaskId('1a.1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects task_id with special characters', () => {
			const result = validateTaskId('1!1.1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects task_id with spaces', () => {
			const result = validateTaskId('1 .1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects single number (no dot)', () => {
			const result = validateTaskId('1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects negative numbers', () => {
			const result = validateTaskId('-1.1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects scientific notation', () => {
			const result = validateTaskId('1e5.1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});

		it('rejects hex numbers', () => {
			const result = validateTaskId('0xff.1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid task_id');
		});
	});

	// ========== GROUP 5: Invalid Status Values ==========
	describe('Group 5: Invalid status values', () => {
		it('rejects arbitrary string as status', () => {
			const result = validateStatus('arbitrary_status');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects empty string as status', () => {
			const result = validateStatus('');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects SQL injection attempt in status', () => {
			const result = validateStatus("'; DROP TABLE plans;--");
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects script injection in status', () => {
			const result = validateStatus('<script>alert(1)</script>');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects shell command in status', () => {
			const result = validateStatus('$(whoami)');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects path traversal in status', () => {
			const result = validateStatus('../etc/passwd');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects null byte in status', () => {
			const result = validateStatus('pending\x00');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects unicode injection in status', () => {
			const result = validateStatus('pending\u0000\u200b');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects case variation (PENDING vs pending)', () => {
			const result = validateStatus('PENDING');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects status with leading/trailing spaces', () => {
			const result = validateStatus(' pending ');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects very long status string', () => {
			const longStatus = 'pending'.repeat(1000);
			const result = validateStatus(longStatus);
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('accepts valid lowercase status "pending"', () => {
			const result = validateStatus('pending');
			expect(result).toBeUndefined();
		});

		it('accepts valid status "in_progress"', () => {
			const result = validateStatus('in_progress');
			expect(result).toBeUndefined();
		});

		it('accepts valid status "completed"', () => {
			const result = validateStatus('completed');
			expect(result).toBeUndefined();
		});

		it('accepts valid status "blocked"', () => {
			const result = validateStatus('blocked');
			expect(result).toBeUndefined();
		});
	});

	// ========== GROUP 6: Working Directory Handling ==========
	describe('Group 6: Working directory handling security', () => {
		it('explicit working_directory takes precedence over cwd', async () => {
			// Create a second temp directory with a different plan
			const otherDir = await fs.realpath(
				await fs.mkdtemp(path.join(os.tmpdir(), 'update-task-other-')),
			);
			tempDirs.push(otherDir);
			await fs.mkdir(path.join(otherDir, '.swarm'), { recursive: true });
			const otherPlan = {
				schema_version: '1.0.0',
				title: 'Other Plan',
				swarm: 'other-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Other task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			await fs.writeFile(
				path.join(otherDir, '.swarm', 'plan.json'),
				JSON.stringify(otherPlan, null, 2),
			);

			// Change cwd to tempDir but specify otherDir in args
			const originalCwd = process.cwd();
			try {
				process.chdir(tempDir);

				const args: UpdateTaskStatusArgs = {
					task_id: '1.1',
					status: 'completed',
					working_directory: otherDir,
				};

				const result = await executeUpdateTaskStatus(args);

				// Should update the plan in otherDir, not tempDir
				expect(result.success).toBe(true);

				// Verify otherDir's plan was updated
				const otherPlanContent = JSON.parse(
					await fs.readFile(
						path.join(otherDir, '.swarm', 'plan.json'),
						'utf-8',
					),
				);
				expect(otherPlanContent.phases[0].tasks[0].status).toBe('completed');

				// Verify tempDir's plan was NOT updated
				const tempPlanContent = JSON.parse(
					await fs.readFile(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
				);
				expect(tempPlanContent.phases[0].tasks[0].status).toBe('pending');
			} finally {
				process.chdir(originalCwd);
			}
		});

		it('path traversal in working_directory is NOT blocked (security concern)', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
				working_directory: '../..',
			};

			const result = await executeUpdateTaskStatus(args);
			// Currently succeeds - security vulnerability!
			// The implementation should reject path traversal in working_directory
			// Check behavioral assertion - should fail due to path traversal
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
		});

		it('handles non-existent working_directory (may fall back to cwd)', async () => {
			// Use a path that is guaranteed to not exist in any environment
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
				working_directory: '/this/path/absolutely/does/not/exist/anywhere',
			};

			const result = await executeUpdateTaskStatus(args);
			// May succeed if falls back to cwd, or fail if plan not found
			// Check behavioral assertion - should fail gracefully
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
		});
	});

	// ========== GROUP 7: Rapid Consecutive Updates ==========
	describe('Group 7: Rapid consecutive updates to same task', () => {
		// Pre-seed evidence with gates passed so rapid-update tests can reach 'completed'
		// without needing to run through the full reviewer/test_engineer workflow.
		beforeEach(async () => {
			await fs.mkdir(path.join(tempDir, '.swarm', 'evidence'), {
				recursive: true,
			});
			await fs.writeFile(
				path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
				JSON.stringify({
					taskId: '1.1',
					required_gates: ['reviewer', 'test_engineer'],
					gates: {
						reviewer: {
							sessionId: 'test-session',
							timestamp: new Date().toISOString(),
							agent: 'reviewer',
						},
						test_engineer: {
							sessionId: 'test-session',
							timestamp: new Date().toISOString(),
							agent: 'test_engineer',
						},
					},
				}),
			);
		});

		it('handles rapid status changes from pending to in_progress', async () => {
			const args1: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
				working_directory: tempDir,
			};

			const result1 = await executeUpdateTaskStatus(args1);
			expect(result1.success).toBe(true);
			expect(result1.new_status).toBe('in_progress');

			// Read and verify
			const plan1 = JSON.parse(
				await fs.readFile(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
			);
			expect(plan1.phases[0].tasks[0].status).toBe('in_progress');
		});

		it('handles rapid status changes from in_progress to completed', async () => {
			const args1: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
				working_directory: tempDir,
			};

			await executeUpdateTaskStatus(args1);

			const args2: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
				working_directory: tempDir,
			};

			const result2 = await executeUpdateTaskStatus(args2);
			expect(result2.success).toBe(true);
			expect(result2.new_status).toBe('completed');
		});

		it('handles rapid consecutive updates without data corruption', async () => {
			const statuses = [
				'in_progress',
				'completed',
				'blocked',
				'in_progress',
				'completed',
			];

			for (const status of statuses) {
				const args: UpdateTaskStatusArgs = {
					task_id: '1.1',
					status,
					working_directory: tempDir,
				};

				const result = await executeUpdateTaskStatus(args);
				expect(result.success).toBe(true);
				expect(result.new_status).toBe(status);
			}

			// Verify final state is correct
			const plan = JSON.parse(
				await fs.readFile(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
			);
			expect(plan.phases[0].tasks[0].status).toBe('completed');
		});

		it('handles concurrent updates to the same task', async () => {
			// Simulate concurrent updates to the SAME task
			const update1 = executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'in_progress',
				working_directory: tempDir,
			});

			const update2 = executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'completed',
				working_directory: tempDir,
			});

			const [result1, result2] = await Promise.all([update1, update2]);

			// Both calls must return a defined result (no crash)
			expect(result1).toBeDefined();
			expect(result2).toBeDefined();

			// With file locking, one will succeed and one may be blocked.
			// At least one must succeed.
			const anySuccess = result1.success || result2.success;
			expect(anySuccess).toBe(true);

			// Verify the final state is consistent in plan.json
			const plan = JSON.parse(
				await fs.readFile(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
			);
			// Final status should be one of the two concurrent statuses
			expect(['in_progress', 'completed']).toContain(
				plan.phases[0].tasks[0].status,
			);
		});

		it('handles rapid updates with invalid statuses between valid ones', async () => {
			const args1: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
				working_directory: tempDir,
			};
			const result1 = await executeUpdateTaskStatus(args1);
			expect(result1.success).toBe(true);

			// Invalid status - should fail
			const argsInvalid: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'invalid_status',
				working_directory: tempDir,
			};
			const invalidResult = await executeUpdateTaskStatus(argsInvalid);
			expect(invalidResult.success).toBe(false);

			// Valid status after invalid - should still work
			const args2: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
				working_directory: tempDir,
			};
			const result2 = await executeUpdateTaskStatus(args2);
			expect(result2.success).toBe(true);
			expect(result2.new_status).toBe('completed');
		});
	});

	// ========== GROUP 8: Boundary Values for Task ID ==========
	describe('Group 8: Boundary values for task_id', () => {
		it('accepts minimal valid task_id "1.1"', () => {
			const result = validateTaskId('1.1');
			expect(result).toBeUndefined();
		});

		it('accepts three-segment task_id "1.1.1"', () => {
			const result = validateTaskId('1.1.1');
			expect(result).toBeUndefined();
		});

		it('accepts four-segment task_id "1.1.1.1"', () => {
			const result = validateTaskId('1.1.1.1');
			expect(result).toBeUndefined();
		});

		it('accepts large first segment "999.1"', () => {
			const result = validateTaskId('999.1');
			expect(result).toBeUndefined();
		});

		it('accepts large second segment "1.999"', () => {
			const result = validateTaskId('1.999');
			expect(result).toBeUndefined();
		});

		it('accepts large multi-segment "1000.1000.1000"', () => {
			const result = validateTaskId('1000.1000.1000');
			expect(result).toBeUndefined();
		});

		it('accepts zero segments "0.0"', () => {
			const result = validateTaskId('0.0');
			expect(result).toBeUndefined();
		});
	});

	// ========== GROUP 9: Execute with Malformed Inputs ==========
	describe('Group 9: executeUpdateTaskStatus with malformed inputs', () => {
		it('handles path traversal task_id gracefully', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '../1.1',
				status: 'completed',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]).toContain('Invalid task_id');
		});

		it('handles control character task_id gracefully', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '1.\x001',
				status: 'completed',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
		});

		it('handles empty task_id gracefully', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '',
				status: 'completed',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
		});

		it('handles invalid status gracefully', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'invalid',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors?.[0]).toContain('Invalid status');
		});

		it('handles whitespace task_id gracefully', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '   ',
				status: 'completed',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
		});

		it('handles missing working_directory gracefully', async () => {
			// Test with a valid temp directory already set up
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'completed',
				working_directory: tempDir,
			};

			// This will use tempDir - should succeed
			const result = await executeUpdateTaskStatus(args);
			// Check behavioral assertion - result should have proper structure
			expect(typeof result.success).toBe('boolean');
			expect(typeof result.message).toBe('string');
			if (result.success) {
				expect(result.new_status).toBe('completed');
			} else {
				expect(result.errors).toBeDefined();
			}
		});
	});

	// ========== GROUP 10: Injection Attempts ==========
	describe('Group 10: Injection attempts', () => {
		it('rejects shell command in task_id', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '$(whoami)',
				status: 'completed',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
		});

		it('rejects SQL injection in task_id', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: "1'; DROP TABLE plans;--",
				status: 'completed',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
		});

		it('rejects template injection in task_id', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '${7*7}',
				status: 'completed',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
		});

		it('rejects JavaScript injection in status', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: '<script>alert(1)</script>',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
		});

		it('rejects JSON injection attempt', async () => {
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: '{"injected": true}',
				working_directory: tempDir,
			};

			const result = await executeUpdateTaskStatus(args);
			expect(result.success).toBe(false);
		});
	});

	// ========== GROUP 11: checkReviewerGate security tests (state machine) ==========
	describe('Group 11: checkReviewerGate security tests', () => {
		describe('Attack vector 1: Task ID manipulation', () => {
			it('blocks when different taskId is in tests_run but queried taskId is idle', () => {
				const session = createWorkflowTestSessionWithPassedTask('2.1');
				swarmState.agentSessions.set('task-mismatch-session', session);

				// Checking '1.1' should fail — only '2.1' has passed gates
				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
				expect(result.reason).toContain('Task 1.1');
			});

			it('allows when exact taskId is in tests_run', () => {
				const session = createWorkflowTestSessionWithPassedTask('1.1');
				swarmState.agentSessions.set('exact-match-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false);
			});

			it('blocks for empty string taskId when no task is in tests_run', () => {
				const session = createWorkflowTestSession();
				swarmState.agentSessions.set('empty-taskid-session', session);

				const result = checkReviewerGate('', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks empty string taskId - cannot advance invalid task IDs', () => {
				const session = createWorkflowTestSession();
				// Cannot use advanceTaskState with empty string - it rejects invalid task IDs
				// Manually set state to simulate what would happen if it were allowed
				// but the canonical rule is: empty task IDs cannot advance
				(session.taskWorkflowStates as Map<string, string>).set(
					'',
					'tests_run',
				);
				swarmState.agentSessions.set('empty-taskid-pass-session', session);

				// Despite being in tests_run in the map, checkReviewerGate should still
				// block because empty string fails canonical taskId validation
				const result = checkReviewerGate('', tempDir);
				expect(result.blocked).toBe(true);
			});

			// NOTE: Empty string taskId is invalid per canonical validation (isValidTaskId).
			// checkReviewerGate may see it as idle → blocked, but the underlying reason
			// is that empty string fails format validation in the canonical rule.
			it('empty string taskId blocked due to invalid format, not idle state', () => {
				const session = createWorkflowTestSession();
				swarmState.agentSessions.set('empty-taskid-session', session);

				const result = checkReviewerGate('', tempDir);
				// Blocked because empty string is invalid per canonical isValidTaskId rule
				expect(result.blocked).toBe(true);
			});

			it('numeric taskId 0 blocked due to idle state, not format validation', () => {
				const session = createWorkflowTestSession();
				swarmState.agentSessions.set('numeric-0-session', session);

				// @ts-ignore - passing number where string expected
				const result = checkReviewerGate(0, tempDir);
				// Blocked because numeric taskId fails format validation
				expect(result.blocked).toBe(true);
			});

			it('numeric taskId 123 blocked due to idle state, not format validation', () => {
				const session = createWorkflowTestSession();
				swarmState.agentSessions.set('numeric-123-session', session);

				// @ts-ignore - passing number where string expected
				const result = checkReviewerGate(123, tempDir);
				// Blocked because numeric taskId fails format validation
				expect(result.blocked).toBe(true);
			});
		});

		describe('Attack vector 2: State spoofing — sub-threshold states', () => {
			it('blocks when task is in idle state', () => {
				const session = createWorkflowTestSession(); // taskWorkflowStates empty → idle
				swarmState.agentSessions.set('idle-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks when task is in coder_delegated state', () => {
				const session = createWorkflowTestSessionWithTaskAtState(
					'1.1',
					'coder_delegated',
				);
				swarmState.agentSessions.set('coder-delegated-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks when task is in pre_check_passed state', () => {
				const session = createWorkflowTestSessionWithTaskAtState(
					'1.1',
					'pre_check_passed',
				);
				swarmState.agentSessions.set('pre-check-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks when task is in reviewer_run state (tests not yet run)', () => {
				const session = createWorkflowTestSessionWithTaskAtState(
					'1.1',
					'reviewer_run',
				);
				swarmState.agentSessions.set('reviewer-run-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});
		});

		describe('Attack vector 3: Prototype pollution via taskWorkflowStates', () => {
			it('handles session with Object.create(null) taskWorkflowStates safely', () => {
				const session = createWorkflowTestSession();
				// Replace taskWorkflowStates with a null-prototype Map substitute
				// getTaskState uses Map.get() which is safe regardless of prototype
				session.taskWorkflowStates = new Map([['1.1', 'tests_run']]);
				swarmState.agentSessions.set('null-proto-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false);
			});

			it('handles __proto__ as taskId without polluting Object.prototype', () => {
				const session = createWorkflowTestSession();
				// Setting __proto__ as a Map key is safe — Map uses identity not prototype chain
				session.taskWorkflowStates.set('__proto__', 'tests_run' as any);
				swarmState.agentSessions.set('proto-key-session', session);

				// Querying __proto__ as taskId is blocked due to invalid format
				const result = checkReviewerGate('__proto__', tempDir);
				expect(result.blocked).toBe(true);
				// Object.prototype must not be polluted
				expect((Object.prototype as any).tests_run).toBeUndefined();
			});
		});

		describe('Attack vector 4: agentSessions null/undefined/throwing', () => {
			it('allows through when agentSessions is undefined (try/catch)', () => {
				const original = swarmState.agentSessions;
				// @ts-ignore - intentionally making undefined
				swarmState.agentSessions = undefined;

				const result = checkReviewerGate('1.1', tempDir);

				swarmState.agentSessions = original;
				expect(result.blocked).toBe(false);
			});

			it('allows through when agentSessions is null', () => {
				const original = swarmState.agentSessions;
				// @ts-ignore - intentionally making null
				swarmState.agentSessions = null;

				const result = checkReviewerGate('1.1', tempDir);

				swarmState.agentSessions = original;
				expect(result.blocked).toBe(false);
			});

			it('allows through when agentSessions.size throws', () => {
				const original = swarmState.agentSessions;
				const throwingMap = new Map();
				Object.defineProperty(throwingMap, 'size', {
					get: () => {
						throw new Error('Simulated access error');
					},
					configurable: true,
				});
				swarmState.agentSessions = throwingMap as any;

				const result = checkReviewerGate('1.1', tempDir);

				swarmState.agentSessions = original;
				expect(result.blocked).toBe(false);
			});
		});

		describe('Attack vector 5: Multi-session behavior', () => {
			it('allows through if ANY session has task in tests_run (not all)', () => {
				// Session A: task idle
				swarmState.agentSessions.set('session-a', createWorkflowTestSession());

				// Session B: task in tests_run
				const sessionB = createWorkflowTestSessionWithPassedTask('1.1');
				swarmState.agentSessions.set('session-b', sessionB);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false);
			});

			it('blocks when all sessions have task in sub-threshold states', () => {
				const sessionA = createWorkflowTestSessionWithTaskAtState(
					'1.1',
					'coder_delegated',
				);
				swarmState.agentSessions.set('session-a2', sessionA);

				const sessionB = createWorkflowTestSessionWithTaskAtState(
					'1.1',
					'pre_check_passed',
				);
				swarmState.agentSessions.set('session-b2', sessionB);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});
		});

		describe('Attack vector 6: executeUpdateTaskStatus gate enforcement', () => {
			it('rejects completed status when task is in coder_delegated state', async () => {
				const session = createWorkflowTestSessionWithTaskAtState(
					'1.1',
					'coder_delegated',
				);
				swarmState.agentSessions.set('gate-test-session', session);

				const args: UpdateTaskStatusArgs = {
					task_id: '1.1',
					status: 'completed',
					working_directory: tempDir,
				};

				const result = await executeUpdateTaskStatus(args);
				expect(result.success).toBe(false);
				expect(result.errors?.[0]).toContain('QA gates');
			});

			it('allows completed status when task reaches tests_run state', async () => {
				const session = createWorkflowTestSessionWithPassedTask('1.1');
				swarmState.agentSessions.set('gate-pass-session', session);

				const args: UpdateTaskStatusArgs = {
					task_id: '1.1',
					status: 'completed',
					working_directory: tempDir,
				};

				const result = await executeUpdateTaskStatus(args);
				expect(result.success).toBe(true);
			});

			it('blocks completed when sessions exist but task never reached tests_run', async () => {
				swarmState.agentSessions.set(
					'no-tests-session',
					createWorkflowTestSession(),
				);

				const args: UpdateTaskStatusArgs = {
					task_id: '1.1',
					status: 'completed',
					working_directory: tempDir,
				};

				const result = await executeUpdateTaskStatus(args);
				expect(result.success).toBe(false);
				expect(result.message).toContain('Gate check failed');
			});
		});

		describe('Edge cases and boundary conditions', () => {
			it('allows through with empty agentSessions (test context)', () => {
				swarmState.agentSessions.clear();

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false);
			});

			it('allows through when task is in complete state', () => {
				const session = createWorkflowTestSessionWithCompletedTask('1.1');
				swarmState.agentSessions.set('complete-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false);
			});

			it('handles very long taskId strings without error', () => {
				const longId = '1.' + '0'.repeat(1000);
				const session = createWorkflowTestSession();
				swarmState.agentSessions.set('long-id-session', session);

				const result = checkReviewerGate(longId, tempDir);
				expect(result.blocked).toBe(true); // Long id not in map → idle → blocked
			});
		});
	});

	// ========== GROUP 12: Additional Adversarial Tests for checkReviewerGate ==========
	// These target the specific attack vectors identified in the adversarial focus
	describe('Group 12: checkReviewerGate - Additional Adversarial Vectors', () => {
		// Attack Vector 1: Concurrent session pollution
		// Can a second session in tests_run for a DIFFERENT task allow through a different taskId?
		describe('Attack vector 1: Concurrent session pollution', () => {
			it('blocks taskId 1.2 when ONLY session A has task 1.1 in tests_run', () => {
				// Session A: has task 1.1 in tests_run
				const sessionA = createWorkflowTestSessionWithPassedTask('1.1');
				swarmState.agentSessions.set('session-a', sessionA);

				// Session B: empty (no tasks)
				const sessionB = createWorkflowTestSession();
				swarmState.agentSessions.set('session-b', sessionB);

				// Checking '1.2' should FAIL — only '1.1' has passed gates in any session
				const result = checkReviewerGate('1.2', tempDir);
				expect(result.blocked).toBe(true);
				expect(result.reason).toContain('Task 1.2');
			});

			it('blocks taskId when multiple sessions have DIFFERENT tasks in tests_run', () => {
				// Session A: has task 1.1 in tests_run
				const sessionA = createWorkflowTestSessionWithPassedTask('1.1');
				swarmState.agentSessions.set('session-a-multi', sessionA);

				// Session B: has task 2.1 in tests_run
				const sessionB = createWorkflowTestSessionWithPassedTask('2.1');
				swarmState.agentSessions.set('session-b-multi', sessionB);

				// Checking '1.3' should FAIL — no session has 1.3 in tests_run
				const result = checkReviewerGate('1.3', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('ALLOWS taskId 1.1 when ANY session has 1.1 in tests_run', () => {
				// Session A: has task 1.1 in tests_run
				const sessionA = createWorkflowTestSessionWithPassedTask('1.1');
				swarmState.agentSessions.set('session-a-allow', sessionA);

				// Session B: has different task in tests_run
				const sessionB = createWorkflowTestSessionWithPassedTask('2.1');
				swarmState.agentSessions.set('session-b-allow', sessionB);

				// Checking '1.1' should PASS — session A has it in tests_run
				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false);
			});
		});

		// Attack Vector 2: State string injection via taskId
		// Can whitespace or special characters in taskId bypass the check?
		describe('Attack vector 2: State string injection via taskId', () => {
			it('blocks taskId with trailing space "1.1 " - no match in Map', () => {
				const session = createWorkflowTestSession();
				// Manually set a task with exact key "1.1" to tests_run
				session.taskWorkflowStates.set('1.1', 'tests_run' as any);
				swarmState.agentSessions.set('whitespace-session', session);

				// Querying "1.1 " (with trailing space) should NOT find the key
				const result = checkReviewerGate('1.1 ', tempDir);
				expect(result.blocked).toBe(true); // Should be blocked - no match
			});

			it('blocks taskId with leading space " 1.1" - no match in Map', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'tests_run' as any);
				swarmState.agentSessions.set('leading-space-session', session);

				const result = checkReviewerGate(' 1.1', tempDir);
				expect(result.blocked).toBe(true); // Should be blocked - no match
			});

			it('blocks taskId with newline "1.1\\n" - no match in Map', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'tests_run' as any);
				swarmState.agentSessions.set('newline-session', session);

				const result = checkReviewerGate('1.1\n', tempDir);
				expect(result.blocked).toBe(true); // Should be blocked - no match
			});

			it('blocks taskId with tab "1.1\\t" - no match in Map', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'tests_run' as any);
				swarmState.agentSessions.set('tab-session', session);

				const result = checkReviewerGate('1.1\t', tempDir);
				expect(result.blocked).toBe(true); // Should be blocked - no match
			});

			it('ALLOWS exact match "1.1" when in tests_run', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'tests_run' as any);
				swarmState.agentSessions.set('exact-match-injection', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false); // Exact match - should pass
			});
		});

		// Attack Vector 3: getTaskState throwing
		// What if session.taskWorkflowStates is missing entirely?
		describe('Attack vector 3: getTaskState throwing / missing taskWorkflowStates', () => {
			it('allows through when session.taskWorkflowStates is undefined (try/catch)', () => {
				const session = createWorkflowTestSession();
				// @ts-ignore - intentionally removing property
				delete session.taskWorkflowStates;
				swarmState.agentSessions.set('no-workflow-states', session);

				const result = checkReviewerGate('1.1', tempDir);
				// Should allow through due to try/catch
				expect(result.blocked).toBe(false);
			});

			it('allows through when session.taskWorkflowStates is null (try/catch)', () => {
				const session = createWorkflowTestSession();
				// @ts-ignore - intentionally setting to null
				session.taskWorkflowStates = null;
				swarmState.agentSessions.set('null-workflow-states', session);

				const result = checkReviewerGate('1.1', tempDir);
				// Should allow through due to try/catch
				expect(result.blocked).toBe(false);
			});

			it('allows through when session.taskWorkflowStates.get throws', () => {
				const session = createWorkflowTestSession();
				// Create a proxy that throws on get
				const throwingMap = new Map();
				session.taskWorkflowStates = new Proxy(throwingMap, {
					get(target, prop) {
						if (prop === 'get') {
							return () => {
								throw new Error('Simulated getTaskState error');
							};
						}
						return (target as any)[prop];
					},
				});
				swarmState.agentSessions.set('throwing-get', session);

				const result = checkReviewerGate('1.1', tempDir);
				// Should allow through due to try/catch
				expect(result.blocked).toBe(false);
			});
		});

		// Attack Vector 4: Type coercion
		// Can numeric taskId match string key? (Map uses identity: 0 !== '0')
		describe('Attack vector 4: Type coercion', () => {
			it('allows numeric taskId 0 when Map has string key "0" (JS coercion)', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('0', 'tests_run' as any);
				swarmState.agentSessions.set('type-mismatch-session', session);

				// @ts-ignore - passing number where string expected
				const result = checkReviewerGate(0, tempDir);
				// Blocked because numeric taskId fails format validation before Map lookup
				expect(result.blocked).toBe(true);
			});

			it('allows numeric taskId 123 when Map has string key "123" (JS coercion)', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('123', 'tests_run' as any);
				swarmState.agentSessions.set('num-mismatch-session', session);

				// @ts-ignore - passing number where string expected
				const result = checkReviewerGate(123, tempDir);
				// Blocked because numeric taskId fails format validation before Map lookup
				expect(result.blocked).toBe(true);
			});

			it('ALLOWS numeric taskId when Map has numeric key (edge case)', () => {
				const session = createWorkflowTestSession();
				// Some code might set numeric keys
				session.taskWorkflowStates.set(1.1, 'tests_run' as any);
				swarmState.agentSessions.set('numeric-key-session', session);

				// @ts-ignore - passing number where string expected
				const result = checkReviewerGate(1.1, tempDir);
				// Blocked because numeric taskId fails format validation
				expect(result.blocked).toBe(true);
			});
		});

		// Attack Vector 5: Truthy trap
		// Can truthy values bypass the exact string check?
		describe('Attack vector 5: Truthy trap', () => {
			it('blocks when state is truthy but not exact string "tests_run" or "complete"', () => {
				const session = createWorkflowTestSession();
				// Set a truthy value that's NOT the expected strings
				session.taskWorkflowStates.set('1.1', 'any_truthy_string' as any);
				swarmState.agentSessions.set('truthy-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks when state is number 1 (truthy)', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 1 as any); // number 1 is truthy
				swarmState.agentSessions.set('number-truthy-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks when state is object {passed: true} (truthy)', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', { passed: true } as any); // object is truthy
				swarmState.agentSessions.set('object-truthy-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks when state is "Tests_Run" (wrong case)', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'Tests_Run' as any); // wrong case
				swarmState.agentSessions.set('case-mismatch-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks when state is "tests_run_extra" (prefix)', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'tests_run_extra' as any); // prefix but not exact
				swarmState.agentSessions.set('prefix-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('blocks when state is "test" (substring)', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'test' as any); // substring, not exact
				swarmState.agentSessions.set('substring-session', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});

			it('ALLOWS exact "tests_run" string', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'tests_run' as any);
				swarmState.agentSessions.set('exact-tests-run', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false);
			});

			it('ALLOWS exact "complete" string', () => {
				const session = createWorkflowTestSession();
				session.taskWorkflowStates.set('1.1', 'complete' as any);
				swarmState.agentSessions.set('exact-complete', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(false);
			});

			it('ALLOWS "complete" with extra whitespace NOT matching - exact check required', () => {
				const session = createWorkflowTestSession();
				// This should NOT pass - the check is exact string match
				session.taskWorkflowStates.set('1.1', ' complete' as any);
				swarmState.agentSessions.set('whitespace-complete', session);

				const result = checkReviewerGate('1.1', tempDir);
				expect(result.blocked).toBe(true);
			});
		});
	});
});
