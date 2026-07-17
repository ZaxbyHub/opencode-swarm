import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	claimScopeBindingForChild,
	clearScopeBindings,
	createScopeBinding,
	deriveChildScopeBinding,
	getAuthorizedScopeBinding,
	getScopeBinding,
	MAX_PENDING_SCOPE_BINDINGS,
	registerScopeBinding,
	resolveCoderScopeSources,
} from '../../../src/scope/scope-binding';
import { endAgentSession } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const cleanups: Array<() => void> = [];

function workspace(prefix: string): string {
	const created = createSafeTestDir(prefix);
	cleanups.push(created.cleanup);
	fs.mkdirSync(path.join(created.dir, '.swarm'), { recursive: true });
	return created.dir;
}

function plan(title = 'Issue 1875'): Plan {
	return {
		schema_version: '1.0.0',
		title,
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
						files_touched: ['src/a.ts', 'src/b.ts'],
					},
				],
			},
		],
	};
}

function registerClaimedBinding(input: {
	directory: string;
	plan: Plan;
	parentSessionId: string;
	childSessionId: string;
	callId: string;
	files: string[];
}) {
	registerScopeBinding(
		createScopeBinding({
			directory: input.directory,
			plan: input.plan,
			taskId: '1.1',
			files: input.files,
			ownerSessionId: input.parentSessionId,
			ownerMessageId: input.callId,
			dispatchCallId: input.callId,
			source: 'plan',
		})!,
	);
	return claimScopeBindingForChild({
		directory: input.directory,
		parentSessionId: input.parentSessionId,
		childSessionId: input.childSessionId,
		dispatchCallId: input.callId,
	})?.claimed;
}

afterEach(() => {
	clearScopeBindings();
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe('identity-bound scope bindings', () => {
	test('ownerless declarations never create an authorization binding', () => {
		const root = workspace('scope-ownerless-');
		expect(
			createScopeBinding({
				directory: root,
				plan: plan(),
				taskId: '1.1',
				files: ['src/a.ts'],
				ownerSessionId: '',
				ownerMessageId: '',
				source: 'declare_scope',
			}),
		).toBeNull();
	});

	test('same task cannot reuse scope across plan generations or workspaces', () => {
		const first = workspace('scope-first-');
		const second = workspace('scope-second-');
		const originalPlan = plan();
		const binding = createScopeBinding({
			directory: first,
			plan: originalPlan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'session-a',
			ownerMessageId: 'message-a',
			source: 'declare_scope',
		});
		expect(binding).not.toBeNull();
		registerScopeBinding(binding!);

		expect(
			getScopeBinding({
				directory: first,
				plan: originalPlan,
				taskId: '1.1',
				ownerSessionId: 'session-a',
			}),
		).not.toBeNull();
		expect(
			getScopeBinding({
				directory: first,
				plan: plan('Replacement'),
				taskId: '1.1',
				ownerSessionId: 'session-a',
			}),
		).toBeNull();
		expect(
			getScopeBinding({
				directory: second,
				plan: originalPlan,
				taskId: '1.1',
				ownerSessionId: 'session-a',
			}),
		).toBeNull();
	});

	test('a new declaration atomically supersedes the same session task scope', () => {
		const root = workspace('scope-redeclare-');
		const currentPlan = plan();
		for (const [message, files] of [
			['first', ['src/a.ts']],
			['second', ['src/a.ts', 'src/b.ts']],
		] as const) {
			registerScopeBinding(
				createScopeBinding({
					directory: root,
					plan: currentPlan,
					taskId: '1.1',
					files,
					ownerSessionId: 'architect-session',
					ownerMessageId: message,
					source: 'declare_scope',
				})!,
			);
		}
		expect(
			getScopeBinding({
				directory: root,
				plan: currentPlan,
				taskId: '1.1',
				ownerSessionId: 'architect-session',
			})?.files,
		).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('pending bindings are bounded with FIFO eviction', () => {
		const root = workspace('scope-bounded-');
		for (let i = 0; i <= MAX_PENDING_SCOPE_BINDINGS; i++) {
			const binding = createScopeBinding({
				directory: root,
				plan: plan(`Plan ${i}`),
				taskId: '1.1',
				files: ['src/a.ts'],
				ownerSessionId: `session-${i}`,
				ownerMessageId: `message-${i}`,
				source: 'declare_scope',
			});
			registerScopeBinding(binding!);
		}
		expect(
			getScopeBinding({
				directory: root,
				plan: plan('Plan 0'),
				taskId: '1.1',
				ownerSessionId: 'session-0',
			}),
		).toBeNull();
	});

	test('explicit scope is authoritative while FILE and plan paths must be subsets', () => {
		expect(
			resolveCoderScopeSources({
				explicitFiles: ['src/a.ts', 'src/b.ts', 'src/generated/'],
				planFiles: ['src/a.ts', 'src/b.ts'],
				fileDirectiveFiles: ['src/a.ts'],
			}),
		).toEqual({
			ok: true,
			files: ['src/a.ts', 'src/b.ts', 'src/generated'],
			source: 'declare_scope',
		});
		expect(
			resolveCoderScopeSources({
				explicitFiles: ['src/a.ts'],
				planFiles: ['src/a.ts', 'src/b.ts'],
				fileDirectiveFiles: ['src/a.ts'],
			}),
		).toEqual({ ok: false, code: 'SCOPE_CONFLICT' });
	});

	test('plan outranks a subset FILE list and complete FILE is last-resort scope', () => {
		expect(
			resolveCoderScopeSources({
				explicitFiles: null,
				planFiles: ['src/a.ts', 'src/b.ts'],
				fileDirectiveFiles: ['src/a.ts'],
			}),
		).toEqual({
			ok: true,
			files: ['src/a.ts', 'src/b.ts'],
			source: 'plan',
		});
		expect(
			resolveCoderScopeSources({
				explicitFiles: null,
				planFiles: null,
				fileDirectiveFiles: ['src/a.ts'],
			}),
		).toEqual({ ok: true, files: ['src/a.ts'], source: 'file_directive' });
		expect(
			resolveCoderScopeSources({
				explicitFiles: null,
				planFiles: null,
				fileDirectiveFiles: [],
			}),
		).toEqual({ ok: false, code: 'SCOPE_NOT_DECLARED' });
	});

	test('child binding is anchored to child root and parent Task correlation', () => {
		const parent = workspace('scope-parent-');
		const child = workspace('scope-child-');
		const parentBinding = createScopeBinding({
			directory: parent,
			plan: plan(),
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'parent-session',
			ownerMessageId: 'parent-message',
			source: 'declare_scope',
		})!;
		const childBinding = deriveChildScopeBinding(parentBinding, {
			childDirectory: child,
			childSessionId: 'child-session',
			parentCallId: 'task-call-1',
		});
		expect(childBinding.workspaceIdentity).not.toBe(
			parentBinding.workspaceIdentity,
		);
		expect(childBinding.parentOwnerSessionId).toBe('parent-session');
		expect(childBinding.parentCallId).toBe('task-call-1');
		expect(childBinding.ownerSessionId).toBe('child-session');
	});

	test('same-task authorizations are isolated by active session and Task call', () => {
		const root = workspace('scope-cross-session-');
		const currentPlan = plan();
		for (const session of ['session-a', 'session-b']) {
			registerClaimedBinding({
				directory: root,
				plan: currentPlan,
				parentSessionId: `parent-${session}`,
				childSessionId: session,
				callId: `call-${session}`,
				files: [`src/${session}.ts`],
			});
		}
		expect(
			getAuthorizedScopeBinding({
				directory: root,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'session-a',
			})?.files,
		).toEqual(['src/session-a.ts']);
		expect(
			getAuthorizedScopeBinding({
				directory: root,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'session-c',
			}),
		).toBeNull();
	});

	test('expired and uncorrelated bindings never authorize', () => {
		const root = workspace('scope-expiry-');
		const currentPlan = plan();
		const uncorrelated = createScopeBinding({
			directory: root,
			plan: currentPlan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'session-a',
			ownerMessageId: 'declare-message',
			source: 'declare_scope',
		})!;
		registerScopeBinding(uncorrelated);
		expect(
			getAuthorizedScopeBinding({
				directory: root,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'session-a',
			}),
		).toBeNull();
		const expired = { ...uncorrelated, dispatchCallId: 'call-a', expiresAt: 0 };
		registerScopeBinding(expired);
		expect(
			getAuthorizedScopeBinding({
				directory: root,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'session-a',
			}),
		).toBeNull();
	});

	test('worktree-derived source alone cannot bypass child session identity', () => {
		const parent = workspace('scope-parent-auth-');
		const child = workspace('scope-child-auth-');
		const currentPlan = plan();
		const parentBinding = createScopeBinding({
			directory: parent,
			plan: currentPlan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'parent-session',
			ownerMessageId: 'task-call',
			dispatchCallId: 'task-call',
			source: 'plan',
		})!;
		const childBinding = deriveChildScopeBinding(parentBinding, {
			childDirectory: child,
			childSessionId: 'actual-child-session',
			parentCallId: 'task-call',
		});
		registerScopeBinding(childBinding);
		expect(
			getAuthorizedScopeBinding({
				directory: child,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'different-session',
			}),
		).toBeNull();
		expect(
			getAuthorizedScopeBinding({
				directory: child,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'actual-child-session',
			})?.parentCallId,
		).toBe('task-call');
	});

	test('individual session teardown revokes only that session and its children', () => {
		const root = workspace('scope-session-end-');
		const currentPlan = plan();
		for (const session of ['session-a', 'session-b']) {
			registerClaimedBinding({
				directory: root,
				plan: currentPlan,
				parentSessionId: `parent-${session}`,
				childSessionId: session,
				callId: `call-${session}`,
				files: ['src/a.ts'],
			});
		}
		endAgentSession('session-a');
		expect(
			getAuthorizedScopeBinding({
				directory: root,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'session-a',
			}),
		).toBeNull();
		expect(
			getAuthorizedScopeBinding({
				directory: root,
				plan: currentPlan,
				taskId: '1.1',
				activeSessionId: 'session-b',
			}),
		).not.toBeNull();
	});
});
