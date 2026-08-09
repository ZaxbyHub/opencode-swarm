/**
 * Issue #2002 — describeScopeWorkspaceMismatch hardening.
 *
 * Reviewer finding: the original filter matched on ownerSessionId /
 * activation / taskId only, so it over-triggered:
 *   - `pr_feedback` bindings (a categorically different auth path) satisfied
 *     the filter and got mislabeled as a workspace mismatch.
 *   - a stale/malformed "active" binding that never went through the real
 *     claim/derive dispatch-correlation path also satisfied the filter.
 *   - when the caller's own directory was unresolvable (e.g. a deleted lane
 *     directory), EVERY active binding for the session "mismatched",
 *     reporting a missing-directory failure as a wrong-root failure.
 *
 * These tests pin the narrowed behavior: genuine wrong-root cases still
 * fire (the diagnostic is not neutered), while the three false-positive
 * shapes above return null so the caller falls back to the generic
 * SCOPE_NOT_DECLARED. This module is diagnostic-only — none of these tests
 * touch authorization (getAuthorizedScopeBinding*), only the message helper.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	clearScopeBindings,
	createPrFeedbackScopeBinding,
	createScopeBinding,
	deriveChildScopeBinding,
	describeScopeWorkspaceMismatch,
	registerScopeBinding,
} from '../../../src/scope/scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const cleanups: Array<() => void> = [];

function workspace(prefix: string): string {
	const created = createSafeTestDir(prefix);
	cleanups.push(created.cleanup);
	fs.mkdirSync(path.join(created.dir, '.swarm'), { recursive: true });
	return created.dir;
}

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Issue 2002 mismatch diagnostic',
		swarm: 'default',
		phases: [
			{
				id: 1,
				name: 'Fix',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'repair',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
}

afterEach(() => {
	clearScopeBindings();
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe('describeScopeWorkspaceMismatch', () => {
	test('fires on a genuine wrong-root active binding for this session', () => {
		const parentRoot = workspace('mismatch-parent-');
		const childRoot = workspace('mismatch-child-');
		const parentBinding = createScopeBinding({
			directory: parentRoot,
			plan: plan(),
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'parent-session',
			ownerMessageId: 'task-call-1',
			dispatchCallId: 'task-call-1',
			source: 'plan',
		})!;
		const childBinding = deriveChildScopeBinding(parentBinding, {
			childDirectory: childRoot,
			childSessionId: 'child-session',
			parentCallId: 'task-call-1',
		});
		registerScopeBinding(childBinding);

		// The gate incorrectly resolved the parent (plugin-root) directory for
		// the child session instead of the child's own lane root.
		const message = describeScopeWorkspaceMismatch({
			directory: parentRoot,
			activeSessionId: 'child-session',
			taskId: '1.1',
		});

		expect(message).not.toBeNull();
		expect(message).toContain('SCOPE_WORKSPACE_MISMATCH');
		expect(message).toContain('child-session');
		expect(message).toContain('task 1.1');
		expect(message).toContain('worktree_derived');
	});

	test('does NOT fire when the caller directory is unresolvable', () => {
		const parentRoot = workspace('mismatch-unresolvable-parent-');
		const childRoot = workspace('mismatch-unresolvable-child-');
		const parentBinding = createScopeBinding({
			directory: parentRoot,
			plan: plan(),
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'parent-session',
			ownerMessageId: 'task-call-2',
			dispatchCallId: 'task-call-2',
			source: 'plan',
		})!;
		const childBinding = deriveChildScopeBinding(parentBinding, {
			childDirectory: childRoot,
			childSessionId: 'child-session-2',
			parentCallId: 'task-call-2',
		});
		registerScopeBinding(childBinding);

		// A directory that never existed on disk — canonicalWorkspaceIdentity
		// returns null for it (realpathSync throws).
		const deletedDirectory = path.join(parentRoot, 'never-existed-subdir');

		const message = describeScopeWorkspaceMismatch({
			directory: deletedDirectory,
			activeSessionId: 'child-session-2',
			taskId: '1.1',
		});

		expect(message).toBeNull();
	});

	test('does NOT fire for an unrelated pr_feedback binding', () => {
		const gateRoot = workspace('mismatch-prfeedback-gate-');
		const bindingRoot = workspace('mismatch-prfeedback-binding-');
		const prFeedbackBinding = createPrFeedbackScopeBinding({
			directory: bindingRoot,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'pr-session',
			ownerMessageId: 'pr-call-1',
			workflowSessionId: 'workflow-session',
			workflowRevisionDigest: 'digest-1',
			dispatchCallId: 'pr-call-1',
			activation: 'active',
		})!;
		// pr_feedback bindings otherwise satisfy every correlation clause the
		// diagnostic mirrors (dispatchCallId present, ownerMessageId ===
		// dispatchCallId) — only the explicit source exclusion keeps this out.
		registerScopeBinding({
			...prFeedbackBinding,
			parentOwnerSessionId: 'workflow-session',
			parentCallId: 'pr-call-1',
		});

		const message = describeScopeWorkspaceMismatch({
			directory: gateRoot,
			activeSessionId: 'pr-session',
			taskId: '1.1',
		});

		expect(message).toBeNull();
	});

	test('does NOT fire for a stale active binding missing dispatch correlation', () => {
		const gateRoot = workspace('mismatch-stale-gate-');
		const bindingRoot = workspace('mismatch-stale-binding-');
		// Constructed directly with activation: 'active' but no dispatchCallId —
		// this never went through claimScopeBindingForChild / deriveChildScopeBinding,
		// so it lacks the dispatch-correlation fields a genuine claimed/derived
		// binding always has. A pre-hardening filter (session + activation +
		// taskId only) would have mislabeled this as a workspace mismatch.
		const staleBinding = createScopeBinding({
			directory: bindingRoot,
			plan: plan(),
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'stale-session',
			ownerMessageId: 'stale-message',
			source: 'declare_scope',
			activation: 'active',
		})!;
		registerScopeBinding(staleBinding);

		const message = describeScopeWorkspaceMismatch({
			directory: gateRoot,
			activeSessionId: 'stale-session',
			taskId: '1.1',
		});

		expect(message).toBeNull();
	});
});
