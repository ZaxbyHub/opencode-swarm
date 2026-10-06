/**
 * Epic Mode declared-scope resolution (v2 binding store only).
 *
 * `declare_scope` persists ONLY v2 scope bindings in the authoritative
 * coordination store; nothing in production writes the legacy v1
 * `.swarm/scopes/scope-<taskId>.json` projection any more. Every Epic
 * scheduling consumer (`epic_next_wave`, the `/swarm epic start` sizing
 * preview, `/swarm coupling`) therefore resolves declared scopes
 * here, using the same upstream readers `src/plan/parallel-verdict.ts` uses:
 *
 *   - ONE `readAuthoritativeScopeBindingSet` scan per call (#2532 hoisting),
 *   - `readDeclaredScopeFilesFromBindings` per task, pinned to the exact plan
 *     identity (`planId` + `planStructureHash`), live + unexpired only.
 *
 * The result maps EVERY requested task id to a file list — `[]` when the task
 * has no live, agreeing, non-empty binding (undeclared, expired, declared
 * against an older plan revision, store unreadable/overloaded, or no plan).
 * Passing that map as the explicit `scopes` argument of the shared partition
 * preflight (`runPartitionPreflight`) guarantees the preflight never falls
 * back to its own v1 file read for an Epic task: upstream treats an explicit
 * `[]` entry as "effectively undeclared", which then takes exactly the
 * `files_touched` fallback that `require_declared_scope` permits — the same
 * semantics the preflight applies to an undeclared task.
 *
 * Nothing here is write authority: these are scheduling reads.
 */

import type { Plan } from '../config/plan-schema.js';
import type { ScopeBinding } from '../scope/scope-binding.js';
import {
	readAuthoritativeScopeBindingSet,
	readDeclaredScopeFilesFromBindings,
} from '../scope/scope-persistence.js';

/**
 * Resolve the live declared scope of each task from the v2 binding store.
 *
 * @param directory - Project root (binding-store location).
 * @param plan - The plan the scopes must be pinned to. `null` (unreadable /
 *        invalid plan) resolves every task to `[]` without touching the store.
 * @param taskIds - Tasks to resolve. Every id appears in the result.
 * @returns `taskId -> files` (`[]` = no live declared scope).
 */
export function resolveEpicDeclaredScopes(
	directory: string,
	plan: Plan | null,
	taskIds: readonly string[],
): Record<string, string[]> {
	const result: Record<string, string[]> = Object.create(null);
	for (const taskId of taskIds) result[taskId] = [];
	if (plan === null || taskIds.length === 0) return result;

	// ONE binding-set scan for the whole call, shared by every task. A null
	// set (store unreadable / overloaded) makes every lookup return null.
	let bindingSet: ScopeBinding[] | null;
	try {
		bindingSet = readAuthoritativeScopeBindingSet(directory);
	} catch {
		bindingSet = null;
	}
	if (bindingSet === null || bindingSet.length === 0) return result;

	// Only tasks with a binding in the set can resolve to a scope: skip the
	// per-task lookup (which hashes the plan structure) for the others.
	const bound = new Set(bindingSet.map((binding) => binding.taskId));
	for (const taskId of taskIds) {
		if (!bound.has(taskId)) continue;
		let files: string[] | null = null;
		try {
			files = readDeclaredScopeFilesFromBindings({
				directory,
				taskId,
				plan,
				bindingSet,
			});
		} catch {
			files = null;
		}
		result[taskId] = files && files.length > 0 ? [...files] : [];
	}
	return result;
}
