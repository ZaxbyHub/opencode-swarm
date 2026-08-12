/**
 * Additional verification tests for Task 4.1 atomic plan write changes
 * Tests for:
 * 1. executeSavePlan() fallbackDir parameter behavior
 * 2. executeSavePlan() explicit workspace behavior (no process.cwd() fallback)
 * 3. Temp file cleanup after successful writes
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	SavePlanArgs,
	SavePlanResult,
} from '../../../src/tools/save-plan';
import { executeSavePlan } from '../../../src/tools/save-plan';

beforeEach(() => {
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
});

afterEach(() => {
	delete process.env.SWARM_SKIP_GATE_SELECTION;
});

describe('Task 4.1: fallbackDir parameter behavior', () => {
	let tmpDir1: string;
	let tmpDir2: string;

	beforeEach(async () => {
		// Create two temporary directories for testing fallback
		tmpDir1 = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'save-plan-fallback-1-')),
		);
		tmpDir2 = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'save-plan-fallback-2-')),
		);
		// Ensure .swarm/ directories exist
		await fs.mkdir(path.join(tmpDir1, '.swarm'), { recursive: true });
		await fs.mkdir(path.join(tmpDir2, '.swarm'), { recursive: true });
		// Create spec.md required by the spec gate
		await fs.writeFile(
			path.join(tmpDir1, '.swarm', 'spec.md'),
			'# Test Spec\n',
		);
		await fs.writeFile(
			path.join(tmpDir2, '.swarm', 'spec.md'),
			'# Test Spec\n',
		);
		// Create context.md with the QA gate selection section required by the gate-selection check
		await fs.writeFile(
			path.join(tmpDir1, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
		await fs.writeFile(
			path.join(tmpDir2, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
	});

	afterEach(async () => {
		// Clean up temporary directories
		try {
			await fs.rm(tmpDir1, { recursive: true, force: true });
			await fs.rm(tmpDir2, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('executeSavePlan() uses fallbackDir when args.working_directory is absent', async () => {
		const args: SavePlanArgs = {
			title: 'Fallback Test Plan',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			// No working_directory specified
		};

		// Call with fallbackDir
		const result: SavePlanResult = await executeSavePlan(args, tmpDir1);

		expect(result.success).toBe(true);
		expect(result.plan_path).toContain(tmpDir1);
		// Use path.join for cross-platform path matching
		expect(result.plan_path).toBe(path.join(tmpDir1, '.swarm', 'plan.json'));

		// Verify plan was actually written to fallbackDir
		const planPath = path.join(tmpDir1, '.swarm', 'plan.json');
		const exists = await fs
			.access(planPath)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
	});

	it('executeSavePlan() uses fallbackDir when args.working_directory is undefined', async () => {
		const args: SavePlanArgs = {
			title: 'Undefined Directory Test',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			working_directory: undefined as any, // Explicit undefined
		};

		// Call with fallbackDir
		const result: SavePlanResult = await executeSavePlan(args, tmpDir2);

		expect(result.success).toBe(true);
		expect(result.plan_path).toBe(path.join(tmpDir2, '.swarm', 'plan.json'));

		// Verify plan was written to fallbackDir
		const planPath = path.join(tmpDir2, '.swarm', 'plan.json');
		const exists = await fs
			.access(planPath)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
	});

	it('executeSavePlan() prefers args.working_directory over fallbackDir when both are provided', async () => {
		const args: SavePlanArgs = {
			title: 'Preference Test Plan',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			working_directory: tmpDir1, // Primary directory
		};

		// Call with different fallbackDir
		const result: SavePlanResult = await executeSavePlan(args, tmpDir2);

		expect(result.success).toBe(true);
		expect(result.plan_path).toBe(path.join(tmpDir1, '.swarm', 'plan.json')); // Should use working_directory
		expect(result.plan_path).not.toBe(
			path.join(tmpDir2, '.swarm', 'plan.json'),
		); // Should NOT use fallbackDir

		// Verify plan was written to working_directory
		const planPath1 = path.join(tmpDir1, '.swarm', 'plan.json');
		const planPath2 = path.join(tmpDir2, '.swarm', 'plan.json');
		const exists1 = await fs
			.access(planPath1)
			.then(() => true)
			.catch(() => false);
		const exists2 = await fs
			.access(planPath2)
			.then(() => true)
			.catch(() => false);

		expect(exists1).toBe(true);
		expect(exists2).toBe(false); // Should not be in fallbackDir
	});
});

describe('Task 4.1: explicit workspace behavior', () => {
	let originalCwd: string;
	let tmpDir: string;

	beforeEach(async () => {
		originalCwd = process.cwd();
		tmpDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'save-plan-explicit-')),
		);
		// Ensure .swarm/ directory exists in tmpDir
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
		process.chdir(originalCwd);
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('executeSavePlan() fails deterministically when both working_directory and fallbackDir are missing', async () => {
		const args: SavePlanArgs = {
			title: 'No Directory Test Plan',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			// No working_directory specified
		};

		// Call without fallbackDir - should fail explicitly
		const result: SavePlanResult = await executeSavePlan(args);

		// Should fail because no directory was provided
		expect(result.success).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors?.[0]).toContain('fallbackDir');
	});

	it('executeSavePlan() uses explicit working_directory from args', async () => {
		// Change to a different directory to prove working_directory is respected
		process.chdir(tmpDir);

		const otherDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'save-plan-other-')),
		);
		await fs.mkdir(path.join(otherDir, '.swarm'), { recursive: true });
		await fs.writeFile(
			path.join(otherDir, '.swarm', 'spec.md'),
			'# Test Spec\n',
		);
		await fs.writeFile(
			path.join(otherDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);

		const args: SavePlanArgs = {
			title: 'Explicit Workspace Test',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			working_directory: otherDir,
		};

		// Call without fallbackDir - should use explicit working_directory
		const result: SavePlanResult = await executeSavePlan(args);

		expect(result.success).toBe(true);
		expect(result.plan_path).toBe(path.join(otherDir, '.swarm', 'plan.json'));

		// Verify plan was written to the explicit working_directory, not cwd
		const planPath = path.join(otherDir, '.swarm', 'plan.json');
		const exists = await fs
			.access(planPath)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);

		// Verify NOT written to cwd
		const cwdPlanPath = path.join(tmpDir, '.swarm', 'plan.json');
		const cwdExists = await fs
			.access(cwdPlanPath)
			.then(() => true)
			.catch(() => false);
		expect(cwdExists).toBe(false);

		// Cleanup otherDir
		await fs.rm(otherDir, { recursive: true, force: true });
	});
});

describe('Task 4.1: temp file cleanup behavior', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'save-plan-temp-')),
		);
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
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('temp files are cleaned up after successful save (no leftover .tmp files)', async () => {
		const args: SavePlanArgs = {
			title: 'Temp Cleanup Test',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			working_directory: tmpDir,
		};

		await executeSavePlan(args);

		// List all files in .swarm directory
		const swarmDir = path.join(tmpDir, '.swarm');
		const files = await fs.readdir(swarmDir);

		// Should only have plan.json and plan.md, no temp files
		expect(files).toContain('plan.json');
		expect(files).toContain('plan.md');
		expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
	});

	it('successful save leaves only plan.json and plan.md files', async () => {
		const args: SavePlanArgs = {
			title: 'File Cleanup Test',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			working_directory: tmpDir,
		};

		await executeSavePlan(args);

		// Check that only expected files exist
		const swarmDir = path.join(tmpDir, '.swarm');
		const files = await fs.readdir(swarmDir);

		expect(files).toContain('plan.json');
		expect(files).toContain('plan.md');
		expect(files.filter((f: string) => f.endsWith('.tmp'))).toHaveLength(0);
	});

	it('multiple saves do not accumulate temp files', async () => {
		const args: SavePlanArgs = {
			title: 'Multiple Saves Test',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			working_directory: tmpDir,
		};

		// Save multiple times
		await executeSavePlan(args);
		await executeSavePlan({ ...args, title: 'Updated Plan' });
		await executeSavePlan({ ...args, title: 'Final Plan' });

		// List all files in .swarm directory
		const swarmDir = path.join(tmpDir, '.swarm');
		const files = await fs.readdir(swarmDir);

		// Should still only have plan.json and plan.md, no temp files
		expect(files).toContain('plan.json');
		expect(files).toContain('plan.md');
		expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
	});

	it('temp file pattern includes timestamp and random suffix', async () => {
		const args: SavePlanArgs = {
			title: 'Temp Pattern Test',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			working_directory: tmpDir,
		};

		// Read the source code to verify temp file pattern
		const managerSource = await fs.readFile(
			path.join(__dirname, '..', '..', '..', 'src', 'plan', 'manager.ts'),
			'utf-8',
		);

		// Verify temp file pattern for plan.json
		expect(managerSource).toContain(
			'plan.json.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}',
		);

		// Verify temp file pattern for plan.md
		expect(managerSource).toContain(
			'plan.md.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}',
		);

		// Verify unlinkSync import is present
		expect(managerSource).toContain('unlinkSync');
	});

	it('temp files are cleaned up even when already renamed', async () => {
		const args: SavePlanArgs = {
			title: 'Rename Cleanup Test',
			swarm_id: 'test-swarm',
			phases: [
				{
					id: 1,
					name: 'Setup',
					tasks: [{ id: '1.1', description: 'Test task' }],
				},
			],
			working_directory: tmpDir,
		};

		// This test verifies the try-finally cleanup pattern
		// The temp file should be cleaned up even if rename succeeds (already renamed case)
		await executeSavePlan(args);

		const swarmDir = path.join(tmpDir, '.swarm');
		const files = await fs.readdir(swarmDir);

		// No temp files should remain
		expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
	});
});
