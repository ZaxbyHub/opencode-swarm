/**
 * Unit tests for the host-boundary adapter (issue #1849).
 *
 * Validates that the adapter reads the REAL SDK payload shapes and never
 * depends on `input.agent`/`input.args`/`role:'system'` messages — the
 * impossible-payload assumptions that left the architect injection dark in
 * production.
 *
 * Identity is manipulated via the real `swarmState.activeAgent` map and
 * restored in afterEach (no mock.module — the adapter is a pure function of
 * its arguments + swarmState, which is the intended DI surface).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ORCHESTRATOR_NAME } from '../../../src/config/agent-names';
import {
	deleteStoredInputArgs,
	setStoredInputArgs,
} from '../../../src/hooks/guardrails/stored-input-args';
import {
	type MessageArrayLike,
	resolveMessageTransformContext,
	resolveToolAfterContext,
	resolveToolBeforeContext,
} from '../../../src/hooks/host-boundary';
import { swarmState } from '../../../src/state';

const SESSION = 'sess-1849';
const CALL = 'call-1849';

function restoreSession(): void {
	swarmState.activeAgent.delete(SESSION);
	swarmState.agentSessions.delete(SESSION);
	deleteStoredInputArgs(CALL);
}

describe('host-boundary adapter — tool.execute.before', () => {
	beforeEach(restoreSession);
	afterEach(restoreSession);

	test('reads agent from swarmState.activeAgent, NOT input.agent', () => {
		swarmState.activeAgent.set(SESSION, 'cohort_architect');
		// SDK input has NO agent field — we deliberately omit it.
		const ctx = resolveToolBeforeContext(
			{ tool: 'Task', sessionID: SESSION, callID: CALL },
			{ args: { prompt: 'do thing' } },
		);
		expect(ctx.agent).toBe('cohort_architect');
		expect(ctx.callerRole).toBe('architect'); // suffix strip
		expect(ctx.isArchitect).toBe(true);
		expect(ctx.tool).toBe('Task');
		expect(ctx.sessionID).toBe(SESSION);
		expect(ctx.callID).toBe(CALL);
	});

	test('reads args from output.args, NOT input.args', () => {
		swarmState.activeAgent.set(SESSION, 'coder');
		const ctx = resolveToolBeforeContext(
			{ tool: 'Task', sessionID: SESSION, callID: CALL },
			{ args: { prompt: 'delegate work', subagent_type: 'coder' } },
		);
		expect(ctx.args).toEqual({
			prompt: 'delegate work',
			subagent_type: 'coder',
		});
		expect(ctx.callerRole).toBe('coder');
		expect(ctx.isArchitect).toBe(false);
	});

	test('defaults to orchestrator when no activeAgent mapped (preserves #1849 fallback)', () => {
		// No activeAgent entry — must fall back to architect, not undefined.
		const ctx = resolveToolBeforeContext(
			{ tool: 'read', sessionID: SESSION, callID: CALL },
			{ args: { path: '/x' } },
		);
		expect(ctx.agent).toBe(ORCHESTRATOR_NAME);
		expect(ctx.isArchitect).toBe(true);
	});

	test('returns null args when output.args is absent or non-object', () => {
		swarmState.activeAgent.set(SESSION, 'architect');
		const ctx = resolveToolBeforeContext(
			{ tool: 'read', sessionID: SESSION, callID: CALL },
			{},
		);
		expect(ctx.args).toBeNull();
	});

	test('multi-swarm prefixed names canonicalize (mega_, cohort_, enterprise_)', () => {
		for (const name of [
			'mega_architect',
			'cohort_architect',
			'enterprise_architect',
		]) {
			swarmState.activeAgent.set(SESSION, name);
			const ctx = resolveToolBeforeContext(
				{ tool: 'Task', sessionID: SESSION, callID: CALL },
				{},
			);
			expect(ctx.callerRole).toBe('architect');
			expect(ctx.isArchitect).toBe(true);
		}
	});

	test('does NOT consult input.agent even when present (SDK never provides it)', () => {
		swarmState.activeAgent.set(SESSION, 'reviewer');
		// Caller mistakenly passes agent on input (legacy fixture). Adapter MUST
		// ignore it — the SDK does not populate it.
		const input = {
			tool: 'Task',
			sessionID: SESSION,
			callID: CALL,
			agent: 'architect',
		} as Record<string, unknown>;
		const ctx = resolveToolBeforeContext(
			{ tool: input.tool, sessionID: input.sessionID, callID: input.callID },
			{},
		);
		expect(ctx.agent).toBe('reviewer'); // swarmState wins, input.agent ignored
		expect(ctx.isArchitect).toBe(false);
	});
});

describe('host-boundary adapter — tool.execute.after', () => {
	beforeEach(restoreSession);
	afterEach(restoreSession);

	test('recovers args from the callID snapshot, not input.args', () => {
		swarmState.activeAgent.set(SESSION, 'architect');
		// guardrails/tool-before.ts snapshots output.args in toolBefore.
		setStoredInputArgs(CALL, { prompt: 'snapshotted', subagent_type: 'coder' });
		const ctx = resolveToolAfterContext({
			tool: 'Task',
			sessionID: SESSION,
			callID: CALL,
		});
		expect(ctx.args).toEqual({ prompt: 'snapshotted', subagent_type: 'coder' });
		expect(ctx.agent).toBe('architect');
	});

	test('returns null args when the snapshot was already cleaned up', () => {
		swarmState.activeAgent.set(SESSION, 'architect');
		const ctx = resolveToolAfterContext({
			tool: 'Task',
			sessionID: SESSION,
			callID: 'never-snapshotted',
		});
		expect(ctx.args).toBeNull();
	});
});

describe('host-boundary adapter — messages.transform', () => {
	beforeEach(restoreSession);
	afterEach(restoreSession);

	test('recovers agent from swarmState via sessionID derived from messages', () => {
		swarmState.activeAgent.set(SESSION, 'cohort_architect');
		const output: MessageArrayLike = {
			messages: [
				{
					info: { role: 'user', agent: 'cohort_architect', sessionID: SESSION },
				},
				{
					info: { role: 'assistant', sessionID: SESSION },
				},
			],
		};
		const ctx = resolveMessageTransformContext(output);
		expect(ctx.sessionID).toBe(SESSION);
		expect(ctx.agent).toBe('cohort_architect');
		expect(ctx.isArchitect).toBe(true);
	});

	test('NEVER searches for role:system (the #1768/#1849 dark-path root cause)', () => {
		// Only a system "message" present (which the SDK never produces) plus an
		// assistant message. With no user message and no swarmState entry, agent
		// must be undefined — NOT recovered from the bogus system message.
		const output: MessageArrayLike = {
			messages: [
				{ info: { role: 'system', agent: 'architect', sessionID: SESSION } },
				{ info: { role: 'assistant', sessionID: SESSION } },
			],
		};
		const ctx = resolveMessageTransformContext(output);
		expect(ctx.sessionID).toBe(SESSION);
		expect(ctx.agent).toBeUndefined();
		expect(ctx.isArchitect).toBe(false);
	});

	test('falls back to last user message info.agent when swarmState empty (first-turn race)', () => {
		// No swarmState entry. A user message carries the agent name.
		const output: MessageArrayLike = {
			messages: [
				{ info: { role: 'user', agent: 'architect', sessionID: SESSION } },
				{ info: { role: 'assistant', sessionID: SESSION } },
				{ info: { role: 'user', agent: 'reviewer', sessionID: SESSION } },
			],
		};
		const ctx = resolveMessageTransformContext(output);
		// LAST user message wins.
		expect(ctx.agent).toBe('reviewer');
		expect(ctx.isDelegate).toBe(true);
	});

	test('returns undefined agent + sessionID for an empty message array', () => {
		const ctx = resolveMessageTransformContext({ messages: [] });
		expect(ctx.sessionID).toBeUndefined();
		expect(ctx.agent).toBeUndefined();
	});

	test('swarmState takes precedence over the message-scan fallback', () => {
		swarmState.activeAgent.set(SESSION, 'architect');
		const output: MessageArrayLike = {
			messages: [
				{ info: { role: 'user', agent: 'coder', sessionID: SESSION } },
			],
		};
		const ctx = resolveMessageTransformContext(output);
		expect(ctx.agent).toBe('architect'); // swarmState wins over message info.agent
	});

	test('handles missing messages array gracefully', () => {
		const ctx = resolveMessageTransformContext({});
		expect(ctx.sessionID).toBeUndefined();
		expect(ctx.agent).toBeUndefined();
	});
});
