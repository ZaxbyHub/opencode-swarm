/**
 * Test helper: declare task scopes through the REAL `declare_scope` path.
 *
 * `declare_scope` persists only v2 scope bindings (never the legacy v1
 * `.swarm/scopes/scope-<taskId>.json` projection), and every scheduling
 * consumer (Epic wave planner, Lean Turbo lane planner, Epic decide, the
 * coupling report) resolves declared scopes from that v2 store pinned to the
 * exact plan identity. Fixtures must therefore declare scopes the way the
 * architect does — via `executeDeclareScope` with an authenticated
 * `{ sessionID, messageID }` owner context — after `.swarm/plan.json` exists.
 *
 * Hand-written v1 scope files are intentionally NOT a supported fixture
 * shape: planners ignore them (see the stale-v1 regression tests).
 */

import { clearScopeBindings } from '../../src/scope/scope-binding';
import { flushScopeBindingMaintenance } from '../../src/scope/scope-persistence';
import { executeDeclareScope } from '../../src/tools/declare-scope';

/** Default architect owner used by fixtures that do not care about identity. */
export const TEST_SCOPE_OWNER_SESSION = 'test-architect-session';

let messageCounter = 0;

/**
 * Declare `files` for every task in `taskFiles` via `executeDeclareScope`
 * against the plan currently on disk at `<directory>/.swarm/plan.json`.
 * Throws with the tool's error text when any declaration is rejected so a
 * broken fixture fails loudly instead of silently serializing.
 */
export async function declareScopesForTest(
	directory: string,
	taskFiles: Record<string, string[]>,
	options: { sessionID?: string; replaceExisting?: boolean } = {},
): Promise<void> {
	const sessionID = options.sessionID ?? TEST_SCOPE_OWNER_SESSION;
	for (const [taskId, files] of Object.entries(taskFiles)) {
		messageCounter += 1;
		const result = await executeDeclareScope(
			{
				taskId,
				files,
				...(options.replaceExisting ? { replace_existing: true } : {}),
			},
			directory,
			{ sessionID, messageID: `test-declare-${taskId}-${messageCounter}` },
		);
		if (!result.success) {
			throw new Error(
				`declareScopesForTest: declare_scope(${taskId}) rejected: ${
					result.message
				} ${(result.errors ?? []).join('; ')}`,
			);
		}
	}
}

/**
 * Reset in-memory scope-binding state and drain deferred binding
 * maintenance. Call from `afterEach` (before removing the temp directory) in
 * any file that uses {@link declareScopesForTest}.
 */
export async function resetDeclaredScopesForTest(): Promise<void> {
	clearScopeBindings();
	await flushScopeBindingMaintenance();
}
