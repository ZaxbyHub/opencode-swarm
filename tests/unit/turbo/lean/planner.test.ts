/**
 * Tests for Lean Turbo lane planning engine.
 * File: tests/unit/turbo/lean/planner.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LeanTurboConfig } from '../../../../src/config/schema';
import type { ScopeFile } from '../../../../src/turbo/lean/conflicts';
import {
	type PlanPhase,
	type PlanTask,
	planLeanTurboLanes,
} from '../../../../src/turbo/lean/planner';

// Helper to create minimal config
function makeConfig(overrides: Partial<LeanTurboConfig> = {}): LeanTurboConfig {
	return {
		max_parallel_coders: 4,
		require_declared_scope: true,
		conflict_policy: 'serialize',
		degrade_on_risk: true,
		phase_reviewer: true,
		phase_critic: true,
		integrated_diff_required: true,
		allow_docs_only_without_reviewer: false,
		worktree_isolation: false,
		...overrides,
	};
}

// Helper to create a plan with a single phase
function makePlan(tasks: PlanTask[]): { phases: PlanPhase[] } {
	return {
		phases: [
			{
				id: 1,
				name: 'Implementation',
				tasks,
			},
		],
	};
}

describe('planLeanTurboLanes', () => {
	let tempDir: string;
	let scopesDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-planner-test-'));
		scopesDir = path.join(tempDir, '.swarm', 'scopes');
		fs.mkdirSync(scopesDir, { recursive: true });
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('disjoint files produce parallel lanes', () => {
		test('4 tasks with disjoint files produce 1 lane (they can all run in parallel)', () => {
			// Create scope files for each task
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/b.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope3: ScopeFile = {
				taskId: '1.3',
				files: ['src/c.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope4: ScopeFile = {
				taskId: '1.4',
				files: ['src/d.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.3.json'),
				JSON.stringify(scope3),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.4.json'),
				JSON.stringify(scope4),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
				{ id: '1.2', description: 'Task B', status: 'pending' },
				{ id: '1.3', description: 'Task C', status: 'pending' },
				{ id: '1.4', description: 'Task D', status: 'pending' },
			]);

			const result = planLeanTurboLanes(
				tempDir,
				1,
				plan,
				makeConfig({ max_parallel_coders: 4 }),
			);

			// All 4 disjoint tasks go into 1 lane (maximizing parallelism)
			expect(result.lanes.length).toBe(1);
			expect(result.lanes[0].taskIds).toEqual(['1.1', '1.2', '1.3', '1.4']);
			expect(result.counters.tasksSerialized).toBe(0);
			expect(result.counters.tasksDegraded).toBe(0);
		});

		test('max_parallel_coders limits lane count when there are conflicts', () => {
			// Create scenario where we have conflicts that force 2 lanes
			// 1.1: file A, 1.2: file A (conflict), 1.3: file B, 1.4: file B (conflict)
			// With max_parallel_coders=1, 1.3 can't go to lane-0 (conflicts with 1.1/1.2 via same file)
			// Actually, 1.3 file B doesn't conflict with lane-0's file A, so it joins lane-0
			// Let's test that when max is reached, tasks are serialized
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			}; // conflicts with 1.1
			const scope3: ScopeFile = {
				taskId: '1.3',
				files: ['src/b.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			}; // doesn't conflict with 1.1
			const scope4: ScopeFile = {
				taskId: '1.4',
				files: ['src/b.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			}; // conflicts with 1.3

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.3.json'),
				JSON.stringify(scope3),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.4.json'),
				JSON.stringify(scope4),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
				{ id: '1.2', description: 'Task B', status: 'pending' },
				{ id: '1.3', description: 'Task C', status: 'pending' },
				{ id: '1.4', description: 'Task D', status: 'pending' },
			]);

			// With max_parallel_coders=1, lane creation is limited
			const result = planLeanTurboLanes(
				tempDir,
				1,
				plan,
				makeConfig({ max_parallel_coders: 1 }),
			);

			// 1.1 → lane-0
			// 1.2 → serialized (conflicts with lane-0)
			// 1.3 → joins lane-0 (no conflict with 1.1's file A)
			// 1.4 → serialized (conflicts with lane-0 via 1.3's file B)
			expect(result.lanes.length).toBe(1);
			expect(result.counters.tasksSerialized).toBe(2);
		});
	});

	describe('overlapping files serialize', () => {
		test('2 tasks touching same file produce 1 lane and 1 serialized', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task 1', status: 'pending' },
				{ id: '1.2', description: 'Task 2', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			// One task in lane, one serialized
			expect(result.lanes.length).toBe(1);
			expect(result.lanes[0].taskIds.length).toBe(1);
			expect(result.counters.tasksSerialized).toBe(1);
			expect(result.serializedTasks).toContain('1.2');
		});
	});

	describe('parent/child conflict', () => {
		test('task on src/feature and task on src/feature/module.ts serialize', () => {
			// Use non-protected paths for parent/child conflict
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/feature'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/feature/module.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Feature dir task', status: 'pending' },
				{ id: '1.2', description: 'Module file task', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			// Parent/child conflict detected → one serialized
			expect(result.counters.tasksSerialized).toBeGreaterThanOrEqual(1);
		});

		test('src/feature does NOT conflict with src/feature-X.ts', () => {
			// Using paths that look similar but are actually different
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/feature'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/feature-X.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Feature dir task', status: 'pending' },
				{ id: '1.2', description: 'Feature-X task', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			// These should NOT conflict - they're different paths
			expect(result.counters.tasksSerialized).toBe(0);
		});
	});

	describe('unknown scope handling', () => {
		test('task with no scope and require_declared_scope=true is serialized', () => {
			// No scope files created - tasks have no declared scope
			const plan = makePlan([
				{
					id: '1.1',
					description: 'Task with no scope',
					status: 'pending',
					files_touched: ['src/a.ts'],
				},
			]);

			const result = planLeanTurboLanes(
				tempDir,
				1,
				plan,
				makeConfig({ require_declared_scope: true }),
			);

			expect(result.counters.tasksSerialized).toBe(1);
			expect(result.serializedTasks).toContain('1.1');
		});

		test('task with no scope and require_declared_scope=false uses files_touched', () => {
			const plan = makePlan([
				{
					id: '1.1',
					description: 'Task with no declared scope',
					status: 'pending',
					files_touched: ['src/a.ts'],
				},
			]);

			const result = planLeanTurboLanes(
				tempDir,
				1,
				plan,
				makeConfig({ require_declared_scope: false }),
			);

			// Should be in a lane (not serialized) since we fall back to files_touched
			expect(result.counters.tasksSerialized).toBe(0);
			expect(result.lanes.length).toBe(1);
		});
	});

	describe('global file degradation', () => {
		test('task touching package.json is degraded', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['package.json'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Update dependencies', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.counters.tasksDegraded).toBe(1);
			expect(result.degradedTasks[0].reason).toBe('global file conflict');
			expect(
				result.degradedTasks[0].files.map((f) =>
					f.toLowerCase().replace(/\\/g, '/'),
				),
			).toEqual([
				path.join(tempDir, 'package.json').toLowerCase().replace(/\\/g, '/'),
			]);
		});

		test('task touching lockfile is degraded', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['package-lock.json'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Update lockfile', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.counters.tasksDegraded).toBe(1);
			expect(result.degradedTasks[0].reason).toBe('global file conflict');
		});

		test('task touching barrel file is degraded', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/index.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Update barrel', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.counters.tasksDegraded).toBe(1);
			expect(result.degradedTasks[0].reason).toBe('global file conflict');
		});
	});

	describe('protected path degradation', () => {
		test('task touching guardrails.ts is degraded', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/guardrails.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Update guardrails', status: 'pending' },
			]);

			const result = planLeanTurboLanes(
				tempDir,
				1,
				plan,
				makeConfig({ degrade_on_risk: true }),
			);

			expect(result.counters.tasksDegraded).toBe(1);
			expect(result.degradedTasks[0].reason).toBe('protected path');
		});

		test('protected path task is serialized when degrade_on_risk=false', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/guardrails.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Update guardrails', status: 'pending' },
			]);

			const result = planLeanTurboLanes(
				tempDir,
				1,
				plan,
				makeConfig({ degrade_on_risk: false }),
			);

			expect(result.counters.tasksSerialized).toBe(1);
			expect(result.counters.tasksDegraded).toBe(0);
		});

		test('auth path task is degraded', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/auth/login.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Update auth', status: 'pending' },
			]);

			const result = planLeanTurboLanes(
				tempDir,
				1,
				plan,
				makeConfig({ degrade_on_risk: true }),
			);

			expect(result.counters.tasksDegraded).toBe(1);
			expect(result.degradedTasks[0].reason).toBe('protected path');
		});
	});

	describe('symlink/traversal rejection', () => {
		test('paths with .. are rejected and serialized', () => {
			// Scope with unsafe path containing ..
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['../src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{
					id: '1.1',
					description: 'Task with traversal path',
					status: 'pending',
				},
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			// Invalid scope (has ..) should be serialized
			expect(result.counters.tasksSerialized).toBe(1);
		});

		test('symlink path is handled correctly (accepted when no traversal in path string)', () => {
			// Create a real file and a symlink pointing to it
			const realDir = path.join(tempDir, 'realdir');
			const realFile = path.join(realDir, 'file.ts');
			fs.mkdirSync(realDir, { recursive: true });
			fs.writeFileSync(realFile, 'content');

			// Create symlink to the real directory
			const symlinkDir = path.join(tempDir, 'symlinkdir');
			fs.symlinkSync(realDir, symlinkDir, 'junction');

			// Use symlink path in a scope - the path itself doesn't contain '..'
			// so isPathSafe considers it valid (symlink resolution happens at runtime)
			const symlinkScopePath = path.join(symlinkDir, 'file.ts');
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: [symlinkScopePath],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task with symlink path', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			// Symlink path is accepted by isPathSafe (no '..' in path string)
			// The actual symlink traversal protection happens at execution time via lock system
			expect(result.counters.tasksSerialized).toBe(0);
			expect(result.lanes.length).toBe(1);
		});
	});

	describe('deterministic ordering', () => {
		test('same input produces same lane plan', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/b.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
				{ id: '1.2', description: 'Task B', status: 'pending' },
			]);

			const config = makeConfig();

			const result1 = planLeanTurboLanes(tempDir, 1, plan, config);
			const result2 = planLeanTurboLanes(tempDir, 1, plan, config);

			// Lanes should have same structure
			expect(result1.lanes.length).toBe(result2.lanes.length);
			// Task IDs in lanes should be in same order
			for (let i = 0; i < result1.lanes.length; i++) {
				expect(result1.lanes[i].taskIds).toEqual(result2.lanes[i].taskIds);
			}
		});
	});

	describe('degradation summary', () => {
		test('all tasks degraded produces degradationSummary with specific counts', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['package.json'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/guardrails.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Update package.json', status: 'pending' },
				{ id: '1.2', description: 'Update guardrails', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.degradationSummary).toBeDefined();
			expect(result.degradationSummary).toContain('degraded');
			// Assert specific degraded task counts
			expect(result.degradedTasks.length).toBe(2);
			expect(result.counters.tasksDegraded).toBe(2);
			// Assert specific task IDs and reasons
			const degradedIds = result.degradedTasks.map((t) => t.taskId).sort();
			expect(degradedIds).toEqual(['1.1', '1.2']);
			const reasons = result.degradedTasks.map((t) => t.reason);
			expect(reasons).toContain('global file conflict');
			expect(reasons).toContain('protected path');
		});
	});

	describe('dependency ordering', () => {
		test('B depends on A, disjoint files → B joins same lane as A', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/b.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
				{
					id: '1.2',
					description: 'Task B',
					status: 'pending',
					depends: ['1.1'],
				},
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			// B should be in the same lane as A (since they have no file conflicts)
			expect(result.lanes.length).toBe(1);
			const lane = result.lanes[0];
			expect(lane.taskIds).toContain('1.1');
			expect(lane.taskIds).toContain('1.2');
			// Assert strict relative order — dependency must come before dependent
			const depIndex = lane.taskIds.indexOf('1.1');
			const dependentIndex = lane.taskIds.indexOf('1.2');
			expect(depIndex).toBeLessThan(dependentIndex);
		});
	});

	describe('cross-lane dependencies', () => {
		test('B depends on A but would be in different lane → B serialized', () => {
			// Set up: A on file-a, B on file-b, C on file-c, D on file-d
			// A and B conflict (both on same file), C and D don't conflict with A or B
			// If we limit to 1 lane, B would be in a different lane than A
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			}; // conflicts with 1.1

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			// B (1.2) depends on A (1.1) - they conflict, so B should be serialized
			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
				{
					id: '1.2',
					description: 'Task B',
					status: 'pending',
					depends: ['1.1'],
				},
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			// Since B depends on A and they conflict, B should be serialized
			expect(result.serializedTasks).toContain('1.2');
		});
	});

	describe('cycle handling', () => {
		test('A depends on B, B depends on A → both serialized', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/b.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			// Circular dependency: A depends on B, B depends on A
			const plan = makePlan([
				{
					id: '1.1',
					description: 'Task A',
					status: 'pending',
					depends: ['1.2'],
				},
				{
					id: '1.2',
					description: 'Task B',
					status: 'pending',
					depends: ['1.1'],
				},
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			// Both tasks in cycle should be serialized
			expect(result.serializedTasks).toContain('1.1');
			expect(result.serializedTasks).toContain('1.2');
		});
	});

	describe('empty phase handling', () => {
		test('no tasks produces empty plan', () => {
			const plan = makePlan([]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.lanes.length).toBe(0);
			expect(result.serializedTasks.length).toBe(0);
			expect(result.degradedTasks.length).toBe(0);
			expect(result.counters.tasksSerialized).toBe(0);
			expect(result.counters.tasksDegraded).toBe(0);
		});
	});

	describe('all completed tasks', () => {
		test('all tasks completed produces empty plan', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/b.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'completed' },
				{ id: '1.2', description: 'Task B', status: 'completed' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.lanes.length).toBe(0);
			expect(result.counters.tasksSerialized).toBe(0);
		});
	});

	describe('phase not found', () => {
		test('returns empty plan for non-existent phase', () => {
			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 999, plan, makeConfig());

			expect(result.lanes.length).toBe(0);
		});
	});

	describe('scopes map parameter', () => {
		test('pre-loaded scopes are used instead of reading files', () => {
			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
				{ id: '1.2', description: 'Task B', status: 'pending' },
			]);

			// Provide scopes via the scopes parameter
			const scopes: Record<string, string[]> = {
				'1.1': ['src/a.ts'],
				'1.2': ['src/b.ts'],
			};

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig(), scopes);

			// Should use provided scopes - both tasks in 1 lane since files are disjoint
			expect(result.lanes.length).toBe(1);
			expect(result.lanes[0].taskIds).toEqual(['1.1', '1.2']);
			expect(result.counters.tasksSerialized).toBe(0);
		});

		test('scopes parameter takes precedence over files', () => {
			const scopeFile: ScopeFile = {
				taskId: '1.1',
				files: ['src/wrong.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scopeFile),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
			]);

			// Override with scopes parameter
			const scopes: Record<string, string[]> = {
				'1.1': ['src/correct.ts'],
			};

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig(), scopes);

			// Should use provided scope, not the file
			expect(
				result.lanes[0].files.map((f) => f.toLowerCase().replace(/\\/g, '/')),
			).toContain(
				path.join(tempDir, 'src/correct.ts').toLowerCase().replace(/\\/g, '/'),
			);
			expect(result.lanes[0].files).not.toContain('src/wrong.ts');
		});
	});

	describe('conflict_policy degrade', () => {
		test('conflicting tasks are degraded when conflict_policy is degrade', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
				{ id: '1.2', description: 'Task B', status: 'pending' },
			]);

			const result = planLeanTurboLanes(
				tempDir,
				1,
				plan,
				makeConfig({ conflict_policy: 'degrade' }),
			);

			expect(result.counters.tasksDegraded).toBeGreaterThan(0);
		});
	});

	describe('invalid scope handling', () => {
		test('task with invalid scope (path traversal) is serialized', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['../../../etc/passwd'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Malicious task', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.counters.tasksSerialized).toBe(1);
		});
	});

	describe('lane structure validation', () => {
		test('lanes have correct structure', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.lanes.length).toBe(1);
			expect(result.lanes[0].laneId).toMatch(/^lane-\d+$/);
			expect(result.lanes[0].taskIds).toEqual(['1.1']);
			expect(
				result.lanes[0].files.map((f) => f.toLowerCase().replace(/\\/g, '/')),
			).toEqual([
				path.join(tempDir, 'src/a.ts').toLowerCase().replace(/\\/g, '/'),
			]);
			expect(result.lanes[0].status).toBe('pending');
		});
	});

	describe('counters validation', () => {
		test('counters are correctly populated', () => {
			const scope1: ScopeFile = {
				taskId: '1.1',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			};
			const scope2: ScopeFile = {
				taskId: '1.2',
				files: ['src/a.ts'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			}; // conflicts
			const scope3: ScopeFile = {
				taskId: '1.3',
				files: ['package.json'],
				declaredAt: '2024-01-01T00:00:00.000Z',
			}; // global

			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.1.json'),
				JSON.stringify(scope1),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.2.json'),
				JSON.stringify(scope2),
			);
			fs.writeFileSync(
				path.join(scopesDir, 'scope-1.3.json'),
				JSON.stringify(scope3),
			);

			const plan = makePlan([
				{ id: '1.1', description: 'Task A', status: 'pending' },
				{ id: '1.2', description: 'Task B', status: 'pending' },
				{ id: '1.3', description: 'Task C', status: 'pending' },
			]);

			const result = planLeanTurboLanes(tempDir, 1, plan, makeConfig());

			expect(result.counters.lanesPlanned).toBe(result.lanes.length);
			expect(result.counters.tasksSerialized).toBe(
				result.serializedTasks.length,
			);
			expect(result.counters.tasksDegraded).toBe(result.degradedTasks.length);
			expect(result.counters.lanesStarted).toBe(0);
			expect(result.counters.lanesCompleted).toBe(0);
			expect(result.counters.lanesFailed).toBe(0);
		});
	});
});
