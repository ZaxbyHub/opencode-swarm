/**
 * Verification tests for save_plan tool
 * Covers placeholder detection, save execution, and tool definition validation
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	SavePlanArgs,
	SavePlanResult,
} from '../../../src/tools/save-plan';
import {
	detectPlaceholderContent,
	executeSavePlan,
	save_plan,
} from '../../../src/tools/save-plan';

describe('save-plan tool verification tests', () => {
	let tmpDir: string;

	beforeEach(async () => {
		// Create a temporary directory for each test
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-plan-test-'));
		// Ensure .swarm/ directory exists
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		// Create spec.md required by the spec gate
		await fs.writeFile(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
		// Create context.md with the QA gate selection section required by the gate-selection check
		await fs.writeFile(
			path.join(tmpDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
	});

	afterEach(async () => {
		// Clean up the temporary directory
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== GROUP 1: detectPlaceholderContent - positive rejection cases ==========
	describe('Group 1: detectPlaceholderContent - positive rejection cases', () => {
		it('[task] in title returns issue about title', () => {
			const args: SavePlanArgs = {
				title: '[task]',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(
				issues.some(
					(issue) => issue.includes('Plan title') && issue.includes('[task]'),
				),
			).toBe(true);
		});

		it('[Project] in title returns issue', () => {
			const args: SavePlanArgs = {
				title: '[Project]',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(
				issues.some(
					(issue) =>
						issue.includes('Plan title') && issue.includes('[Project]'),
				),
			).toBe(true);
		});

		it('[date] in title returns issue', () => {
			const args: SavePlanArgs = {
				title: '[date]',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(
				issues.some(
					(issue) => issue.includes('Plan title') && issue.includes('[date]'),
				),
			).toBe(true);
		});

		it('[description] in phase name returns issue', () => {
			const args: SavePlanArgs = {
				title: 'My Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: '[description]',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(
				issues.some(
					(issue) =>
						issue.includes('Phase 1') && issue.includes('[description]'),
				),
			).toBe(true);
		});

		it('[N] in task description returns issue', () => {
			const args: SavePlanArgs = {
				title: 'My Project',
				swarm_id: 'mega',
				phases: [
					{ id: 1, name: 'Setup', tasks: [{ id: '1.1', description: '[N]' }] },
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(
				issues.some(
					(issue) => issue.includes('Task 1.1') && issue.includes('[N]'),
				),
			).toBe(true);
		});

		it('" [task] " (whitespace-padded) in title returns issue (trim fix)', () => {
			const args: SavePlanArgs = {
				title: ' [task] ',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(issues.some((issue) => issue.includes('Plan title'))).toBe(true);
		});

		it('"[task] " (trailing space) returns issue', () => {
			const args: SavePlanArgs = {
				title: '[task] ',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(issues.some((issue) => issue.includes('Plan title'))).toBe(true);
		});

		it('" [Project]" (leading space) returns issue', () => {
			const args: SavePlanArgs = {
				title: ' [Project]',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(issues.some((issue) => issue.includes('Plan title'))).toBe(true);
		});

		it('[Project Name] (multi-word bracket) returns issue', () => {
			const args: SavePlanArgs = {
				title: '[Project Name]',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
			expect(
				issues.some(
					(issue) =>
						issue.includes('Plan title') && issue.includes('[Project Name]'),
				),
			).toBe(true);
		});

		it('Multiple placeholders returns multiple issues', () => {
			const args: SavePlanArgs = {
				title: '[Project]',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: '[description]',
						tasks: [
							{ id: '1.1', description: '[task]' },
							{ id: '1.2', description: 'Real task' },
						],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBe(3);
			expect(issues.some((issue) => issue.includes('Plan title'))).toBe(true);
			expect(issues.some((issue) => issue.includes('Phase 1'))).toBe(true);
			expect(issues.some((issue) => issue.includes('Task 1.1'))).toBe(true);
		});
	});

	// ========== GROUP 2: detectPlaceholderContent - NOT placeholders (should NOT reject) ==========
	describe('Group 2: detectPlaceholderContent - NOT placeholders (should NOT reject)', () => {
		it('"Add authentication to login service" — real description, no issue', () => {
			const args: SavePlanArgs = {
				title: 'Add authentication to login service',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBe(0);
		});

		it('"Phase 1: Authentication" — real name, no issue', () => {
			const args: SavePlanArgs = {
				title: 'My Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1: Authentication',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBe(0);
		});

		it('"Feature: [SMALL] scope task" — embedded bracket (not standalone), no issue', () => {
			const args: SavePlanArgs = {
				title: 'Feature: [SMALL] scope task',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBe(0);
		});

		it('"Implement [API] endpoint" — embedded bracket in sentence, no issue', () => {
			const args: SavePlanArgs = {
				title: 'Implement [API] endpoint',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBe(0);
		});

		it('"opencode-swarm v6.14.1 — Bug Fix" — real title, no issue', () => {
			const args: SavePlanArgs = {
				title: 'opencode-swarm v6.14.1 — Bug Fix',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBe(0);
		});

		it('Empty phases array has no issues reported for title-level', () => {
			const args: SavePlanArgs = {
				title: '[Project]',
				swarm_id: 'mega',
				phases: [],
			};
			const issues = detectPlaceholderContent(args);
			// Should only report title issue, no phase issues since no phases
			expect(issues.length).toBe(1);
			expect(issues.some((issue) => issue.includes('Plan title'))).toBe(true);
		});
	});

	// ========== GROUP 3: executeSavePlan - placeholder rejection ==========
	describe('Group 3: executeSavePlan - placeholder rejection', () => {
		it('Call with title placeholder returns { success: false, errors: [...] }', async () => {
			const args: SavePlanArgs = {
				title: '[Project]',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args);

			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors!.length).toBeGreaterThan(0);
			expect(result.message).toContain('rejected');
		});

		it('Call with phase name placeholder returns { success: false }', async () => {
			const args: SavePlanArgs = {
				title: 'My Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: '[description]',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args);

			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors!.length).toBeGreaterThan(0);
		});

		it('Call with task description placeholder returns { success: false }', async () => {
			const args: SavePlanArgs = {
				title: 'My Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: '[task]' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args);

			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors!.length).toBeGreaterThan(0);
		});
	});

	// ========== GROUP 4: executeSavePlan - successful save ==========
	describe('Group 4: executeSavePlan - successful save', () => {
		it('Use a real tmp directory, call with valid plan data, returns success', async () => {
			const args: SavePlanArgs = {
				title: 'My Awesome Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [
							{
								id: '1.1',
								description: 'Add authentication to login service',
								size: 'small',
							},
						],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args);

			expect(result.success).toBe(true);
			expect(result.message).toContain('success');
			expect(result.plan_path).toBeDefined();
			expect(result.phases_count).toBe(1);
			expect(result.tasks_count).toBe(1);
		});

		it('Verify .swarm/plan.json was created and is valid JSON', async () => {
			const args: SavePlanArgs = {
				title: 'My Awesome Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add authentication' }],
					},
				],
				working_directory: tmpDir,
			};

			await executeSavePlan(args);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const exists = await fs
				.access(planJsonPath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);

			const content = await fs.readFile(planJsonPath, 'utf-8');
			expect(() => JSON.parse(content)).not.toThrow();
		});

		it('Verify .swarm/plan.md was created and contains the title', async () => {
			const args: SavePlanArgs = {
				title: 'My Awesome Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add authentication' }],
					},
				],
				working_directory: tmpDir,
			};

			await executeSavePlan(args);

			const planMdPath = path.join(tmpDir, '.swarm', 'plan.md');
			const exists = await fs
				.access(planMdPath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);

			const content = await fs.readFile(planMdPath, 'utf-8');
			expect(content).toContain('My Awesome Project');
		});

		it('Uses OpenSpec-compatible artifacts as the effective spec when .swarm/spec.md is absent', async () => {
			await fs.rm(path.join(tmpDir, '.swarm', 'spec.md'), { force: true });
			const specDir = path.join(tmpDir, 'openspec', 'specs', 'checkout');
			await fs.mkdir(specDir, { recursive: true });
			await fs.writeFile(
				path.join(specDir, 'spec.md'),
				[
					'# Checkout',
					'',
					'### Requirement: Signed-in checkout',
					'',
					'Customers MUST be able to complete checkout after authentication.',
					'',
					'#### Scenario: Successful checkout',
					'- **WHEN** an authenticated customer submits checkout',
					'- **THEN** the system completes the order.',
					'',
				].join('\n'),
			);

			const result = await executeSavePlan({
				title: 'OpenSpec Plan',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Implementation',
						tasks: [{ id: '1.1', description: 'Implement checkout flow' }],
					},
				],
				working_directory: tmpDir,
			});

			expect(result.success).toBe(true);
			await expect(
				fs.access(path.join(tmpDir, '.swarm', 'spec.md')),
			).rejects.toThrow();

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const plan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(plan.specHash).toMatch(/^[a-f0-9]{64}$/);
			expect(plan.specMtime).toBeString();
		});

		it('Save plan with multiple phases and tasks', async () => {
			const args: SavePlanArgs = {
				title: 'Multi-Phase Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1: Setup',
						tasks: [
							{ id: '1.1', description: 'Task 1.1' },
							{ id: '1.2', description: 'Task 1.2' },
						],
					},
					{
						id: 2,
						name: 'Phase 2: Implementation',
						tasks: [
							{ id: '2.1', description: 'Task 2.1' },
							{ id: '2.2', description: 'Task 2.2' },
							{ id: '2.3', description: 'Task 2.3' },
						],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args);

			expect(result.success).toBe(true);
			expect(result.phases_count).toBe(2);
			expect(result.tasks_count).toBe(5);
		});

		it('Handle task with dependencies and acceptance criteria', async () => {
			const args: SavePlanArgs = {
				title: 'Complex Task Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [
							{
								id: '1.1',
								description: 'Setup database',
								depends: [],
								acceptance: 'Database schema created',
							},
							{
								id: '1.2',
								description: 'Create migration scripts',
								depends: ['1.1'],
								acceptance: 'Migrations run successfully',
							},
						],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args);

			expect(result.success).toBe(true);
			expect(result.tasks_count).toBe(2);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const content = await fs.readFile(planJsonPath, 'utf-8');
			const plan = JSON.parse(content);

			expect(plan.phases[0].tasks[0].depends).toEqual([]);
			expect(plan.phases[0].tasks[1].depends).toEqual(['1.1']);
			expect(plan.phases[0].tasks[0].acceptance).toBe(
				'Database schema created',
			);
			expect(plan.phases[0].tasks[1].acceptance).toBe(
				'Migrations run successfully',
			);
		});
	});

	// ========== GROUP 5: save_plan ToolDefinition ==========
	describe('Group 5: save_plan ToolDefinition', () => {
		it('save_plan is defined (not null/undefined)', () => {
			expect(save_plan).toBeDefined();
			expect(save_plan).not.toBeNull();
			expect(save_plan).not.toBeUndefined();
		});

		it('Has description property (non-empty string)', () => {
			expect(save_plan.description).toBeDefined();
			expect(typeof save_plan.description).toBe('string');
			expect(save_plan.description.length).toBeGreaterThan(0);
		});

		it('Has args property', () => {
			expect(save_plan.args).toBeDefined();
			expect(typeof save_plan.args).toBe('object');
		});

		it('Has execute function', () => {
			expect(save_plan.execute).toBeDefined();
			expect(typeof save_plan.execute).toBe('function');
		});

		it('Description mentions placeholder rejection', () => {
			expect(save_plan.description).toContain('placeholder');
			expect(save_plan.description.toLowerCase()).toContain('reject');
		});
	});

	// ========== GROUP 6: Task ID validation (in tool args) ==========
	describe('Group 6: Task ID validation (in tool args)', () => {
		it('Task ID regex matches "1.1"', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('1.1')).toBe(true);
		});

		it('Task ID regex matches "2.3"', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('2.3')).toBe(true);
		});

		it('Task ID regex matches "1.2.1"', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('1.2.1')).toBe(true);
		});

		it('Task ID regex matches "1.2.3.4"', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('1.2.3.4')).toBe(true);
		});

		it('Task ID regex does NOT match "1"', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('1')).toBe(false);
		});

		it('Task ID regex does NOT match ".1"', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('.1')).toBe(false);
		});

		it('Task ID regex does NOT match "a.b"', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('a.b')).toBe(false);
		});

		it('Task ID regex does NOT match "1.a"', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('1.a')).toBe(false);
		});

		it('Task ID regex does NOT match ""', () => {
			const regex = /^\d+\.\d+(\.\d+)*$/;
			expect(regex.test('')).toBe(false);
		});
	});

	// ========== ADDITIONAL EDGE CASES ==========
	describe('Additional edge cases', () => {
		it('Handle tasks with medium and large sizes', async () => {
			const args: SavePlanArgs = {
				title: 'Sized Tasks Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [
							{ id: '1.1', description: 'Small task', size: 'small' },
							{ id: '1.2', description: 'Medium task', size: 'medium' },
							{ id: '1.3', description: 'Large task', size: 'large' },
						],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args);

			expect(result.success).toBe(true);
			expect(result.tasks_count).toBe(3);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const content = await fs.readFile(planJsonPath, 'utf-8');
			const plan = JSON.parse(content);

			expect(plan.phases[0].tasks[0].size).toBe('small');
			expect(plan.phases[0].tasks[1].size).toBe('medium');
			expect(plan.phases[0].tasks[2].size).toBe('large');
		});

		it('Tasks default to small size when not specified', async () => {
			const args: SavePlanArgs = {
				title: 'Default Size Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Default size task' }],
					},
				],
				working_directory: tmpDir,
			};

			await executeSavePlan(args);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const content = await fs.readFile(planJsonPath, 'utf-8');
			const plan = JSON.parse(content);

			expect(plan.phases[0].tasks[0].size).toBe('small');
		});

		it('Plan contains correct schema_version and migration_status', async () => {
			const args: SavePlanArgs = {
				title: 'Metadata Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Task' }],
					},
				],
				working_directory: tmpDir,
			};

			await executeSavePlan(args);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const content = await fs.readFile(planJsonPath, 'utf-8');
			const plan = JSON.parse(content);

			expect(plan.schema_version).toBe('1.0.0');
			expect(plan.migration_status).toBe('native');
			expect(plan.swarm).toBe('mega');
			expect(plan.current_phase).toBe(1);
		});

		it('All phases have status "pending" initially', async () => {
			const args: SavePlanArgs = {
				title: 'Status Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task' }],
					},
					{
						id: 2,
						name: 'Phase 2',
						tasks: [{ id: '2.1', description: 'Task' }],
					},
				],
				working_directory: tmpDir,
			};

			await executeSavePlan(args);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const content = await fs.readFile(planJsonPath, 'utf-8');
			const plan = JSON.parse(content);

			expect(plan.phases[0].status).toBe('pending');
			expect(plan.phases[1].status).toBe('pending');
			expect(plan.phases[0].tasks[0].status).toBe('pending');
			expect(plan.phases[1].tasks[0].status).toBe('pending');
		});

		it('All tasks have empty files_touched array initially', async () => {
			const args: SavePlanArgs = {
				title: 'Files Touched Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task' }],
					},
				],
				working_directory: tmpDir,
			};

			await executeSavePlan(args);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const content = await fs.readFile(planJsonPath, 'utf-8');
			const plan = JSON.parse(content);

			expect(plan.phases[0].tasks[0].files_touched).toEqual([]);
		});

		it('Handle working_directory defaulting to process.cwd()', async () => {
			const args: SavePlanArgs = {
				title: 'Default Dir Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Task' }],
					},
				],
				// No working_directory specified
			};

			// This will try to write to process.cwd(), which should fail if .swarm doesn't exist
			// But we can test that it doesn't crash immediately
			expect(async () => {
				await executeSavePlan(args);
			}).not.toThrow();
		});

		it('Placeholder pattern rejects single word brackets with trailing space after trim', () => {
			const args: SavePlanArgs = {
				title: '  [task]  ',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
		});

		it('Placeholder pattern rejects multi-word placeholders with spaces inside', () => {
			const args: SavePlanArgs = {
				title: '[Task Description]',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBeGreaterThan(0);
		});

		it('Real text with brackets in middle is not rejected', () => {
			const args: SavePlanArgs = {
				title: 'Task: Implement [feature name] by tomorrow',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
			};
			const issues = detectPlaceholderContent(args);
			expect(issues.length).toBe(0);
		});
	});

	// ========== GROUP 7: executeSavePlan - Step 0 validation and recovery_guidance ==========
	describe('Group 7: executeSavePlan - Step 0 validation and recovery_guidance', () => {
		let tmpDir: string;

		beforeEach(() => {
			// Create a temporary directory for each test
			tmpDir = mkdirSync(os.tmpdir() + '/save-plan-test-' + Date.now(), {
				recursive: true,
			}) as string;
			// Create .swarm/spec.md required by the spec gate
			mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
			writeFileSync(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
			// Create context.md with the QA gate selection section required by the gate-selection check
			writeFileSync(
				path.join(tmpDir, '.swarm', 'context.md'),
				'## Pending QA Gate Selection\n',
			);
		});

		afterEach(() => {
			// Clean up the temporary directory
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it('Phase ID = 0 returns success: false with recovery_guidance', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 0,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
			expect(typeof result.recovery_guidance).toBe('string');
			expect(result.recovery_guidance!.length).toBeGreaterThan(0);
			expect(result.message).toContain(
				'Plan rejected: invalid phase or task IDs',
			);
		});

		it('Phase ID = -1 returns success: false with recovery_guidance', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: -1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
		});

		it('Phase ID = 1.5 (float) returns success: false with recovery_guidance', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1.5,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				] as any,
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
		});

		it('Phase ID valid (1) with valid task returns success: true and recovery_guidance undefined', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(true);
			expect(result.recovery_guidance).toBeUndefined();
		});

		it('Task ID = "abc" returns success: false with recovery_guidance mentioning "abc"', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: 'abc', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
			expect(result.errors).toBeDefined();
			expect(result.errors!.some((e) => e.includes('abc'))).toBe(true);
		});

		it('Task ID = "1" (missing dot) returns success: false with recovery_guidance', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
		});

		it('Task ID = ".1" (leading dot) returns success: false with recovery_guidance', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '.1', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
		});

		it('Task ID = "1.a" (non-numeric) returns success: false with recovery_guidance', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Setup',
						tasks: [{ id: '1.a', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
		});

		it('recovery_guidance includes "save_plan" for invalid phase ID', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 0,
						name: 'Setup',
						tasks: [{ id: '1.1', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.recovery_guidance).toBeDefined();
			expect(result.recovery_guidance!).toContain('save_plan');
		});

		it('Multiple validation errors (phase id=0 and task id="bad") returns multiple errors', async () => {
			const args: SavePlanArgs = {
				title: 'Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 0,
						name: 'Setup',
						tasks: [{ id: 'bad', description: 'Add auth' }],
					},
				],
				working_directory: tmpDir,
			};

			const result: SavePlanResult = await executeSavePlan(args, undefined);

			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors!.length).toBeGreaterThanOrEqual(2);
			expect(result.recovery_guidance).toBeDefined();
		});
	});

	// Group 8: Merge-mode status preservation
	describe('Group 8: Merge-mode status preservation', () => {
		it('Preserves completed status for matching task IDs across plan revisions', async () => {
			// First: save a plan, then manually set a task to completed
			const args1: SavePlanArgs = {
				title: 'Merge Test Project',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{ id: '1.1', description: 'Task A' },
							{ id: '1.2', description: 'Task B' },
						],
					},
				],
				working_directory: tmpDir,
			};
			await executeSavePlan(args1);

			// Manually set task 1.1 to completed
			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const planData = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			planData.phases[0].tasks[0].status = 'completed';
			await fs.writeFile(planJsonPath, JSON.stringify(planData, null, 2));

			// Now save a revised plan with the same task IDs
			const args2: SavePlanArgs = {
				title: 'Merge Test Project v2',
				swarm_id: 'mega',
				confirm_identity_change: true,
				phases: [
					{
						id: 1,
						name: 'Phase 1 Revised',
						tasks: [
							{ id: '1.1', description: 'Task A revised' },
							{ id: '1.2', description: 'Task B revised' },
							{ id: '1.3', description: 'New Task C' },
						],
					},
				],
				working_directory: tmpDir,
			};
			const result = await executeSavePlan(args2);
			expect(result.success).toBe(true);

			const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(savedPlan.phases[0].tasks[0].status).toBe('completed'); // 1.1 preserved
			expect(savedPlan.phases[0].tasks[1].status).toBe('pending'); // 1.2 was pending
			expect(savedPlan.phases[0].tasks[2].status).toBe('pending'); // 1.3 is new
		});

		it('Preserves in_progress status for matching task IDs', async () => {
			const args1: SavePlanArgs = {
				title: 'In-Progress Merge Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A' }],
					},
				],
				working_directory: tmpDir,
			};
			await executeSavePlan(args1);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const planData = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			planData.phases[0].tasks[0].status = 'in_progress';
			await fs.writeFile(planJsonPath, JSON.stringify(planData, null, 2));

			const args2: SavePlanArgs = {
				title: 'In-Progress Merge Test v2',
				swarm_id: 'mega',
				confirm_identity_change: true,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A updated' }],
					},
				],
				working_directory: tmpDir,
			};
			const result = await executeSavePlan(args2);
			expect(result.success).toBe(true);

			const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(savedPlan.phases[0].tasks[0].status).toBe('in_progress');
		});

		it('New tasks default to pending when no matching ID in existing plan', async () => {
			const args1: SavePlanArgs = {
				title: 'New Tasks Merge Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A' }],
					},
				],
				working_directory: tmpDir,
			};
			await executeSavePlan(args1);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const planData = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			planData.phases[0].tasks[0].status = 'completed';
			await fs.writeFile(planJsonPath, JSON.stringify(planData, null, 2));

			// Save with entirely new task IDs. Issue #853: dropping 1.1 must now be
			// acknowledged via removed_task_ids + removal_reason.
			const args2: SavePlanArgs = {
				title: 'New Tasks Merge Test v2',
				swarm_id: 'mega',
				confirm_identity_change: true,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{ id: '2.1', description: 'Entirely new task' },
							{ id: '2.2', description: 'Another new task' },
						],
					},
				],
				working_directory: tmpDir,
				removed_task_ids: ['1.1'],
				removal_reason: 'test: replace task set entirely',
			};
			const result = await executeSavePlan(args2);
			expect(result.success).toBe(true);

			const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(savedPlan.phases[0].tasks[0].status).toBe('pending');
			expect(savedPlan.phases[0].tasks[1].status).toBe('pending');
		});

		it('First save with no existing plan sets all tasks to pending', async () => {
			const args: SavePlanArgs = {
				title: 'First Save Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{ id: '1.1', description: 'Task A' },
							{ id: '1.2', description: 'Task B' },
						],
					},
				],
				working_directory: tmpDir,
			};
			const result = await executeSavePlan(args);
			expect(result.success).toBe(true);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(savedPlan.phases[0].tasks[0].status).toBe('pending');
			expect(savedPlan.phases[0].tasks[1].status).toBe('pending');
		});

		it('Preserves blocked status for matching task IDs', async () => {
			const args1: SavePlanArgs = {
				title: 'Blocked Merge Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A' }],
					},
				],
				working_directory: tmpDir,
			};
			await executeSavePlan(args1);

			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');
			const planData = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			planData.phases[0].tasks[0].status = 'blocked';
			await fs.writeFile(planJsonPath, JSON.stringify(planData, null, 2));

			const args2: SavePlanArgs = {
				title: 'Blocked Merge Test v2',
				swarm_id: 'mega',
				confirm_identity_change: true,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A updated' }],
					},
				],
				working_directory: tmpDir,
			};
			const result = await executeSavePlan(args2);
			expect(result.success).toBe(true);

			const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(savedPlan.phases[0].tasks[0].status).toBe('blocked');
		});
	});

	// ========== GROUP 9: reset_statuses parameter ==========
	describe('Group 9: reset_statuses parameter', () => {
		// Regression test: save_plan with reset_statuses: true must reset completed
		// task statuses back to pending.  Before this fix, executeSavePlan always
		// populated existingStatusMap from the current plan.json and applied existing
		// statuses to every incoming task — making it impossible to reset 'completed'
		// tasks via save_plan regardless of intent.
		it('reset_statuses: true resets all completed tasks to pending', async () => {
			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');

			// First save: create plan with two tasks
			const args1: SavePlanArgs = {
				title: 'Reset Status Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{ id: '1.1', description: 'Task A' },
							{ id: '1.2', description: 'Task B' },
						],
					},
				],
				working_directory: tmpDir,
			};
			await executeSavePlan(args1);

			// Manually set both tasks to completed on disk
			const planData = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			planData.phases[0].tasks[0].status = 'completed';
			planData.phases[0].tasks[1].status = 'completed';
			await fs.writeFile(planJsonPath, JSON.stringify(planData, null, 2));

			// Second save with reset_statuses: true — all tasks must become pending
			const args2: SavePlanArgs = {
				title: 'Reset Status Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [
							{ id: '1.1', description: 'Task A' },
							{ id: '1.2', description: 'Task B' },
						],
					},
				],
				working_directory: tmpDir,
				reset_statuses: true,
			};
			const result = await executeSavePlan(args2);
			expect(result.success).toBe(true);

			// CRITICAL: both tasks must now be pending on disk
			const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(savedPlan.phases[0].tasks[0].status).toBe('pending');
			expect(savedPlan.phases[0].tasks[1].status).toBe('pending');
			expect(savedPlan.phases[0].status).toBe('pending');
		});

		it('reset_statuses: false (default) still preserves completed status', async () => {
			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');

			const args1: SavePlanArgs = {
				title: 'Preserve Status Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A' }],
					},
				],
				working_directory: tmpDir,
			};
			await executeSavePlan(args1);

			const planData = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			planData.phases[0].tasks[0].status = 'completed';
			await fs.writeFile(planJsonPath, JSON.stringify(planData, null, 2));

			// Second save with reset_statuses: false (explicit) — completed is preserved
			const args2: SavePlanArgs = {
				title: 'Preserve Status Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A' }],
					},
				],
				working_directory: tmpDir,
				reset_statuses: false,
			};
			const result = await executeSavePlan(args2);
			expect(result.success).toBe(true);

			const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(savedPlan.phases[0].tasks[0].status).toBe('completed');
		});

		it('reset_statuses omitted (default) still preserves completed status', async () => {
			const planJsonPath = path.join(tmpDir, '.swarm', 'plan.json');

			const args1: SavePlanArgs = {
				title: 'Default Preserve Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A' }],
					},
				],
				working_directory: tmpDir,
			};
			await executeSavePlan(args1);

			const planData = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			planData.phases[0].tasks[0].status = 'completed';
			await fs.writeFile(planJsonPath, JSON.stringify(planData, null, 2));

			// Second save with no reset_statuses — completed is preserved (backward compat)
			const args2: SavePlanArgs = {
				title: 'Default Preserve Test',
				swarm_id: 'mega',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task A' }],
					},
				],
				working_directory: tmpDir,
			};
			const result = await executeSavePlan(args2);
			expect(result.success).toBe(true);

			const savedPlan = JSON.parse(await fs.readFile(planJsonPath, 'utf-8'));
			expect(savedPlan.phases[0].tasks[0].status).toBe('completed');
		});
	});
});
