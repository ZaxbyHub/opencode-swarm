import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCheckpoint, writeCheckpoint } from './checkpoint';
import { savePlan } from './manager';

function createTempDir(): string {
	const dir = join(
		tmpdir(),
		`checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupTempDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
}

describe('writeCheckpoint', () => {
	const validPlan = {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending' as const,
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending' as const,
						size: 'small' as const,
						description: 'Test task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};

	describe('writes SWARM_PLAN.json inside .swarm/', () => {
		test('writes valid JSON matching the plan', async () => {
			const tmpDir = createTempDir();
			try {
				// Create .swarm directory and save a plan
				mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
				await savePlan(tmpDir, validPlan);

				// Write checkpoint
				await writeCheckpoint(tmpDir);

				// Verify SWARM_PLAN.json exists and contains valid JSON
				const jsonPath = join(tmpDir, '.swarm', 'SWARM_PLAN.json');
				expect(existsSync(jsonPath)).toBe(true);

				const content = readFileSync(jsonPath, 'utf8');
				const parsed = JSON.parse(content);

				// Verify plan data matches
				expect(parsed.schema_version).toBe(validPlan.schema_version);
				expect(parsed.title).toBe(validPlan.title);
				expect(parsed.swarm).toBe(validPlan.swarm);
				expect(parsed.current_phase).toBe(validPlan.current_phase);
				expect(parsed.phases).toHaveLength(validPlan.phases.length);
				expect(parsed.phases[0].name).toBe(validPlan.phases[0].name);
				expect(parsed.phases[0].tasks[0].id).toBe(
					validPlan.phases[0].tasks[0].id,
				);
			} finally {
				cleanupTempDir(tmpDir);
			}
		});
	});

	describe('writes SWARM_PLAN.md inside .swarm/', () => {
		test('writes markdown content with plan details', async () => {
			const tmpDir = createTempDir();
			try {
				mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
				await savePlan(tmpDir, validPlan);

				await writeCheckpoint(tmpDir);

				const mdPath = join(tmpDir, '.swarm', 'SWARM_PLAN.md');
				expect(existsSync(mdPath)).toBe(true);

				const content = readFileSync(mdPath, 'utf8');
				expect(content).toContain('# Test Plan');
				expect(content).toContain('Swarm: test-swarm');
				expect(content).toContain('Phase 1');
				expect(content).toContain('Test task');
			} finally {
				cleanupTempDir(tmpDir);
			}
		});
	});

	describe('handles missing plan gracefully', () => {
		test('does NOT throw when no plan.json exists', async () => {
			const tmpDir = createTempDir();
			try {
				// No plan saved - just call writeCheckpoint, must not throw
				await writeCheckpoint(tmpDir);
			} finally {
				cleanupTempDir(tmpDir);
			}
		});

		test('does NOT throw when directory is invalid', async () => {
			// Call with a path that definitely doesn't exist and isn't valid
			const invalidPath = '/this/path/does/not/exist/at/all';
			// Should not throw - non-blocking
			await writeCheckpoint(invalidPath);
		});
	});

	describe('overwrites existing checkpoint files', () => {
		test('overwrites SWARM_PLAN.json on subsequent calls', async () => {
			const tmpDir = createTempDir();
			try {
				mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
				await savePlan(tmpDir, validPlan);

				await writeCheckpoint(tmpDir);

				const jsonPath = join(tmpDir, '.swarm', 'SWARM_PLAN.json');
				const originalContent = readFileSync(jsonPath, 'utf8');

				// Modify the plan and save again
				const modifiedPlan = {
					...validPlan,
					title: 'Modified Plan',
				};
				await savePlan(tmpDir, modifiedPlan);
				await writeCheckpoint(tmpDir);

				const newContent = readFileSync(jsonPath, 'utf8');
				expect(newContent).not.toBe(originalContent);
				expect(newContent).toContain('Modified Plan');
			} finally {
				cleanupTempDir(tmpDir);
			}
		});

		test('overwrites SWARM_PLAN.md on subsequent calls', async () => {
			const tmpDir = createTempDir();
			try {
				mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
				await savePlan(tmpDir, validPlan);

				await writeCheckpoint(tmpDir);

				const mdPath = join(tmpDir, '.swarm', 'SWARM_PLAN.md');
				const originalContent = readFileSync(mdPath, 'utf8');

				// Modify the plan and save again
				const modifiedPlan = {
					...validPlan,
					title: 'Another Plan Title',
				};
				await savePlan(tmpDir, modifiedPlan);
				await writeCheckpoint(tmpDir);

				const newContent = readFileSync(mdPath, 'utf8');
				expect(newContent).not.toBe(originalContent);
				expect(newContent).toContain('Another Plan Title');
			} finally {
				cleanupTempDir(tmpDir);
			}
		});
	});

	describe('checkpoint content matches plan.json', () => {
		test('SWARM_PLAN.json content matches .swarm/plan.json content', async () => {
			const tmpDir = createTempDir();
			try {
				mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
				await savePlan(tmpDir, validPlan);

				await writeCheckpoint(tmpDir);

				// Read both files
				const checkpointPath = join(tmpDir, '.swarm', 'SWARM_PLAN.json');
				const planPath = join(tmpDir, '.swarm', 'plan.json');

				const checkpointContent = readFileSync(checkpointPath, 'utf8');
				const planContent = readFileSync(planPath, 'utf8');

				const checkpointParsed = JSON.parse(checkpointContent);
				const planParsed = JSON.parse(planContent);

				// Core plan data should match
				expect(checkpointParsed.schema_version).toBe(planParsed.schema_version);
				expect(checkpointParsed.title).toBe(planParsed.title);
				expect(checkpointParsed.swarm).toBe(planParsed.swarm);
				expect(checkpointParsed.current_phase).toBe(planParsed.current_phase);
				expect(checkpointParsed.phases).toEqual(planParsed.phases);
			} finally {
				cleanupTempDir(tmpDir);
			}
		});
	});
});

describe('importCheckpoint', () => {
	const validPlan = {
		schema_version: '1.0.0' as const,
		title: 'Import Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending' as const,
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending' as const,
						size: 'small' as const,
						description: 'Test task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};

	test('imports SWARM_PLAN.json and returns success with plan', async () => {
		const tmpDir = createTempDir();
		try {
			mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
			// Write a SWARM_PLAN.json inside .swarm/
			const { writeFileSync } = await import('node:fs');
			writeFileSync(
				join(tmpDir, '.swarm', 'SWARM_PLAN.json'),
				JSON.stringify(validPlan, null, 2),
				'utf8',
			);

			const result = await importCheckpoint(tmpDir);
			expect(result.success).toBe(true);
			expect(result.plan).not.toBeNull();
			expect(result.plan!.title).toBe('Import Test Plan');
		} finally {
			cleanupTempDir(tmpDir);
		}
	});

	test('returns failure when SWARM_PLAN.json does not exist', async () => {
		const tmpDir = createTempDir();
		try {
			mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
			const result = await importCheckpoint(tmpDir);
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			cleanupTempDir(tmpDir);
		}
	});

	test('returns failure when SWARM_PLAN.json is invalid JSON', async () => {
		const tmpDir = createTempDir();
		try {
			mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
			const { writeFileSync } = await import('node:fs');
			writeFileSync(
				join(tmpDir, '.swarm', 'SWARM_PLAN.json'),
				'not valid json',
				'utf8',
			);
			const result = await importCheckpoint(tmpDir);
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		} finally {
			cleanupTempDir(tmpDir);
		}
	});

	test('round-trip: writeCheckpoint then importCheckpoint restores plan', async () => {
		const tmpDir = createTempDir();
		try {
			mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
			await savePlan(tmpDir, validPlan);
			await writeCheckpoint(tmpDir);

			// Now import it back
			const result = await importCheckpoint(tmpDir);
			expect(result.success).toBe(true);
			expect(result.plan!.title).toBe('Import Test Plan');
			expect(result.plan!.phases[0].tasks[0].id).toBe('1.1');
		} finally {
			cleanupTempDir(tmpDir);
		}
	});

	test('imports legacy root-level SWARM_PLAN.json with deprecation warning', async () => {
		const tmpDir = createTempDir();
		try {
			// Note: do NOT create .swarm/SWARM_PLAN.json — we're testing the
			// legacy fallback to the project-root location.
			mkdirSync(join(tmpDir, '.swarm'), { recursive: true });
			const { writeFileSync } = await import('node:fs');
			const rootPath = join(tmpDir, 'SWARM_PLAN.json');
			writeFileSync(rootPath, JSON.stringify(validPlan, null, 2), 'utf8');

			const result = await importCheckpoint(tmpDir);
			expect(result.success).toBe(true);
			expect(result.plan).not.toBeNull();
			expect(result.plan!.title).toBe('Import Test Plan');

			// Verify the savePlan side effect created .swarm/plan.json
			const savedPlanPath = join(tmpDir, '.swarm', 'plan.json');
			expect(existsSync(savedPlanPath)).toBe(true);
		} finally {
			cleanupTempDir(tmpDir);
		}
	});
});
