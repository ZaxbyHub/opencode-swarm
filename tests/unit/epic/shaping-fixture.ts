/**
 * Shared fixture for the Epic v2 C7 plan-shaping suites: tiny plan builders,
 * `applySuggestion` — which applies a suggestion's patch VERBATIM, exactly
 * as the architect would through save_plan (add the new task(s) to the
 * phase, give each edited task the edit's complete `files_touched` and
 * `depends`, drop `removed_task_ids`) — and plan-validity checks.
 */

import type { EpicPlanningSignals } from '../../../src/epic/planning-signals';
import type {
	EpicShapingPhase,
	EpicShapingTask,
} from '../../../src/epic/shaping-sizing';
import { epicSizingContextFor } from '../../../src/epic/shaping-sizing';
import type { EpicShapingSuggestion } from '../../../src/epic/shaping-suggestions';

export const NO_SIGNALS: EpicPlanningSignals = {
	hotFiles: [],
	coWrites: null,
	cochange: null,
	densityThreshold: 0.3,
};

export const CONTEXT = epicSizingContextFor('/project', {}, 4, NO_SIGNALS);

export function task(
	id: string,
	files: string[],
	extra: Partial<EpicShapingTask> = {},
): EpicShapingTask {
	return {
		id,
		status: 'pending',
		size: 'small',
		description: `task ${id}`,
		depends: [],
		files_touched: files,
		...extra,
	};
}

/**
 * One phase: `hubTasks` tasks touching `hub` + their own file, then
 * `independent` tasks on their own files only.
 */
export function hubPhase(
	hub: string,
	hubTasks: number,
	independent: number,
): EpicShapingPhase {
	const tasks: EpicShapingTask[] = [];
	for (let i = 1; i <= hubTasks; i += 1) {
		tasks.push(task(`1.${i}`, [hub, `src/feature-${i}.ts`]));
	}
	for (let i = 1; i <= independent; i += 1) {
		tasks.push(task(`1.${hubTasks + i}`, [`src/solo-${i}.ts`]));
	}
	return { id: 1, tasks };
}

/** Apply a suggestion's patch verbatim (null for scope advice). */
export function applySuggestion(
	phases: readonly EpicShapingPhase[],
	suggestion: EpicShapingSuggestion,
): EpicShapingPhase[] | null {
	let edits: Array<{
		taskId: string;
		depends: string[];
		files_touched?: string[];
	}>;
	let added: Array<{
		id: string;
		phase: number;
		description: string;
		depends: string[];
		files_touched: string[];
	}> = [];
	let removed: string[] = [];
	switch (suggestion.type) {
		case 'extract-prerequisite':
		case 'isolate-hot-file':
			edits = suggestion.patch.edits;
			added = [suggestion.patch.newTask];
			break;
		case 'split-task':
			edits = suggestion.patch.edits;
			added = suggestion.patch.newTasks;
			break;
		case 'merge-tasks':
			edits = suggestion.patch.edits;
			removed = suggestion.patch.removed_task_ids;
			break;
		default:
			return null;
	}
	const byId = new Map(edits.map((edit) => [edit.taskId, edit]));
	return phases.map((phase) => {
		const tasks = (phase.tasks ?? [])
			.filter((t) => !removed.includes(t.id))
			.map((t) => {
				const edit = byId.get(t.id);
				if (!edit) return t;
				return {
					...t,
					depends: edit.depends,
					...(edit.files_touched ? { files_touched: edit.files_touched } : {}),
				};
			});
		for (const extra of added) {
			if (extra.phase !== phase.id) continue;
			tasks.push({
				id: extra.id,
				status: 'pending',
				size: 'small',
				description: extra.description,
				depends: extra.depends,
				files_touched: extra.files_touched,
			});
		}
		return { ...phase, tasks };
	});
}

/** Validity problems: duplicate/invalid ids, dangling deps, cycles. */
export function planProblems(phases: readonly EpicShapingPhase[]): string[] {
	const problems: string[] = [];
	const deps = new Map<string, readonly string[]>();
	for (const phase of phases) {
		for (const t of phase.tasks ?? []) {
			if (deps.has(t.id)) problems.push(`duplicate ${t.id}`);
			if (!/^\d+\.\d+(\.\d+)*$/.test(t.id)) problems.push(`bad id ${t.id}`);
			deps.set(t.id, t.depends ?? []);
		}
	}
	for (const [id, list] of deps) {
		for (const dep of list)
			if (!deps.has(dep)) problems.push(`dangling ${id}->${dep}`);
	}
	const state = new Map<string, number>();
	const visit = (id: string): boolean => {
		const s = state.get(id) ?? 0;
		if (s === 1) return true;
		if (s === 2) return false;
		state.set(id, 1);
		for (const dep of deps.get(id) ?? [])
			if (deps.has(dep) && visit(dep)) return true;
		state.set(id, 2);
		return false;
	};
	for (const id of deps.keys()) if (visit(id)) problems.push(`cycle at ${id}`);
	return problems;
}

export function ofType<T extends EpicShapingSuggestion['type']>(
	suggestions: readonly EpicShapingSuggestion[],
	type: T,
): Extract<EpicShapingSuggestion, { type: T }> | undefined {
	return suggestions.find((s) => s.type === type) as
		| Extract<EpicShapingSuggestion, { type: T }>
		| undefined;
}
