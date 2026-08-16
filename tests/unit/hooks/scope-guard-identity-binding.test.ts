import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { createScopeGuardHook } from '../../../src/hooks/scope-guard';
import { savePlan } from '../../../src/plan/manager';
import {
	claimScopeBindingForChild,
	clearScopeBindings,
	createScopeBinding,
	deriveChildScopeBinding,
	registerScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	flushScopeBindingMaintenance,
	readScopeBindingFromDisk,
	writeScopeBindingToDisk,
} from '../../../src/scope/scope-persistence';
import {
	endAgentSession,
	ensureAgentSession,
	recordSessionWorkspaceRoot,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const plan: Plan = {
	schema_version: '1.0.0',
	title: 'Identity scope guard',
	swarm: 'test',
	phases: [
		{
			id: 1,
			name: 'Fix',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'fix',
					depends: [],
					files_touched: ['src/allowed.ts'],
				},
			],
		},
	],
};

describe('scope guard identity authorization', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('scope-guard-identity-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
	});

	afterEach(async () => {
		resetSwarmState();
		await flushScopeBindingMaintenance(directory);
		cleanup();
	});

	function coder(sessionID: string): void {
		const session = ensureAgentSession(sessionID, 'coder', directory);
		session.currentTaskId = '1.1';
		swarmState.activeAgent.set(sessionID, 'coder');
	}

	async function binding(sessionID: string) {
		const callId = `task-${sessionID}`;
		const parentSessionId = `parent-${sessionID}`;
		registerScopeBinding(
			createScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				files: ['src/allowed.ts'],
				ownerSessionId: parentSessionId,
				ownerMessageId: callId,
				dispatchCallId: callId,
				source: 'plan',
			})!,
		);
		const claimed = claimScopeBindingForChild({
			directory,
			parentSessionId,
			childSessionId: sessionID,
			dispatchCallId: callId,
		})!.claimed;
		const persisted = await writeScopeBindingToDisk(directory, claimed);
		if (!persisted.ok) throw new Error(persisted.message);
		return persisted.value;
	}

	test('allows only the exact active session for the current plan and task', async () => {
		coder('session-a');
		coder('session-b');
		await binding('session-a');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'session-a', callID: 'write-a' },
				{ args: { path: 'src/allowed.ts', content: 'ok' } },
			),
		).resolves.toBeUndefined();
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'session-b', callID: 'write-b' },
				{ args: { path: 'src/allowed.ts', content: 'no' } },
			),
		).rejects.toThrow('SCOPE_NOT_DECLARED');
	});

	test('durable binding remains session-bound after memory loss', async () => {
		coder('session-a');
		coder('session-b');
		await binding('session-a');
		clearScopeBindings();
		const restarted = ensureAgentSession('session-a');
		restarted.currentTaskId = null;
		restarted.declaredCoderScope = null;
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'session-a', callID: 'write-a' },
				{ args: { path: 'src/allowed.ts', content: 'ok' } },
			),
		).resolves.toBeUndefined();
		expect(restarted.currentTaskId).toBe('1.1');
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'session-b', callID: 'write-b' },
				{ args: { path: 'src/allowed.ts', content: 'no' } },
			),
		).rejects.toThrow('SCOPE_NOT_DECLARED');
		endAgentSession('session-a');
		await flushScopeBindingMaintenance(directory);
		expect(
			readScopeBindingFromDisk({
				directory,
				taskId: '1.1',
				plan,
				ownerSessionId: 'session-a',
				requireDispatchCorrelation: true,
			}),
		).toBeNull();
	});

	test('worktree child requires authoritative current plan materialization', async () => {
		const worktree = path.join(directory, 'isolated-worktree');
		fs.mkdirSync(worktree, { recursive: true });
		fs.mkdirSync(path.join(worktree, '.git'), { recursive: true });
		const pending = createScopeBinding({
			directory,
			plan,
			taskId: '1.1',
			files: ['src/allowed.ts'],
			ownerSessionId: 'worktree-parent',
			ownerMessageId: 'worktree-call',
			dispatchCallId: 'worktree-call',
			source: 'plan',
		})!;
		const active = deriveChildScopeBinding(pending, {
			childDirectory: worktree,
			childSessionId: 'worktree-child',
			parentCallId: 'worktree-call',
		});
		registerScopeBinding(active);
		expect(await writeScopeBindingToDisk(worktree, active)).toMatchObject({
			ok: true,
		});
		// Issue #2002: register the child, THEN record its lane root — the exact
		// production ordering from worktree-isolation.ts. Previously this test
		// constructed the hook with `worktree`, which silently assumed the gate
		// already knew the lane root; that assumption is what the #2002 defect
		// violated, so the suite stayed green while the runtime path was broken.
		const child = ensureAgentSession('worktree-child', 'coder', worktree);
		recordSessionWorkspaceRoot('worktree-child', worktree);
		child.currentTaskId = '1.1';
		// PRODUCTION WIRING: src/index.ts constructs this hook with the
		// plugin-root ctx.directory, never with a lane.
		const hook = createScopeGuardHook({ enabled: true }, directory);
		const write = () =>
			hook.toolBefore(
				{
					tool: 'write',
					sessionID: 'worktree-child',
					callID: 'write-worktree',
				},
				{ args: { path: 'src/allowed.ts', content: 'ok' } },
			);
		await expect(write()).rejects.toThrow('SCOPE_NOT_DECLARED');
		await savePlan(worktree, plan, { preserveCompletedStatuses: false });
		await expect(write()).resolves.toBeUndefined();
	});
});
