/**
 * Verification tests for dependency-graph module
 * Covers parseDependencyGraph, getRunnableTasks, and getExecutionOrder
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type DependencyGraph,
	getDependencyChain,
	getExecutionOrder,
	getRunnableTasks,
	isTaskBlocked,
	parseDependencyGraph,
} from '../../../src/parallel/dependency-graph';

describe('dependency-graph module tests', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-graph-test-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== GROUP 1: parseDependencyGraph tests ==========
	describe('Group 1: parseDependencyGraph', () => {
		it('builds graph from plan.json', () => {
			const planPath = path.join(tmpDir, 'plan.json');
			fs.writeFileSync(
				planPath,
				JSON.stringify({
					phases: [
						{
							id: 1,
							tasks: [
								{ id: '1.1', description: 'Task 1', status: 'pending' },
								{
									id: '1.2',
									description: 'Task 2',
									depends: ['1.1'],
									status: 'pending',
								},
							],
						},
						{
							id: 2,
							tasks: [
								{
									id: '2.1',
									description: 'Task 3',
									depends: ['1.2'],
									status: 'pending',
								},
							],
						},
					],
				}),
			);

			const graph = parseDependencyGraph(planPath);

			expect(graph.tasks.size).toBe(3);
			expect(graph.tasks.get('1.1')?.description).toBe('Task 1');
			expect(graph.tasks.get('1.2')?.depends).toEqual(['1.1']);
			expect(graph.tasks.get('1.2')?.dependents).toContain('2.1');
		});

		it('returns empty graph for non-existent file', () => {
			const graph = parseDependencyGraph(path.join(tmpDir, 'nonexistent.json'));
			expect(graph.tasks.size).toBe(0);
			expect(graph.phases.size).toBe(0);
			expect(graph.roots).toEqual([]);
		});

		it('returns empty graph for schema-invalid plan content', () => {
			const planPath = path.join(tmpDir, 'invalid-schema-plan.json');
			fs.writeFileSync(
				planPath,
				JSON.stringify({
					phases: [
						{
							id: 1,
							tasks: [{ id: 123, status: 'in_progress' }],
						},
					],
				}),
			);

			const graph = parseDependencyGraph(planPath);
			expect(graph.tasks.size).toBe(0);
			expect(graph.phases.size).toBe(0);
			expect(graph.roots).toEqual([]);
			expect(graph.leaves).toEqual([]);
		});

		it('identifies roots (tasks with no dependencies)', () => {
			const planPath = path.join(tmpDir, 'plan.json');
			fs.writeFileSync(
				planPath,
				JSON.stringify({
					phases: [
						{
							id: 1,
							tasks: [
								{ id: '1.1', description: 'Root task', depends: [] },
								{ id: '1.2', description: 'Dependent task', depends: ['1.1'] },
							],
						},
					],
				}),
			);

			const graph = parseDependencyGraph(planPath);
			expect(graph.roots).toContain('1.1');
			expect(graph.roots).not.toContain('1.2');
		});

		it('identifies leaves (tasks with no dependents)', () => {
			const planPath = path.join(tmpDir, 'plan.json');
			fs.writeFileSync(
				planPath,
				JSON.stringify({
					phases: [
						{
							id: 1,
							tasks: [
								{ id: '1.1', description: 'Root' },
								{ id: '1.2', description: 'Middle', depends: ['1.1'] },
								{ id: '1.3', description: 'Leaf', depends: ['1.2'] },
							],
						},
					],
				}),
			);

			const graph = parseDependencyGraph(planPath);
			expect(graph.leaves).toContain('1.3');
			expect(graph.leaves).not.toContain('1.1');
		});

		it('organizes tasks by phase', () => {
			const planPath = path.join(tmpDir, 'plan.json');
			fs.writeFileSync(
				planPath,
				JSON.stringify({
					phases: [
						{ id: 1, tasks: [{ id: '1.1' }, { id: '1.2' }] },
						{ id: 2, tasks: [{ id: '2.1' }] },
					],
				}),
			);

			const graph = parseDependencyGraph(planPath);
			expect(graph.phases.get(1)).toEqual(['1.1', '1.2']);
			expect(graph.phases.get(2)).toEqual(['2.1']);
		});
	});

	// ========== GROUP 2: getRunnableTasks tests ==========
	describe('Group 2: getRunnableTasks', () => {
		it('returns tasks with no dependencies', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'1.1',
						{
							id: '1.1',
							phase: 1,
							description: '',
							depends: [],
							dependents: [],
							status: 'pending',
						},
					],
					[
						'1.2',
						{
							id: '1.2',
							phase: 1,
							description: '',
							depends: ['1.1'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['1.1'],
				leaves: ['1.2'],
			};

			const runnable = getRunnableTasks(graph);
			expect(runnable).toContain('1.1');
			expect(runnable).not.toContain('1.2');
		});

		it('returns tasks with all dependencies complete', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'1.1',
						{
							id: '1.1',
							phase: 1,
							description: '',
							depends: [],
							dependents: ['1.2'],
							status: 'complete',
						},
					],
					[
						'1.2',
						{
							id: '1.2',
							phase: 1,
							description: '',
							depends: ['1.1'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['1.1'],
				leaves: ['1.2'],
			};

			const runnable = getRunnableTasks(graph);
			expect(runnable).toContain('1.2');
		});

		it('excludes tasks with incomplete dependencies', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'1.1',
						{
							id: '1.1',
							phase: 1,
							description: '',
							depends: [],
							dependents: ['1.2'],
							status: 'in_progress',
						},
					],
					[
						'1.2',
						{
							id: '1.2',
							phase: 1,
							description: '',
							depends: ['1.1'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['1.1'],
				leaves: ['1.2'],
			};

			const runnable = getRunnableTasks(graph);
			expect(runnable).not.toContain('1.2');
		});

		it('excludes non-pending tasks', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'1.1',
						{
							id: '1.1',
							phase: 1,
							description: '',
							depends: [],
							dependents: [],
							status: 'complete',
						},
					],
					[
						'1.2',
						{
							id: '1.2',
							phase: 1,
							description: '',
							depends: [],
							dependents: [],
							status: 'in_progress',
						},
					],
					[
						'1.3',
						{
							id: '1.3',
							phase: 1,
							description: '',
							depends: [],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['1.1', '1.2', '1.3'],
				leaves: ['1.1', '1.2', '1.3'],
			};

			const runnable = getRunnableTasks(graph);
			expect(runnable).toEqual(['1.3']);
		});
	});

	// ========== GROUP 3: getExecutionOrder tests ==========
	describe('Group 3: getExecutionOrder', () => {
		it('returns topological sort order', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'1.1',
						{
							id: '1.1',
							phase: 1,
							description: '',
							depends: [],
							dependents: ['1.2'],
							status: 'pending',
						},
					],
					[
						'1.2',
						{
							id: '1.2',
							phase: 1,
							description: '',
							depends: ['1.1'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['1.1'],
				leaves: ['1.2'],
			};

			const order = getExecutionOrder(graph);
			expect(order.indexOf('1.1')).toBeLessThan(order.indexOf('1.2'));
		});

		it('handles complex dependency chains', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'a',
						{
							id: 'a',
							phase: 1,
							description: '',
							depends: [],
							dependents: ['b', 'c'],
							status: 'pending',
						},
					],
					[
						'b',
						{
							id: 'b',
							phase: 1,
							description: '',
							depends: ['a'],
							dependents: ['d'],
							status: 'pending',
						},
					],
					[
						'c',
						{
							id: 'c',
							phase: 1,
							description: '',
							depends: ['a'],
							dependents: ['d'],
							status: 'pending',
						},
					],
					[
						'd',
						{
							id: 'd',
							phase: 1,
							description: '',
							depends: ['b', 'c'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['a'],
				leaves: ['d'],
			};

			const order = getExecutionOrder(graph);
			// a must come first, d must come last
			expect(order[0]).toBe('a');
			expect(order[order.length - 1]).toBe('d');
		});

		it('throws on circular dependency', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'a',
						{
							id: 'a',
							phase: 1,
							description: '',
							depends: ['b'],
							dependents: [],
							status: 'pending',
						},
					],
					[
						'b',
						{
							id: 'b',
							phase: 1,
							description: '',
							depends: ['a'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['a'],
				leaves: ['b'],
			};

			expect(() => getExecutionOrder(graph)).toThrow('Circular dependency');
		});
	});

	// ========== GROUP 4: isTaskBlocked tests ==========
	describe('Group 4: isTaskBlocked', () => {
		it('returns false for task with no dependencies', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'1.1',
						{
							id: '1.1',
							phase: 1,
							description: '',
							depends: [],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['1.1'],
				leaves: ['1.1'],
			};

			expect(isTaskBlocked(graph, '1.1')).toBe(false);
		});

		it('returns true for task with incomplete dependency', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'1.1',
						{
							id: '1.1',
							phase: 1,
							description: '',
							depends: [],
							dependents: ['1.2'],
							status: 'pending',
						},
					],
					[
						'1.2',
						{
							id: '1.2',
							phase: 1,
							description: '',
							depends: ['1.1'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['1.1'],
				leaves: ['1.2'],
			};

			expect(isTaskBlocked(graph, '1.2')).toBe(true);
		});

		it('returns false for task with complete dependencies', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'1.1',
						{
							id: '1.1',
							phase: 1,
							description: '',
							depends: [],
							dependents: ['1.2'],
							status: 'complete',
						},
					],
					[
						'1.2',
						{
							id: '1.2',
							phase: 1,
							description: '',
							depends: ['1.1'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['1.1'],
				leaves: ['1.2'],
			};

			expect(isTaskBlocked(graph, '1.2')).toBe(false);
		});

		it('returns true for non-existent task', () => {
			const graph: DependencyGraph = {
				tasks: new Map(),
				phases: new Map(),
				roots: [],
				leaves: [],
			};

			expect(isTaskBlocked(graph, 'nonexistent')).toBe(true);
		});
	});

	// ========== GROUP 5: getDependencyChain tests ==========
	describe('Group 5: getDependencyChain', () => {
		it('returns dependency chain for a task', () => {
			const graph: DependencyGraph = {
				tasks: new Map([
					[
						'a',
						{
							id: 'a',
							phase: 1,
							description: '',
							depends: [],
							dependents: ['b'],
							status: 'pending',
						},
					],
					[
						'b',
						{
							id: 'b',
							phase: 1,
							description: '',
							depends: ['a'],
							dependents: ['c'],
							status: 'pending',
						},
					],
					[
						'c',
						{
							id: 'c',
							phase: 1,
							description: '',
							depends: ['b'],
							dependents: [],
							status: 'pending',
						},
					],
				]),
				phases: new Map(),
				roots: ['a'],
				leaves: ['c'],
			};

			const chain = getDependencyChain(graph, 'c');
			expect(chain).toContain('a');
			expect(chain).toContain('b');
			expect(chain).toContain('c');
		});
	});
});
