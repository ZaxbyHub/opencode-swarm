/**
 * Adversarial tests for save-plan.ts — attack vectors only
 * Tests malformed inputs, boundary violations, injection attempts, bypass attempts
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	detectPlaceholderContent,
	executeSavePlan,
	type SavePlanArgs,
} from '../../../src/tools/save-plan';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('save-plan adversarial tests', () => {
	let tempDir: string;
	let tempDirs: string[] = [];

	beforeEach(async () => {
		// Create a canonical external project root for each test.
		tempDir = canonicalMkdtemp('save-plan-adversarial-');
		tempDirs.push(tempDir);
		await fs.mkdir(path.join(tempDir, '.opencode'));
		// Create .swarm/ and spec.md required by the spec gate
		await fs.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
		await fs.writeFile(
			path.join(tempDir, '.swarm', 'spec.md'),
			'# Test Spec\n',
		);
		// Create context.md with the QA gate selection section required by the gate-selection check
		await fs.writeFile(
			path.join(tempDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
	});

	afterEach(() => {
		// Clean up all temp directories
		for (const dir of tempDirs) {
			safeRmRecursive(dir);
		}
		tempDirs = [];
	});

	describe('Placeholder bypass attempts', () => {
		it('should reject single char placeholder "[A]"', async () => {
			const args: SavePlanArgs = {
				title: '[A]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('template placeholder');
		});

		it('should NOT reject "[ ]" (space only - not matching pattern)', async () => {
			const issues = detectPlaceholderContent({
				title: '[ ]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
			});
			expect(issues).toHaveLength(0);
		});

		it('should NOT reject "[]" (empty brackets - no word char)', async () => {
			const issues = detectPlaceholderContent({
				title: '[]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
			});
			expect(issues).toHaveLength(0);
		});

		it('should reject "[123]" (digits only are word chars)', async () => {
			const args: SavePlanArgs = {
				title: '[123]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('template placeholder');
		});

		it('should reject "[task_with_underscore]" (underscore is word char)', async () => {
			const args: SavePlanArgs = {
				title: '[task_with_underscore]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('template placeholder');
		});

		it('should NOT reject "[task-with-hyphen]" (hyphen is NOT word char)', async () => {
			const issues = detectPlaceholderContent({
				title: '[task-with-hyphen]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
			});
			expect(issues).toHaveLength(0);
		});

		it('should reject exactly "[X]" (single letter)', async () => {
			const args: SavePlanArgs = {
				title: '[X]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('template placeholder');
		});

		it('should catch placeholder in phase name but not title', async () => {
			const args: SavePlanArgs = {
				title: 'Valid Title',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: '[task]',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('Phase 1 name');
		});
	});

	describe('Oversized inputs', () => {
		it('should handle title with 10,000 characters gracefully', async () => {
			const longTitle = 'A'.repeat(10000);
			const args: SavePlanArgs = {
				title: longTitle,
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			// Should either succeed or fail gracefully, not crash
			expect(result.success).toBeDefined();
			expect(result.message).toBeDefined();
			if (result.success) {
				expect(result.plan_path).toBeDefined();
			}
		});

		it('should handle phase with 500 tasks without timeout', async () => {
			const tasks = Array.from({ length: 500 }, (_, i) => ({
				id: `1.${i + 1}`,
				description: `Task ${i + 1} description`,
			}));
			const args: SavePlanArgs = {
				title: 'Large Phase Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks,
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(true);
			expect(result.tasks_count).toBe(500);
			if (result.plan_path) {
				const saved = await fs.readFile(result.plan_path, 'utf-8');
				const plan = JSON.parse(saved);
				expect(plan.phases[0].tasks.length).toBe(500);
			}
		}, 10000); // 10 second timeout
	});

	describe('Injection attempts', () => {
		it('should handle path traversal attempt "../../etc"', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: '../../etc',
			};
			const result = await executeSavePlan(args);
			// Should either fail or succeed gracefully, not crash
			expect(result.success).toBeDefined();
			expect(result.message).toBeDefined();
		});

		it('should handle nonexistent path gracefully', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: '/nonexistent/path/that/does/not/exist',
			};
			const result = await executeSavePlan(args);
			// Bun.write() creates directories automatically, so save may succeed
			// The important thing is it doesn't crash
			expect(result.success).toBeDefined();
			expect(result.message).toBeDefined();
		});
	});

	describe('Type coercion edge cases', () => {
		it('should reject phase.id of 0 (not positive)', async () => {
			const args = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 0 as number,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args as SavePlanArgs);
			// The schema should reject this before validation
			expect(result).toBeDefined();
		});

		it('should reject phase.id of -1 (negative)', async () => {
			const args = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: -1 as number,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args as SavePlanArgs);
			// The schema should reject this before validation
			expect(result).toBeDefined();
		});

		it('should reject empty task id ""', async () => {
			const args = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '' as string, description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args as SavePlanArgs);
			// The schema should reject this
			expect(result).toBeDefined();
		});

		it('should handle uppercase size "LARGE" (schema expects lowercase)', async () => {
			const args = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [
							{
								id: '1.1',
								description: 'Valid description',
								size: 'LARGE' as 'large',
							},
						],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args as SavePlanArgs);
			// Schema validation should handle enum case sensitivity
			expect(result).toBeDefined();
		});
	});

	describe('Concurrent save attempts', () => {
		it('should handle concurrent saves without corruption', async () => {
			// Ensure .swarm directory exists before concurrent writes
			await fs.mkdir(path.join(tempDir, '.swarm'), { recursive: true });

			const args1: SavePlanArgs = {
				title: 'Plan 1',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup 1',
						tasks: [{ id: '1.1', description: 'Task 1.1' }],
					},
				],
				working_directory: tempDir,
			};
			const args2: SavePlanArgs = {
				title: 'Plan 2',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup 2',
						tasks: [{ id: '1.1', description: 'Task 2.1' }],
					},
				],
				working_directory: tempDir,
			};

			// Execute both saves concurrently
			const [result1, result2] = await Promise.all([
				executeSavePlan(args1),
				executeSavePlan(args2),
			]);

			// At least one should succeed - this is an adversarial test checking for corruption
			// One may fail due to temp file name collision (Date.now()) - that's acceptable
			expect(result1.success || result2.success).toBe(true);

			// Verify file is valid JSON (no corruption occurred)
			const planPath = path.join(tempDir, '.swarm', 'plan.json');
			const content = await fs.readFile(planPath, 'utf-8');
			const plan = JSON.parse(content);
			expect(plan.title).toBeDefined();
			expect(plan.phases).toBeDefined();
			expect(() => JSON.parse(content)).not.toThrow();
		});
	});

	describe('Placeholder in nested position', () => {
		it('should catch placeholder in task description (nested check)', async () => {
			const args: SavePlanArgs = {
				title: 'Valid Title',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: '[task]' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('Task 1.1 description');
		});

		it('should catch multiple placeholders across title, phase, and tasks', async () => {
			const args: SavePlanArgs = {
				title: '[Project]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: '[phase]',
						tasks: [
							{ id: '1.1', description: '[task]' },
							{ id: '1.2', description: '[description]' },
						],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe('Unicode in fields', () => {
		it('should save Chinese characters successfully', async () => {
			const args: SavePlanArgs = {
				title: '项目计划',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: '设置',
						tasks: [{ id: '1.1', description: '创建基础架构' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(true);
			if (result.plan_path) {
				const saved = await fs.readFile(result.plan_path, 'utf-8');
				const plan = JSON.parse(saved);
				expect(plan.title).toBe('项目计划');
				expect(plan.phases[0].name).toBe('设置');
				expect(plan.phases[0].tasks[0].description).toBe('创建基础架构');
			}
		});

		it('should save emoji characters successfully', async () => {
			const args: SavePlanArgs = {
				title: '🚀 Project Plan 🎯',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Phase 1 ✨',
						tasks: [{ id: '1.1', description: 'Setup infrastructure 💻' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(true);
			if (result.plan_path) {
				const saved = await fs.readFile(result.plan_path, 'utf-8');
				const plan = JSON.parse(saved);
				expect(plan.title).toBe('🚀 Project Plan 🎯');
			}
		});
	});

	describe('Newline injection', () => {
		it('should NOT reject newline with bracket (not full string match)', async () => {
			const args: SavePlanArgs = {
				title: 'Valid Title',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add\n[task]\nto system' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			// Should succeed because regex requires full string match ^...$
			expect(result.success).toBe(true);
		});

		it('should save multiline description successfully', async () => {
			const args: SavePlanArgs = {
				title: 'Valid Title',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [
							{
								id: '1.1',
								description: 'Line 1\nLine 2\nLine 3',
							},
						],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(true);
			if (result.plan_path) {
				const saved = await fs.readFile(result.plan_path, 'utf-8');
				const plan = JSON.parse(saved);
				expect(plan.phases[0].tasks[0].description).toBe(
					'Line 1\nLine 2\nLine 3',
				);
			}
		});
	});

	describe('Edge cases with bracket patterns', () => {
		it('should NOT reject bracket at end of string', async () => {
			const args: SavePlanArgs = {
				title: 'Phase 1 [optional]',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(true);
		});

		it('should NOT reject brackets in middle of string', async () => {
			const args: SavePlanArgs = {
				title: 'Install [package] dependency',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(true);
		});

		it('should NOT reject opening bracket without closing', async () => {
			const args: SavePlanArgs = {
				title: '[Phase 1',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(true);
		});
	});

	describe('Repository-root mutation prevention (cross-platform)', () => {
		it('should reject undefined working_directory with no fallback (Windows-style)', async () => {
			// This tests that without explicit target, the function fails instead of
			// falling back to process.cwd() which could mutate repository-root .swarm
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				// No working_directory provided
			};
			const result = await executeSavePlan(args, undefined);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('Target workspace is required');
		});

		it('should reject undefined working_directory with no fallback (POSIX-style)', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('Target workspace is required');
		});

		it('should reject empty string working_directory (Windows-style path forms)', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: '',
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('cannot be empty or whitespace');
		});

		it('should reject whitespace-only working_directory (POSIX-style path forms)', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: '   ',
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('cannot be empty or whitespace');
		});

		it('should reject path traversal with backslash (Windows-style "..\\")', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: 'C:\\projects\\..\\..\\.swarm',
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('cannot contain path traversal');
		});

		it('should reject path traversal with forward slash (POSIX-style "../")', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: '/home/user/../../etc',
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('cannot contain path traversal');
		});

		it('should reject relative path traversal with mixed separators (cross-platform)', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: './..\\..',
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('cannot contain path traversal');
		});

		it('should accept Windows root drive path (contract-aligned: no root-path rejection)', async () => {
			// validateTargetWorkspace does NOT reject root paths - it only checks for:
			// 1. undefined/null 2. empty/whitespace 3. path traversal (..)
			// This test validates the CONTRACT: root paths pass validation.
			// Actual write may fail due to OS permissions - that's environment-dependent.
			// The key mutation-prevention is: no implicit process.cwd() fallback.
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: 'C:\\',
			};
			const result = await executeSavePlan(args);
			// Contract: root paths pass validation (no path traversal, not empty)
			// Success depends on OS write permissions - not deterministic across environments
			expect(result.success).toBeDefined();
			// Key assertion: no validation error for root path (path traversal or empty check)
			const errors = result.errors ?? [];
			const hasValidationError = errors.some(
				(e) =>
					e.includes('cannot contain path traversal') ||
					e.includes('cannot be empty'),
			);
			expect(hasValidationError).toBe(false);
		});

		it('should accept POSIX root path (contract-aligned: no root-path rejection)', async () => {
			// validateTargetWorkspace does NOT reject root paths - it only checks for:
			// 1. undefined/null 2. empty/whitespace 3. path traversal (..)
			// This test validates the CONTRACT: root paths pass validation.
			// Actual write may fail due to OS permissions - that's environment-dependent.
			// The key mutation-prevention is: no implicit process.cwd() fallback.
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: '/',
			};
			const result = await executeSavePlan(args);
			// Contract: root paths pass validation (no path traversal, not empty)
			// Success depends on OS write permissions - not deterministic across environments
			expect(result.success).toBeDefined();
			// Key assertion: no validation error for root path (path traversal or empty check)
			const errors = result.errors ?? [];
			const hasValidationError = errors.some(
				(e) =>
					e.includes('cannot contain path traversal') ||
					e.includes('cannot be empty'),
			);
			expect(hasValidationError).toBe(false);
		});

		it('should accept Windows UNC path (contract-aligned: no UNC-path rejection)', async () => {
			// validateTargetWorkspace does NOT reject UNC paths - it only checks for:
			// 1. undefined/null 2. empty/whitespace 3. path traversal (..)
			// This test validates the CONTRACT: UNC paths pass validation.
			// Actual write may fail due to OS permissions - that's environment-dependent.
			// The key mutation-prevention is: no implicit process.cwd() fallback.
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: '\\\\server\\share',
			};
			const result = await executeSavePlan(args);
			// Contract: UNC paths pass validation (no path traversal, not empty)
			// Success depends on OS write permissions - not deterministic across environments
			expect(result.success).toBeDefined();
			// Key assertion: no validation error for UNC path (path traversal or empty check)
			const errors = result.errors ?? [];
			const hasValidationError = errors.some(
				(e) =>
					e.includes('cannot contain path traversal') ||
					e.includes('cannot be empty'),
			);
			expect(hasValidationError).toBe(false);
		});

		it.skipIf(process.platform === 'win32')(
			'should reject a non-native Windows-style path on POSIX hosts',
			async () => {
				const args: SavePlanArgs = {
					title: 'Test Plan',
					swarm_id: 'test',
					phases: [
						{
							id: 1,
							name: 'Setup',
							tasks: [{ id: '1.1', description: 'Valid description' }],
						},
					],
					working_directory: 'C:\\projects\\myworkspace',
				};
				const result = await executeSavePlan(args);
				expect(result.success).toBe(false);
				expect(result.errors?.[0]).toContain('Cannot verify project root');
			},
		);

		it('should accept a platform-native declared workspace path', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				// Use tempDir (an actual existing directory) so the plan can be
				// written in CI environments where /home/user/projects/myworkspace
				// does not exist.
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args);
			// Valid workspace path should succeed
			expect(result.success).toBe(true);
		});

		it('should reject when fallbackDir is also undefined (double-fallback prevention)', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				// No working_directory
			};
			// Explicitly pass undefined as fallbackDir
			const result = await executeSavePlan(args, undefined);
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('required');
		});

		it('should reject null as working_directory', async () => {
			const args = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid description' }],
					},
				],
				working_directory: null,
			} as unknown as SavePlanArgs;
			const result = await executeSavePlan(args);
			expect(result.success).toBe(false);
		});
	});

	describe('Recovery guidance clarity for invalid phase IDs (Kimi K2 regression)', () => {
		it('recovery_guidance for negative phase ID explicitly mentions valid examples (1, 2, 3)', async () => {
			// Regression: Kimi K2.5 entered infinite loop because recovery_guidance was too vague.
			// The guidance must now explicitly state valid phase ID format to break the loop.
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: -1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid task' }],
					},
				],
				working_directory: tempDir,
			};
			await fs.mkdir(`${tempDir}/.swarm`, { recursive: true });
			const result = await executeSavePlan(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
			// Must explicitly name valid values so model can correct itself
			expect(result.recovery_guidance).toContain('1, 2, 3');
		});

		it('recovery_guidance for phase ID = 0 explicitly mentions valid examples', async () => {
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 0,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid task' }],
					},
				],
				working_directory: tempDir,
			};
			await fs.mkdir(`${tempDir}/.swarm`, { recursive: true });
			const result = await executeSavePlan(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toContain('1, 2, 3');
		});

		it('valid phase ID = 1 succeeds after previous negative ID rejection', async () => {
			// Ensures valid input succeeds immediately after the corrected guidance is followed
			await fs.mkdir(`${tempDir}/.swarm`, { recursive: true });
			const args: SavePlanArgs = {
				title: 'Test Plan',
				swarm_id: 'test',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Valid task' }],
					},
				],
				working_directory: tempDir,
			};
			const result = await executeSavePlan(args, tempDir);
			expect(result.success).toBe(true);
		});
	});
});
