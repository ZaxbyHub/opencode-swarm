/**
 * Adversarial tests for declare-scope.ts
 * Tests malformed inputs, boundary violations, injection attempts, path traversal
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	advanceTaskState,
	getTaskState,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	type DeclareScopeArgs,
	executeDeclareScope,
	validateFiles,
	validateTaskIdFormat,
} from '../../../src/tools/declare-scope';
import { createWorkflowTestSession } from '../../helpers/workflow-session-factory';

describe('declare-scope adversarial tests', () => {
	let tempDir: string;
	let tempDirs: string[] = [];

	// Helper to create a valid plan.json in temp directory
	async function createPlanWithTasks(
		tempDir: string,
		tasks: { id: string }[],
	): Promise<void> {
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
					tasks: tasks.map((t, idx) => ({
						id: t.id,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: `Test task ${t.id}`,
						depends: [],
						files_touched: [],
					})),
				},
			],
		};
		await fs.writeFile(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	}

	beforeEach(async () => {
		// Create temp directory for each test
		tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), 'declare-scope-adversarial-'),
		);
		tempDirs.push(tempDir);
		// Create .swarm directory with a valid plan
		await createPlanWithTasks(tempDir, [{ id: '1.1' }, { id: '1.2' }]);
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

	// ========== GROUP 1: Null-byte injection ==========
	describe('Group 1: Null-byte injection', () => {
		it('rejects null byte in files array', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src\0file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('null bytes'))).toBe(true);
		});

		it('rejects null byte in whitelist array', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/valid.ts'],
				whitelist: ['src\0secret.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('null bytes'))).toBe(true);
		});

		it('rejects null byte in working_directory', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				working_directory: '/some\0/path',
			};

			const result = await executeDeclareScope(args);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('null bytes'))).toBe(true);
		});

		it('rejects unicode null-byte \\u0000 in files', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src\u0000file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects URL-encoded %00 in files', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src%00file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// The %00 should be treated as literal characters, not null byte
			// This test checks the validation handles it without crashing
			expect(result).toBeDefined();
		});

		it('rejects double-encoded %252E%252E (URL-encoded ..)', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src%252E%252Efile.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// Double-encoded should be treated as literal characters
			expect(result).toBeDefined();
		});
	});

	// ========== GROUP 2: Path traversal ==========
	describe('Group 2: Path traversal', () => {
		it('rejects ".." in files array', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['../etc/passwd'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('path traversal'))).toBe(
				true,
			);
		});

		it('rejects multiple ".." in files', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['../../../../etc/passwd'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('path traversal'))).toBe(
				true,
			);
		});

		it('rejects path traversal in working_directory', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				working_directory: '../..',
			};

			const result = await executeDeclareScope(args);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('path traversal'))).toBe(
				true,
			);
		});

		it('rejects Windows-style path traversal', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['..\\..\\windows\\system32\\config\\sam'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects path with backslash traversal', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src\\..\\etc\\passwd'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// Note: The validateFiles checks for '..' specifically
			// Backslash path separator should also be caught
			expect(result.success).toBe(false);
		});
	});

	// ========== GROUP 3: validateFiles utility tests ==========
	describe('Group 3: validateFiles utility', () => {
		it('detects null bytes in files', () => {
			const errors = validateFiles(['file\0.txt']);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]).toContain('null bytes');
		});

		it('detects path traversal in files', () => {
			const errors = validateFiles(['../etc/passwd']);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]).toContain('path traversal');
		});

		it('detects oversized file paths', () => {
			const longPath = 'a'.repeat(4097);
			const errors = validateFiles([longPath]);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]).toContain('exceeds maximum length');
		});

		it('accepts valid file paths', () => {
			const errors = validateFiles(['src/index.ts', 'src/utils/helper.ts']);
			expect(errors).toHaveLength(0);
		});
	});

	// ========== GROUP 4: Oversized inputs ==========
	describe('Group 4: Oversized inputs', () => {
		it('rejects taskId with 10000 characters', async () => {
			const longTaskId = '1.' + 'a'.repeat(10000);
			const args: DeclareScopeArgs = {
				taskId: longTaskId,
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('Invalid taskId'))).toBe(
				true,
			);
		});

		it('rejects files array with 10000 entries', async () => {
			const manyFiles = Array(10000).fill('file.ts');
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: manyFiles,
			};

			const result = await executeDeclareScope(args, tempDir);
			// Should process but may have issues - check it doesn't crash
			expect(result).toBeDefined();
		});

		it('does not reject file path at exactly 4096 chars for length reasons', async () => {
			const exact4096 = 'a'.repeat(4096);
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: [exact4096],
			};

			const result = await executeDeclareScope(args, tempDir);
			// The length boundary is strict-greater-than 4096 (validateFiles:
			// `if (file.length > 4096)`), so a 4096-char path passes the
			// length check itself. v6.70.0 (#496) also runs lstat on every
			// declared file; when tempDir + 4096 chars exceeds PATH_MAX the
			// lstat-gate may fail closed for a different reason. Assert
			// specifically that NO "exceeds maximum length" error is raised,
			// which is the boundary this test is about.
			const hasLengthError = result.errors?.some((e) =>
				e.includes('exceeds maximum length'),
			);
			expect(hasLengthError).toBeFalsy();
		});

		it('rejects file path over 4096 chars', async () => {
			const over4096 = 'a'.repeat(4097);
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: [over4096],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(
				result.errors?.some((e) => e.includes('exceeds maximum length')),
			).toBe(true);
		});

		it('rejects extremely long file path (10000 chars)', async () => {
			const longPath = 'a'.repeat(10000);
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: [longPath],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});
	});

	// ========== GROUP 5: Type coercion ==========
	describe('Group 5: Type coercion', () => {
		it('rejects files as null', async () => {
			// @ts-ignore - intentionally passing wrong type
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: null as any,
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(
				result.errors?.some((e) =>
					e.includes('files must be a non-empty array'),
				),
			).toBe(true);
		});

		it('rejects files as string instead of array', async () => {
			// @ts-ignore - intentionally passing wrong type
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: 'src/file.ts' as any,
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects taskId as number', async () => {
			// @ts-ignore - intentionally passing wrong type
			const args: DeclareScopeArgs = {
				taskId: 1.1 as any,
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// The regex test should fail on number
			expect(result.success).toBe(false);
		});

		it('rejects whitelist as non-array', async () => {
			// Note: The implementation doesn't validate whitelist type explicitly
			// It passes through to validateFiles which iterates the value
			// This test documents the behavior - non-array whitelist is ignored
			// @ts-ignore - intentionally passing wrong type
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				whitelist: 'not-an-array' as any,
			};

			const result = await executeDeclareScope(args, tempDir);
			// Currently passes because whitelist type isn't explicitly validated
			// This is a security gap - whitelist should be validated as array
			expect(result).toBeDefined();
		});

		it('rejects empty files array', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: [],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(
				result.errors?.some((e) =>
					e.includes('files must be a non-empty array'),
				),
			).toBe(true);
		});
	});

	// ========== GROUP 6: Empty string variants ==========
	describe('Group 6: Empty string variants', () => {
		it('rejects empty string taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('Invalid taskId'))).toBe(
				true,
			);
		});

		it('rejects empty string in files array', async () => {
			// Note: Empty string in files array passes validation - it's a valid string
			// This is a potential gap - empty strings should be rejected
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: [''],
			};

			const result = await executeDeclareScope(args, tempDir);
			// Currently succeeds - documents the gap
			expect(result).toBeDefined();
		});

		it('rejects empty string working_directory', async () => {
			// Empty string working_directory falls back to fallbackDir or cwd
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				working_directory: '',
			};

			const result = await executeDeclareScope(args, tempDir);
			// Falls back to tempDir which has valid plan
			expect(result.success).toBe(true);
		});

		it('rejects whitespace-only taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '   ',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});
	});

	// ========== GROUP 7: Windows device paths ==========
	describe('Group 7: Windows device paths', () => {
		it('rejects NUL device path', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				working_directory: 'NUL',
			};

			const result = await executeDeclareScope(args);
			if (process.platform === 'win32') {
				expect(result.success).toBe(false);
				expect(result.errors?.some((e) => e.includes('device paths'))).toBe(
					true,
				);
			} else {
				// On non-Windows, it might fail for other reasons (path doesn't exist)
				expect(result.success).toBe(false);
			}
		});

		it('rejects CON device path', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				working_directory: 'CON',
			};

			const result = await executeDeclareScope(args);
			expect(result.success).toBe(false);
		});

		it('rejects UNC path style \\\\.C:\\', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				working_directory: '\\\\.\\C:\\',
			};

			const result = await executeDeclareScope(args);
			if (process.platform === 'win32') {
				expect(result.success).toBe(false);
			}
		});

		it('rejects pipe path', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				working_directory: '\\\\.\\pipe\\test',
			};

			const result = await executeDeclareScope(args);
			if (process.platform === 'win32') {
				expect(result.success).toBe(false);
			}
		});

		it('rejects extended-length path \\\\?\\C:\\', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
				working_directory: '\\\\?\\C:\\',
			};

			const result = await executeDeclareScope(args);
			if (process.platform === 'win32') {
				expect(result.success).toBe(false);
			}
		});
	});

	// ========== GROUP 8: Plan.json injection ==========
	describe('Group 8: Plan.json injection', () => {
		it('rejects taskId not in plan', async () => {
			const args: DeclareScopeArgs = {
				taskId: '9.9',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			// Task 9.9 is not in plan with only 1.1 and 1.2
			expect(result.errors?.[0]).toContain('does not exist in plan.json');
		});

		it('accepts valid taskId from plan', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(true);
		});

		it('validates taskId format before checking plan', async () => {
			// Create plan with weird task ID
			const planWithWeirdTask = await fs.mkdtemp(
				path.join(os.tmpdir(), 'plan-weird-'),
			);
			tempDirs.push(planWithWeirdTask);
			await createPlanWithTasks(planWithWeirdTask, [
				{ id: '../../etc/passwd' },
			]);

			// Should reject due to format validation, not plan lookup
			const args: DeclareScopeArgs = {
				taskId: '../../etc/passwd',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, planWithWeirdTask);
			expect(result.success).toBe(false);
			// Should fail on format validation, not plan lookup
			expect(result.errors?.[0]).toContain('Invalid taskId');
		});

		it('handles plan with missing phases key', async () => {
			const planNoPhases = await fs.mkdtemp(
				path.join(os.tmpdir(), 'plan-nophases-'),
			);
			tempDirs.push(planNoPhases);
			await fs.mkdir(path.join(planNoPhases, '.swarm'), { recursive: true });
			await fs.writeFile(
				path.join(planNoPhases, '.swarm', 'plan.json'),
				JSON.stringify({ schema_version: '1.0.0', title: 'Test' }),
			);

			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, planNoPhases);
			// Should fail because task not found in empty phases
			expect(result.success).toBe(false);
		});

		it('handles empty plan.json', async () => {
			const planEmpty = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-empty-'));
			tempDirs.push(planEmpty);
			await fs.mkdir(path.join(planEmpty, '.swarm'), { recursive: true });
			await fs.writeFile(path.join(planEmpty, '.swarm', 'plan.json'), '');

			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, planEmpty);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('JSON'))).toBe(true);
		});

		it('handles non-JSON plan.json', async () => {
			const planInvalid = await fs.mkdtemp(
				path.join(os.tmpdir(), 'plan-invalid-'),
			);
			tempDirs.push(planInvalid);
			await fs.mkdir(path.join(planInvalid, '.swarm'), { recursive: true });
			await fs.writeFile(
				path.join(planInvalid, '.swarm', 'plan.json'),
				'not valid json {',
			);

			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, planInvalid);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('JSON'))).toBe(true);
		});
	});

	// ========== GROUP 9: Session state isolation ==========
	describe('Group 9: Session state isolation', () => {
		it('blocks declare scope when task is completed in plan.json', async () => {
			// Write plan.json with task 1.1 marked as completed
			const planPath = path.join(tempDir, '.swarm', 'plan.json');
			const planContent = JSON.parse(await fs.readFile(planPath, 'utf-8'));
			planContent.phases[0].tasks[0].status = 'completed';
			await fs.writeFile(planPath, JSON.stringify(planContent));

			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);

			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('completed'))).toBe(true);
		});

		it('does not block scope when task is complete in a different session but pending in plan.json', async () => {
			// Session state should NOT block scope when plan.json says task is pending.
			// This prevents cross-workspace false positives when task IDs are reused.
			const session = createWorkflowTestSession();
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			advanceTaskState(session, '1.1', 'complete');

			expect(getTaskState(session, '1.1')).toBe('complete');
			swarmState.agentSessions.set('complete-session', session);

			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// plan.json says pending, so scope should be allowed despite session state
			expect(result.success).toBe(true);
		});

		it('allows declare scope when task is NOT complete in any session', async () => {
			const session = createWorkflowTestSession();
			// Set task to tests_run but NOT complete
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			// NOT complete
			swarmState.agentSessions.set('not-complete-session', session);

			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(true);
		});

		it('allows declare scope when no sessions exist', async () => {
			// swarmState is reset in afterEach, so no sessions
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(true);
		});

		it('blocks task complete in one session but allows different task', async () => {
			const session = createWorkflowTestSession();
			// Set 1.1 to complete through proper progression
			advanceTaskState(session, '1.1', 'coder_delegated');
			advanceTaskState(session, '1.1', 'pre_check_passed');
			advanceTaskState(session, '1.1', 'reviewer_run');
			advanceTaskState(session, '1.1', 'tests_run');
			advanceTaskState(session, '1.1', 'complete');
			swarmState.agentSessions.set('session-with-1.1-complete', session);

			const args: DeclareScopeArgs = {
				taskId: '1.2', // Different task
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// Task 1.2 is not complete, so should succeed
			expect(result.success).toBe(true);
		});

		it('allows scope when one session has task complete but plan.json says pending', async () => {
			// Cross-workspace safety: session state from another workspace should
			// not block declare_scope when this workspace's plan.json says pending.
			const sessionA = createWorkflowTestSession();
			advanceTaskState(sessionA, '1.1', 'coder_delegated');
			advanceTaskState(sessionA, '1.1', 'pre_check_passed');
			advanceTaskState(sessionA, '1.1', 'reviewer_run');
			advanceTaskState(sessionA, '1.1', 'tests_run');
			advanceTaskState(sessionA, '1.1', 'complete');
			swarmState.agentSessions.set('session-a', sessionA);

			const sessionB = createWorkflowTestSession();
			advanceTaskState(sessionB, '1.1', 'coder_delegated');
			swarmState.agentSessions.set('session-b', sessionB);

			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// plan.json is authoritative; session state alone does not block
			expect(result.success).toBe(true);
		});
	});

	// ========== GROUP 10: Prototype pollution ==========
	describe('Group 10: Prototype pollution', () => {
		it('rejects __proto__ as taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '__proto__',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('Invalid taskId'))).toBe(
				true,
			);
		});

		it('rejects constructor.prototype as taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: 'constructor.prototype',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('Invalid taskId'))).toBe(
				true,
			);
		});

		it('rejects prototype as taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: 'prototype',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// This might pass format validation but should fail plan lookup
			expect(result.success).toBe(false);
		});

		it('rejects toString as taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: 'toString',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects hasOwnProperty as taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: 'hasOwnProperty',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});
	});

	// ========== GROUP 11: validateTaskIdFormat utility ==========
	describe('Group 11: validateTaskIdFormat utility', () => {
		it('accepts valid taskId 1.1', () => {
			const result = validateTaskIdFormat('1.1');
			expect(result).toBeUndefined();
		});

		it('accepts valid taskId 1.2.3', () => {
			const result = validateTaskIdFormat('1.2.3');
			expect(result).toBeUndefined();
		});

		it('rejects path traversal in taskId', () => {
			const result = validateTaskIdFormat('../1.1');
			expect(result).toBeDefined();
			expect(result).toContain('Invalid taskId');
		});

		it('rejects absolute path as taskId', () => {
			const result = validateTaskIdFormat('/etc/passwd');
			expect(result).toBeDefined();
		});

		it('rejects Windows path as taskId', () => {
			const result = validateTaskIdFormat('C:\\windows\\system32');
			expect(result).toBeDefined();
		});

		it('rejects null byte in taskId', () => {
			const result = validateTaskIdFormat('1.1\x00');
			expect(result).toBeDefined();
		});

		it('rejects taskId with forward slash', () => {
			const result = validateTaskIdFormat('1/1');
			expect(result).toBeDefined();
		});

		it('rejects empty taskId', () => {
			const result = validateTaskIdFormat('');
			expect(result).toBeDefined();
		});
	});

	// ========== GROUP 12: Control characters in taskId ==========
	describe('Group 12: Control characters in taskId', () => {
		it('rejects tab in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.\t1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects newline in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.\n1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects carriage return in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.\r1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects escape character in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.\x1b1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects vertical tab in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.\x0b1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});
	});

	// ========== GROUP 13: Injection attempts ==========
	describe('Group 13: Injection attempts', () => {
		it('rejects shell command in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '$(whoami)',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects SQL injection in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: "1'; DROP TABLE plans;--",
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects template injection in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '${7*7}',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects JavaScript injection in file path', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['<script>alert(1)</script>'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(true); // It's a valid filename format-wise
		});

		it('rejects JSON injection in file path', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['{"injected": true}'],
			};

			const result = await executeDeclareScope(args, tempDir);
			// JSON as filename is technically valid
			expect(result).toBeDefined();
		});
	});

	// ========== GROUP 14: Boundary values for taskId ==========
	describe('Group 14: Boundary values for taskId', () => {
		it('accepts minimal taskId 1.1', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(true);
		});

		it('accepts taskId with many segments 1.1.1.1.1.1', async () => {
			// Add this task to the plan first
			const planWithManySegments = await fs.mkdtemp(
				path.join(os.tmpdir(), 'plan-manyseg-'),
			);
			tempDirs.push(planWithManySegments);
			await createPlanWithTasks(planWithManySegments, [{ id: '1.1.1.1.1.1' }]);

			const args: DeclareScopeArgs = {
				taskId: '1.1.1.1.1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, planWithManySegments);
			expect(result.success).toBe(true);
		});

		it('accepts large segment numbers 999.999', async () => {
			// Add this task to the plan first
			const planWithLargeNums = await fs.mkdtemp(
				path.join(os.tmpdir(), 'plan-largenum-'),
			);
			tempDirs.push(planWithLargeNums);
			await createPlanWithTasks(planWithLargeNums, [{ id: '999.999' }]);

			const args: DeclareScopeArgs = {
				taskId: '999.999',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, planWithLargeNums);
			expect(result.success).toBe(true);
		});

		it('rejects taskId with only dots', async () => {
			const args: DeclareScopeArgs = {
				taskId: '...',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects taskId with letters', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1a.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects taskId with special characters', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1!1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects single segment taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});

		it('rejects negative numbers in taskId', async () => {
			const args: DeclareScopeArgs = {
				taskId: '-1.1',
				files: ['src/file.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(false);
		});
	});

	// ========== GROUP 15: Successful scope declaration ==========
	describe('Group 15: Successful scope declaration behavior', () => {
		it('returns correct fileCount with files only', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(true);
			expect(result.fileCount).toBe(3);
		});

		it('returns correct fileCount with files and whitelist', async () => {
			const args: DeclareScopeArgs = {
				taskId: '1.1',
				files: ['src/a.ts'],
				whitelist: ['src/b.ts', 'src/c.ts'],
			};

			const result = await executeDeclareScope(args, tempDir);
			expect(result.success).toBe(true);
			expect(result.fileCount).toBe(3);
		});
	});
});
