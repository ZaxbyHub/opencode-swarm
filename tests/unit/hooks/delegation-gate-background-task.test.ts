/**
 * Issue #1151 — Support OpenCode background subagents safely in swarm (PR 1).
 *
 * OpenCode v1.16.2 background subagents (`Task` with `background=true`) return a
 * "running" placeholder immediately and complete later via synthetic injection.
 * Swarm cannot yet correlate that deferred completion, so PR 1 fail-closed-blocks
 * background swarm delegations:
 *   - toolBefore throws (pre-dispatch, fail-closed chain) for swarm roles.
 *   - toolAfter defensively early-returns so a running placeholder never advances
 *     Stage B or records gate evidence.
 *
 * Foreground delegation behavior is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import {
	createDelegationGateHook,
	SWARM_BACKGROUND_TASK_BLOCKED_MESSAGE,
} from '../../../src/hooks/delegation-gate';
import {
	deleteStoredInputArgs,
	getStoredInputArgs,
	setStoredInputArgs,
} from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';

function makeConfig(): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
		},
	} as PluginConfig;
}

async function callToolBefore(
	hook: ReturnType<typeof createDelegationGateHook>,
	args: Record<string, unknown>,
	sessionID = 'bg-session',
): Promise<{ threw: boolean; message: string | null }> {
	try {
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: `call-${sessionID}` },
			{ args },
		);
		return { threw: false, message: null };
	} catch (err) {
		return {
			threw: true,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

describe('issue #1151 — background Task fail-closed guard', () => {
	beforeEach(() => resetSwarmState());
	afterEach(() => resetSwarmState());

	// ── toolBefore: pre-dispatch block ───────────────────────────────────────
	it('blocks background:true for reviewer (gate agent)', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw, message } = await callToolBefore(hook, {
			subagent_type: 'reviewer',
			background: true,
			description: 'review',
		});
		expect(threw).toBe(true);
		expect(message).toBe(SWARM_BACKGROUND_TASK_BLOCKED_MESSAGE);
	});

	it('blocks background:true for test_engineer (gate agent)', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'test_engineer',
			background: true,
		});
		expect(threw).toBe(true);
	});

	it('blocks background:true for a prefixed swarm name (mega_reviewer)', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'mega_reviewer',
			background: true,
		});
		expect(threw).toBe(true);
	});

	// F1: block covers ALL canonical swarm roles, not just gate agents.
	it('blocks background:true for a non-gate swarm role (explorer)', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'explorer',
			background: true,
		});
		expect(threw).toBe(true);
	});

	it('blocks background:true for coder', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'coder',
			background: true,
		});
		expect(threw).toBe(true);
	});

	// Fail-closed: stringified flag cannot bypass the guard.
	it('blocks background:"true" (string form) for reviewer', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'reviewer',
			background: 'true',
		});
		expect(threw).toBe(true);
	});

	// ── toolBefore: must NOT over-block ──────────────────────────────────────
	it('does NOT block foreground reviewer (background absent)', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'reviewer',
			description: 'review',
		});
		expect(threw).toBe(false);
	});

	it('does NOT block background:false reviewer', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'reviewer',
			background: false,
		});
		expect(threw).toBe(false);
	});

	it('does NOT block background:true for non-swarm subagent_type (general)', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'general',
			background: true,
		});
		expect(threw).toBe(false);
	});

	// F2: pin suffix-separator semantics — 'reviewerx' (no separator) is not a swarm role.
	it('does NOT block background:true for reviewerx (no separator, not a swarm role)', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const { threw } = await callToolBefore(hook, {
			subagent_type: 'reviewerx',
			background: true,
		});
		expect(threw).toBe(false);
	});

	// ── toolAfter: defensive early-return ────────────────────────────────────
	it('defensive: background reviewer (args) does NOT advance Stage B and cleans storedArgs', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const sessionID = 'bg-after-args';
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		const callID = 'bg-call-args';
		setStoredInputArgs(callID, { subagent_type: 'reviewer', background: true });

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: { subagent_type: 'reviewer', background: true },
			},
			{ state: 'running', metadata: { background: true } },
		);

		// Early-return fired before Stage B advancement and before gate evidence.
		expect(getTaskState(session, '1.1')).toBe('coder_delegated');
		expect(getStoredInputArgs(callID)).toBeUndefined();
	});

	// F3: output-shape path — background flag ABSENT from args, present only in the result.
	it('defensive: background detected from output shape (state:running) does NOT advance Stage B', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const sessionID = 'bg-after-output';
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set('2.1', 'coder_delegated');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'bg-call-output',
				// background NOT in args — only observable via the result shape
				args: { subagent_type: 'reviewer' },
			},
			{ state: 'running', metadata: { background: true } },
		);

		expect(getTaskState(session, '2.1')).toBe('coder_delegated');
	});

	// Regression guard: foreground reviewer STILL advances (unchanged path).
	it('regression: foreground reviewer advances coder_delegated -> reviewer_run', async () => {
		const hook = createDelegationGateHook(makeConfig(), process.cwd());
		const sessionID = 'fg-after';
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set('3.1', 'coder_delegated');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'fg-call',
				args: { subagent_type: 'reviewer' },
			},
			{ state: 'completed', text: 'review done' },
		);

		expect(getTaskState(session, '3.1')).toBe('reviewer_run');
		// cleanup any stored args defensively
		deleteStoredInputArgs('fg-call');
	});
});
