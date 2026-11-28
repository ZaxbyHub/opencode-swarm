/**
 * session.idle must not revoke a delegated coder's scope — the mid-task
 * scope-detachment fix.
 *
 * Field incidents (2.15 / 3.8 / 3.11): a coder child session that ends its
 * turn while a background shell (or other deferred work) is still in flight
 * goes idle MID-TASK and wakes on the completion notification. The plugin's
 * terminal-session-event consumer treated session.idle as terminal and
 * called delegationGateHooks.sessionEnded(), which clears every scope
 * binding the session owns (in-memory AND durable) and nulls
 * currentTaskId/declaredCoderScope — so the coder's next write was refused
 * with SCOPE_NOT_DECLARED ('task unknown') and the round could never
 * re-authorize. Only true removal (session.deleted / session.removed)
 * revokes scope now; the v2 adapter already refuses to map live busy/retry
 * to session.idle for the same class (#3022).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { loadPlanJsonOnly } from '../../src/plan/manager';
import { createScopeBinding } from '../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	resolveAuthorizedScopeBindingForSession,
} from '../../src/scope/scope-persistence';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host';
import { safeRmRecursive } from '../helpers/safe-test-dir';

const PARENT = 'architect-session';
const CHILD = 'coder-child';
const TASK = '1.1';

describe('session.idle must not revoke a delegated coder scope', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		closeAllProjectDbs();
		safeRmRecursive(directory);
	});

	async function claimedActiveCoderBinding(): Promise<void> {
		const plan = await loadPlanJsonOnly(directory);
		expect(plan).not.toBeNull();
		const files = plan!.phases[0]!.tasks.find((task) => task.id === TASK)
			?.files_touched ?? ['src/index.ts'];
		const declaration = createScopeBinding({
			directory,
			plan: plan!,
			taskId: TASK,
			files,
			ownerSessionId: PARENT,
			ownerMessageId: 'task-call',
			dispatchCallId: 'task-call',
			activation: 'pending_child',
			source: 'plan',
		});
		expect(declaration).not.toBeNull();
		const persisted = await persistAndRegisterScopeBinding(
			directory,
			declaration!,
		);
		expect(persisted.ok).toBe(true);
		const claim = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: PARENT,
			childSessionId: CHILD,
			dispatchCallId: 'task-call',
		});
		expect(claim.ok).toBe(true);
		// The coder child session holds the task context the scope guard
		// reads (currentTaskId drives the task correlation of write checks).
		const child = ensureAgentSession(CHILD, 'coder', directory);
		child.currentTaskId = TASK;
		child.declaredCoderScope = [...files];
	}

	test('idle keeps the binding and task context; deleted revokes both', async () => {
		const plugin = await bootKnowledgeHost(directory, {
			hooks: { background_subagents: true },
		});
		await claimedActiveCoderBinding();

		// Baseline: the claimed dispatch-correlated binding authorizes the
		// child session (durable resolution — the surface the scope guard
		// reads after an in-memory restart, and the surface the old bug
		// cleared on disk).
		expect(
			resolveAuthorizedScopeBindingForSession({
				directory,
				activeSessionId: CHILD,
			}),
		).not.toBeNull();
		expect(
			resolveAuthorizedScopeBindingForSession({
				directory,
				activeSessionId: CHILD,
			})?.taskId,
		).toBe(TASK);

		// The coder's turn ends while a background shell is still in flight —
		// the host reports the session idle. This is NOT a terminal boundary:
		// the scope binding and the task context must survive the wake.
		await plugin.hooks.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: CHILD },
			},
		});
		expect(
			resolveAuthorizedScopeBindingForSession({
				directory,
				activeSessionId: CHILD,
			}),
		).not.toBeNull();
		const afterIdle = ensureAgentSession(CHILD, 'coder', directory);
		expect(afterIdle.currentTaskId).toBe(TASK);
		expect(afterIdle.declaredCoderScope).not.toBeNull();

		// True removal (session.deleted) is the terminal boundary: scope
		// ownership is revoked, in-memory AND durable.
		await plugin.hooks.event({
			event: {
				type: 'session.deleted',
				properties: { sessionID: CHILD },
			},
		});
		expect(
			resolveAuthorizedScopeBindingForSession({
				directory,
				activeSessionId: CHILD,
			}),
		).toBeNull();
		const afterDelete = ensureAgentSession(CHILD, 'coder', directory);
		expect(afterDelete.currentTaskId).toBeNull();
		expect(afterDelete.declaredCoderScope).toBeNull();
	});
});
