import * as fs from 'node:fs';
import { ZodError, z } from 'zod';

export interface TaskNode {
	id: string;
	phase: number;
	description: string;
	depends: string[];
	dependents: string[];
	status: 'pending' | 'in_progress' | 'complete' | 'blocked';
}

export interface DependencyGraph {
	tasks: Map<string, TaskNode>;
	phases: Map<number, string[]>;
	roots: string[]; // Tasks with no dependencies
	leaves: string[]; // Tasks with no dependents
}

const DependencyGraphPlanSchema = z
	.object({
		phases: z
			.array(
				z
					.object({
						id: z.number(),
						tasks: z
							.array(
								z
									.object({
										id: z.string(),
										description: z.string().optional(),
										depends: z.array(z.string()).optional(),
										status: z.string().optional(),
									})
									.passthrough(),
							)
							.optional(),
					})
					.passthrough(),
			)
			.optional(),
	})
	.passthrough();

/**
 * Parse plan.json and build dependency graph
 */
export function parseDependencyGraph(planPath: string): DependencyGraph {
	const tasks = new Map<string, TaskNode>();
	const phases = new Map<number, string[]>();

	if (!fs.existsSync(planPath)) {
		return { tasks, phases, roots: [], leaves: [] };
	}

	let plan: z.infer<typeof DependencyGraphPlanSchema>;
	try {
		plan = DependencyGraphPlanSchema.parse(
			JSON.parse(fs.readFileSync(planPath, 'utf-8')),
		);
	} catch (error) {
		const detail =
			error instanceof ZodError
				? `schema validation failed: ${error.message}`
				: error instanceof Error
					? error.message
					: String(error);
		console.error(`[dependency-graph] Failed to parse ${planPath}:`, detail);
		return { tasks, phases, roots: [], leaves: [] };
	}

	// First pass: create all task nodes
	for (const phase of plan.phases || []) {
		if (phase == null) continue;
		const phaseId = phase.id;
		phases.set(phaseId, []);

		const phaseTasks = Array.isArray(phase.tasks) ? phase.tasks : [];
		for (const task of phaseTasks) {
			if (task == null) continue;
			const taskId = task.id;
			phases.get(phaseId)?.push(taskId);

			tasks.set(taskId, {
				id: taskId,
				phase: phaseId,
				description: task.description || '',
				depends: task.depends || [],
				dependents: [],
				status:
					task.status === 'pending' ||
					task.status === 'in_progress' ||
					task.status === 'complete' ||
					task.status === 'blocked'
						? task.status
						: 'pending',
			});
		}
	}

	// Second pass: build dependent relationships
	for (const [taskId, task] of tasks) {
		for (const depId of task.depends) {
			const dep = tasks.get(depId);
			if (dep) {
				dep.dependents.push(taskId);
			}
		}
	}

	// Find roots (no dependencies) and leaves (no dependents)
	const roots: string[] = [];
	const leaves: string[] = [];

	for (const [taskId, task] of tasks) {
		if (task.depends.length === 0) {
			roots.push(taskId);
		}
		if (task.dependents.length === 0) {
			leaves.push(taskId);
		}
	}

	return { tasks, phases, roots, leaves };
}

/**
 * Get tasks that can run in parallel (no unresolved dependencies)
 */
export function getRunnableTasks(graph: DependencyGraph): string[] {
	const runnable: string[] = [];

	for (const [taskId, task] of graph.tasks) {
		if (task.status !== 'pending') {
			continue;
		}

		// Check if all dependencies are complete
		const allDepsComplete = task.depends.every((depId) => {
			const dep = graph.tasks.get(depId);
			return dep?.status === 'complete';
		});

		if (allDepsComplete) {
			runnable.push(taskId);
		}
	}

	return runnable;
}

/**
 * Check if a task is blocked (has incomplete dependencies)
 */
export function isTaskBlocked(graph: DependencyGraph, taskId: string): boolean {
	const task = graph.tasks.get(taskId);
	if (!task) return true;

	return task.depends.some((depId) => {
		const dep = graph.tasks.get(depId);
		return dep?.status !== 'complete';
	});
}

/**
 * Get execution order (topological sort)
 */
export function getExecutionOrder(graph: DependencyGraph): string[] {
	const order: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	function visit(taskId: string): void {
		if (visited.has(taskId)) return;
		if (visiting.has(taskId)) {
			throw new Error(`Circular dependency detected: ${taskId}`);
		}

		visiting.add(taskId);
		const task = graph.tasks.get(taskId);

		if (task) {
			for (const depId of task.depends) {
				visit(depId);
			}
		}

		visiting.delete(taskId);
		visited.add(taskId);
		order.push(taskId);
	}

	for (const taskId of graph.tasks.keys()) {
		visit(taskId);
	}

	return order;
}

/**
 * Find all paths from root to a task
 */
export function getDependencyChain(
	graph: DependencyGraph,
	taskId: string,
): string[] {
	const chain: string[] = [];
	const visited = new Set<string>();
	const recursing = new Set<string>();

	function collect(id: string): void {
		if (recursing.has(id)) {
			console.warn(`[dependency-graph] Circular dependency detected: ${id}`);
			return;
		}
		if (visited.has(id)) return;

		recursing.add(id);
		visited.add(id);

		const task = graph.tasks.get(id);
		if (task) {
			for (const depId of task.depends) {
				collect(depId);
			}
			chain.push(id);
		}

		recursing.delete(id);
	}

	collect(taskId);
	return chain;
}
