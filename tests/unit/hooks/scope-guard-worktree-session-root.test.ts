import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { createScopeGuardHook } from '../../../src/hooks/scope-guard';
import { savePlan } from '../../../src/plan/manager';
import {
	clearScopeBindings,
	createScopeBinding,
	deriveChildScopeBinding,
	registerScopeBinding,
} from '../../../src/scope/scope-binding';
import { writeScopeBindingToDisk } from '../../../src/scope/scope-persistence';
import {
	ensureAgentSession,
	recordSessionWorkspaceRoot,
	resetSwarmState,
	resolveSessionWorkspaceDirectory,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Issue #2002 — the scope guard is constructed ONCE at plugin init with the
 * plugin-root `ctx.directory` (src/index.ts:1224) but worktree-isolated coder
 * children execute in a lane root. Every test here constructs the hook with the
 * PROJECT ROOT, mirroring production wiring.
 *
 * The pre-existing suite (scope-guard-identity-binding.test.ts) constructs the
 * hook with the *worktree*, which is why it stayed green while the runtime path
 * was broken. Do not "simplify" these tests by passing the lane as the hook
 * directory — that removes the only thing they are testing.
 */

const plan: Plan = {
	schema_version: '1.0.0',
	title: 'Worktree session root',
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

describe('scope guard resolves the executing session workspace root', () => {
	let directory: string;
	let cleanup: () => void;

	async function provisionLane(
		name: string,
		childSessionId: string,
		parentSessionId = 'lane-parent',
		callId = 'lane-call',
	): Promise<string> {
		const lane = path.join(directory, name);
		fs.mkdirSync(lane, { recursive: true });
		await savePlan(lane, plan, { preserveCompletedStatuses: false });
		const pending = createScopeBinding({
			directory,
			plan,
			taskId: '1.1',
			files: ['src/allowed.ts'],
			ownerSessionId: parentSessionId,
			ownerMessageId: callId,
			dispatchCallId: callId,
			source: 'plan',
		});
		if (!pending) throw new Error('createScopeBinding returned null');
		const child = deriveChildScopeBinding(pending, {
			childDirectory: lane,
			childSessionId,
			parentCallId: callId,
		});
		registerScopeBinding(child);
		await writeScopeBindingToDisk(lane, child);

		// ORDER IS LOAD-BEARING — mirrors worktree-isolation.ts exactly: the
		// child session is registered with its real agent name FIRST via
		// ensureAgentSession, THEN its workspace root is recorded.
		// recordSessionWorkspaceRoot deliberately refuses to create a session
		// (src/state.ts), so calling it before registration is a silent no-op
		// under the fixed production code and resolution falls back to the
		// project root. Do NOT hand-repair `swarmState.activeAgent` here —
		// ensureAgentSession's own create path already sets it to 'coder' the
		// same way production does.
		const session = ensureAgentSession(childSessionId, 'coder', lane);
		recordSessionWorkspaceRoot(childSessionId, lane);
		session.currentTaskId = '1.1';
		return lane;
	}

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('scope-guard-session-root-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);
	});

	afterEach(() => {
		clearScopeBindings();
		resetSwarmState();
		cleanup();
	});

	test('REGRESSION #2002: worktree coder in-scope write is allowed under production wiring', async () => {
		await provisionLane('lane-a', 'child-a');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'child-a', callID: 'w1' },
				{ args: { path: 'src/allowed.ts', content: 'ok' } },
			),
		).resolves.toBeUndefined();
	});

	test('absolute lane path is allowed when in scope', async () => {
		const lane = await provisionLane('lane-abs', 'child-abs');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'child-abs', callID: 'w-abs' },
				{
					args: {
						path: path.join(lane, 'src', 'allowed.ts'),
						content: 'ok',
					},
				},
			),
		).resolves.toBeUndefined();
	});

	test('out-of-scope write from the lane session is still blocked', async () => {
		await provisionLane('lane-b', 'child-b');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'child-b', callID: 'w2' },
				{ args: { path: 'src/forbidden.ts', content: 'no' } },
			),
		).rejects.toThrow('SCOPE VIOLATION');
	});

	test('a path escaping the lane is blocked', async () => {
		await provisionLane('lane-c', 'child-c');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'child-c', callID: 'w3' },
				{ args: { path: '../src/allowed.ts', content: 'no' } },
			),
		).rejects.toThrow('SCOPE VIOLATION');
	});

	test('one lane cannot borrow another lane binding', async () => {
		await provisionLane('lane-d', 'child-d', 'parent-d', 'call-d');
		await provisionLane('lane-e', 'child-e', 'parent-e', 'call-e');
		const hook = createScopeGuardHook({ enabled: true }, directory);
		// child-e writing into lane-d's tree is outside its own lane root.
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'child-e', callID: 'w4' },
				{
					args: {
						path: path.join(directory, 'lane-d', 'src', 'allowed.ts'),
						content: 'no',
					},
				},
			),
		).rejects.toThrow('SCOPE VIOLATION');
	});

	test('non-worktree coder behaviour is unchanged (no recorded root)', async () => {
		const pending = createScopeBinding({
			directory,
			plan,
			taskId: '1.1',
			files: ['src/allowed.ts'],
			ownerSessionId: 'root-parent',
			ownerMessageId: 'root-call',
			dispatchCallId: 'root-call',
			source: 'plan',
		});
		if (!pending) throw new Error('createScopeBinding returned null');
		registerScopeBinding({
			...pending,
			ownerSessionId: 'root-child',
			ownerMessageId: 'root-call',
			activation: 'active',
			parentOwnerSessionId: 'root-parent',
			parentCallId: 'root-call',
		});
		// ensureAgentSession's own create path already sets swarmState.activeAgent
		// to 'coder' — no manual repair needed.
		const session = ensureAgentSession('root-child', 'coder');
		session.currentTaskId = '1.1';
		expect(session.workspaceDirectory).toBeUndefined();

		const hook = createScopeGuardHook({ enabled: true }, directory);
		await expect(
			hook.toolBefore(
				{ tool: 'write', sessionID: 'root-child', callID: 'w5' },
				{ args: { path: 'src/allowed.ts', content: 'ok' } },
			),
		).resolves.toBeUndefined();
	});
});

describe('session workspace root trust boundary (#2002 B2)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('scope-guard-trust-');
		directory = created.dir;
		cleanup = created.cleanup;
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('ensureAgentSession does NOT record a workspace root', () => {
		// declare_scope passes an agent-supplied `working_directory` into
		// ensureAgentSession's third argument (src/tools/declare-scope.ts:384-388).
		// That argument must never be able to relocate a resolution root.
		const hostile = path.join(path.dirname(directory), 'attacker-controlled');
		const session = ensureAgentSession('victim', 'coder', hostile);
		expect(session.workspaceDirectory).toBeUndefined();
		expect(resolveSessionWorkspaceDirectory('victim', directory)).toBe(
			directory,
		);
	});

	test('recordSessionWorkspaceRoot accepts a tmpdir-shortened lane (#2002 B1)', () => {
		// provisionWorktree relocates a lane to os.tmpdir()/swwt/... when the
		// Windows path budget is exceeded (src/worktree/core.ts:392-412, taken at
		// :576-589). A path-containment predicate against the swarm worktree base
		// would refuse exactly those lanes and silently restore the defect.
		// The session must be registered first — recordSessionWorkspaceRoot is
		// a no-op for an unregistered session (see the fail-closed test below).
		ensureAgentSession('short-lane', 'coder');
		const shortened = path.join(os.tmpdir(), 'swwt', 'sess', 'lane');
		recordSessionWorkspaceRoot('short-lane', shortened);
		expect(resolveSessionWorkspaceDirectory('short-lane', directory)).toBe(
			shortened,
		);
	});

	test('an unrecorded session falls back to the plugin root (fail-closed)', () => {
		expect(resolveSessionWorkspaceDirectory('never-seen', directory)).toBe(
			directory,
		);
	});

	test('REGRESSION #2002: recordSessionWorkspaceRoot for a session that does not exist is a no-op (fail-closed)', () => {
		// Previous behavior: recordSessionWorkspaceRoot called
		// ensureAgentSession(sessionId) with no agent name for an unknown
		// session, which registered swarmState.activeAgent as 'unknown' — a
		// FAIL-OPEN state ('unknown' is truthy, so it passes the no-active-agent
		// guard in guardrails/tool-before.ts and then takes the noScopeLenient
		// branch that skips the authority check, while scope-guard returns
		// early because the role isn't 'coder'). The fixed contract must
		// refuse to create the session at all.
		expect(swarmState.agentSessions.has('phantom-lane')).toBe(false);
		recordSessionWorkspaceRoot('phantom-lane', path.join(directory, 'lane'));
		expect(swarmState.agentSessions.has('phantom-lane')).toBe(false);
		expect(resolveSessionWorkspaceDirectory('phantom-lane', directory)).toBe(
			directory,
		);
	});

	test('a blank lane root is ignored rather than resolving to cwd', () => {
		recordSessionWorkspaceRoot('blank', '   ');
		expect(resolveSessionWorkspaceDirectory('blank', directory)).toBe(
			directory,
		);
	});
});
