/**
 * PRM hard-stop delivery lifecycle (issue #2063 C2 + C3).
 *
 * Two independent one-shot tokens replace the single flag that used to serve
 * both consumers:
 *
 *   - `prmHardStopPending` — the DENY token, consumed by guardrails
 *     `toolBefore`, which throws the HARD STOP denial once and emits the
 *     `prm_hard_stop_delivered` telemetry event. That event is the ONLY
 *     delivery-observability surface: the write-only `prmHardStopDeliveredAt`
 *     session field it used to also stamp was removed (reviewer round-4
 *     REQUIRED 3) because nothing ever read it and it was never serialized.
 *   - `prmHardStopInjectPending` — the INJECT token, consumed by
 *     `messagesTransform`, which prepends the `[HARD STOP]` explanation once.
 *
 * With one shared flag, whichever hook ran first cleared it, so a hard stop was
 * either denied with no explanation or explained with no denial — and which of
 * the two happened depended on host scheduling. Both orders are exercised here.
 *
 * C3 additionally moves budget accounting ABOVE the denial and keeps the denial
 * ABOVE the `if (!resolved) return`, so a windowless (architect-exempt) session
 * is still denied and a windowed session still accrues budget on the tripping
 * call.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	getActiveWindow,
	getAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	type TelemetryEvent,
	_internals as telemetryInternals,
} from '../../../src/telemetry';

const TEST_DIR = path.join(os.tmpdir(), 'guardrails-prm-hardstop-lifecycle');

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	idle_timeout_minutes: 60,
	no_op_warning_threshold: 15,
	max_coder_revisions: 5,
	runaway_output_max_turns: 5,
} as unknown as GuardrailsConfig;

type Msg = {
	info: { role: string; agent?: string; sessionID?: string; id?: string };
	parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
};

function systemMessage(text: string, sessionId: string): Msg {
	return {
		info: { role: 'system', sessionID: sessionId },
		parts: [{ type: 'text', text }],
	};
}

function userMessage(text: string, sessionId: string): Msg {
	return {
		info: { role: 'user', sessionID: sessionId },
		parts: [{ type: 'text', text }],
	};
}

function firstSystemText(messages: Msg[]): string {
	const sys = messages.find((m) => m.info.role === 'system');
	const part = sys?.parts.find(
		(p) => p.type === 'text' && typeof p.text === 'string',
	);
	return (part?.text as string) ?? '';
}

/** Creates a subagent session WITH a live invocation window. */
async function setupSubagent(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
): Promise<void> {
	ensureAgentSession(sessionId, 'coder');
	swarmState.activeAgent.set(sessionId, 'coder');
	// A benign call so the window exists before any token is armed.
	await hooks.toolBefore(
		{ tool: 'read', sessionID: sessionId, callID: 'warmup' } as never,
		{ args: { filePath: '/x.ts' } } as never,
	);
}

function armBothTokens(sessionId: string): void {
	const session = getAgentSession(sessionId);
	if (!session) throw new Error('test setup: session missing');
	session.prmHardStopPending = true;
	session.prmHardStopInjectPending = true;
	session.prmEscalationLevel = 3;
	session.prmPatternCounts.set('repetition_loop', 3);
	session.prmLastPatternDetected = {
		pattern: 'repetition_loop',
		severity: 'high',
		category: 'coordination_error',
		stepRange: [1, 5],
		description: 'test',
		affectedAgents: ['coder'],
		affectedTargets: ['src/a.ts'],
		occurrenceCount: 3,
	} as never;
}

async function callTool(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
	callId: string,
): Promise<Error | null> {
	try {
		await hooks.toolBefore(
			{ tool: 'read', sessionID: sessionId, callID: callId } as never,
			{ args: { filePath: '/some/file.ts' } } as never,
		);
		return null;
	} catch (err) {
		return err as Error;
	}
}

describe('PRM hard stop — two-token delivery lifecycle (#2063 C2)', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, config);
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('order A (transform → tool): injects once AND denies once', async () => {
		const sessionId = 'hardstop-order-a';
		await setupSubagent(hooks, sessionId);
		armBothTokens(sessionId);

		const messages: Msg[] = [
			systemMessage('You are a coder.', sessionId),
			userMessage('go', sessionId),
		];
		await hooks.messagesTransform({}, { messages } as never);
		expect(firstSystemText(messages)).toContain('[HARD STOP]');

		const err = await callTool(hooks, sessionId, 'call-a');
		expect(err?.message).toContain('PRM HARD STOP');

		const session = getAgentSession(sessionId);
		expect(session?.prmHardStopInjectPending).toBe(false);
		expect(session?.prmHardStopPending).toBe(false);
	});

	test('order B (tool → transform): denies once AND still injects once', async () => {
		// The regression this pins: under a single shared flag, the toolBefore
		// denial cleared the flag, so messagesTransform found nothing and the
		// agent was blocked with no explanation of why.
		const sessionId = 'hardstop-order-b';
		await setupSubagent(hooks, sessionId);
		armBothTokens(sessionId);

		const err = await callTool(hooks, sessionId, 'call-b');
		expect(err?.message).toContain('PRM HARD STOP');

		const messages: Msg[] = [
			systemMessage('You are a coder.', sessionId),
			userMessage('go', sessionId),
		];
		await hooks.messagesTransform({}, { messages } as never);
		expect(firstSystemText(messages)).toContain('[HARD STOP]');

		const session = getAgentSession(sessionId);
		expect(session?.prmHardStopInjectPending).toBe(false);
		expect(session?.prmHardStopPending).toBe(false);
	});

	test('the denial is ONE-SHOT: the next tool call passes', async () => {
		const sessionId = 'hardstop-one-shot';
		await setupSubagent(hooks, sessionId);
		armBothTokens(sessionId);

		expect((await callTool(hooks, sessionId, 'c1'))?.message).toContain(
			'PRM HARD STOP',
		);
		expect(await callTool(hooks, sessionId, 'c2')).toBeNull();
		expect(await callTool(hooks, sessionId, 'c3')).toBeNull();
	});

	test('the injection is ONE-SHOT: a later turn is not re-decorated', async () => {
		const sessionId = 'hardstop-inject-one-shot';
		await setupSubagent(hooks, sessionId);
		armBothTokens(sessionId);

		const first: Msg[] = [
			systemMessage('You are a coder.', sessionId),
			userMessage('go', sessionId),
		];
		await hooks.messagesTransform({}, { messages: first } as never);
		expect(firstSystemText(first)).toContain('[HARD STOP]');

		const second: Msg[] = [
			systemMessage('You are a coder.', sessionId),
			userMessage('go again', sessionId),
		];
		await hooks.messagesTransform({}, { messages: second } as never);
		expect(firstSystemText(second)).not.toContain('[HARD STOP]');
	});

	test('the injection reaches a NON-architect session (the flag carrier)', async () => {
		// PRM only runs for sessions with `delegationActive`, i.e. subagents. The
		// injection used to be gated on `isArchitectSession`, so the only sessions
		// that could carry the flag were exactly the sessions that could never
		// receive the message.
		const sessionId = 'hardstop-subagent-carrier';
		await setupSubagent(hooks, sessionId);
		const session = getAgentSession(sessionId);
		expect(session?.agentName).toBe('coder');
		armBothTokens(sessionId);

		const messages: Msg[] = [
			systemMessage('You are a coder.', sessionId),
			userMessage('go', sessionId),
		];
		await hooks.messagesTransform({}, { messages } as never);

		expect(firstSystemText(messages)).toContain('[HARD STOP]');
	});

	test('injection lands even when the system message is created by the advisory drain', async () => {
		// `systemMessages` is snapshotted near the top of the handler, BEFORE the
		// non-architect advisory drain can `unshift` a synthetic system message.
		// Reading that stale snapshot in the hard-stop block would clear the token
		// and inject nothing for a carrier whose turn has no system message yet.
		const sessionId = 'hardstop-created-system-msg';
		await setupSubagent(hooks, sessionId);
		const session = getAgentSession(sessionId);
		if (!session) throw new Error('test setup: session missing');
		session.pendingAdvisoryMessages = [
			'[prm:repetition_loop:2] Stop repeating the same edit.',
		];
		armBothTokens(sessionId);

		// No system message at all.
		const messages: Msg[] = [userMessage('go', sessionId)];
		await hooks.messagesTransform({}, { messages } as never);

		expect(messages[0].info.role).toBe('system');
		const text = firstSystemText(messages);
		expect(text).toContain('[ADVISORIES]');
		expect(text).toContain('[prm:repetition_loop:2]');
		expect(text).toContain('[HARD STOP]');
	});

	test('REGRESSION (advisory F): with NO system message and NO advisories, the injection still lands', async () => {
		// The previous branch only recovered because the advisory drain happened
		// to `unshift` a system message first. With an EMPTY advisory queue —
		// the ordinary case — nothing created one, yet the one-shot token was
		// already cleared above the lookup: the hard stop was burned and the
		// agent was denied with no explanation of why. The inject block now
		// creates its own carrier, mirroring the drain's `unshift`.
		const sessionId = 'hardstop-no-system-msg';
		await setupSubagent(hooks, sessionId);
		const session = getAgentSession(sessionId);
		if (!session) throw new Error('test setup: session missing');
		expect(session.pendingAdvisoryMessages ?? []).toHaveLength(0);
		armBothTokens(sessionId);

		const messages: Msg[] = [userMessage('go', sessionId)];
		await hooks.messagesTransform({}, { messages } as never);

		expect(messages).toHaveLength(2);
		expect(messages[0].info.role).toBe('system');
		expect(firstSystemText(messages)).toContain('[HARD STOP]');
		// And the token is still one-shot: a later turn is not re-decorated.
		expect(getAgentSession(sessionId)?.prmHardStopInjectPending).toBe(false);
	});

	test('INVARIANT 10: the created system message is the ONLY one, even with a pending self-coding warning', async () => {
		// The hard-stop `unshift` is not fenced by session type, so on an
		// ARCHITECT session it can co-fire with the self-coding block, which
		// reads the STALE `systemMessages` snapshot taken before it and unshifts
		// its own carrier when that snapshot is empty. Two `{ role: 'system' }`
		// messages is the #608 outage class (local models require exactly one at
		// index 0), so the hard-stop branch keeps the snapshot honest.
		const sessionId = 'hardstop-architect-single-system-msg';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');
		const session = getAgentSession(sessionId);
		if (!session) throw new Error('test setup: session missing');
		session.architectWriteCount = 1;
		session.selfCodingWarnedAtCount = 0;
		armBothTokens(sessionId);

		const messages: Msg[] = [userMessage('go', sessionId)];
		await hooks.messagesTransform({}, { messages } as never);

		const systemMsgs = messages.filter((m) => m.info.role === 'system');
		expect(systemMsgs).toHaveLength(1);
		expect(messages[0].info.role).toBe('system');
		// Both injections landed in that single message.
		const text = firstSystemText(messages);
		expect(text).toContain('[HARD STOP]');
		expect(text).toContain('SELF-CODING DETECTED');
	});
});

describe('PRM hard stop — C3 ordering in toolBefore (#2063 C3)', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, config);
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('budget accounting runs on the call that trips the hard stop', async () => {
		// Before C3 the throw happened first, so `trackToolCall` never ran for the
		// tripping call and the circuit breaker stopped accruing budget precisely
		// while the session was wedged.
		const sessionId = 'hardstop-accounting';
		await setupSubagent(hooks, sessionId);
		const before = getActiveWindow(sessionId)?.toolCalls ?? -1;
		expect(before).toBeGreaterThanOrEqual(1);

		armBothTokens(sessionId);
		const err = await callTool(hooks, sessionId, 'tripping-call');
		expect(err?.message).toContain('PRM HARD STOP');

		expect(getActiveWindow(sessionId)?.toolCalls).toBe(before + 1);
	});

	test('a NULL-window (architect-exempt) session still receives the hard stop', async () => {
		// `resolveSessionAndWindow` returns null for the architect. Moving the
		// hard-stop check below `if (!resolved) return` — the naive reading of the
		// reorder — would fail-open the containment for every such session.
		const sessionId = 'hardstop-null-window';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');
		expect(getActiveWindow(sessionId)).toBeUndefined();

		armBothTokens(sessionId);
		const err = await callTool(hooks, sessionId, 'architect-call');

		expect(err?.message).toContain('PRM HARD STOP');
		expect(getAgentSession(sessionId)?.prmHardStopPending).toBe(false);
	});

	test('delivery emits prm_hard_stop_delivered and carries the full context', async () => {
		// Delivery observability is the reason the duplicate `prm_hard_stop`
		// emission was removed from messagesTransform: `escalation.ts` owns the
		// TRIGGER event, and this is the distinct DELIVERY event. It is also the
		// ONLY delivery surface — the write-only `prmHardStopDeliveredAt` session
		// field was removed, so this event carrying sessionID/pattern/level/count
		// is what makes a delivered hard stop observable at all.
		const emitted: Array<{
			event: TelemetryEvent;
			data: Record<string, unknown>;
		}> = [];
		const originalEmit = telemetryInternals.emit;
		telemetryInternals.emit = ((
			event: TelemetryEvent,
			data: Record<string, unknown>,
		) => {
			emitted.push({ event, data });
		}) as typeof originalEmit;

		try {
			const sessionId = 'hardstop-telemetry';
			await setupSubagent(hooks, sessionId);
			armBothTokens(sessionId);

			const err = await callTool(hooks, sessionId, 'telemetry-call');
			expect(err?.message).toContain('PRM HARD STOP');

			// The deny token is consumed; the delivery record lives in telemetry.
			expect(getAgentSession(sessionId)?.prmHardStopPending).toBe(false);

			const delivered = emitted.filter(
				(e) => e.event === 'prm_hard_stop_delivered',
			);
			expect(delivered).toHaveLength(1);
			expect(delivered[0].data.sessionId).toBe(sessionId);
			expect(delivered[0].data.pattern).toBe('repetition_loop');
			expect(delivered[0].data.level).toBe(3);
			expect(delivered[0].data.occurrenceCount).toBe(3);

			// The TRIGGER event is emitted by escalation.ts only — never here.
			expect(emitted.filter((e) => e.event === 'prm_hard_stop')).toHaveLength(
				0,
			);
		} finally {
			telemetryInternals.emit = originalEmit;
		}
	});

	test('messagesTransform no longer emits the prm_hard_stop TRIGGER event', async () => {
		const emitted: TelemetryEvent[] = [];
		const originalEmit = telemetryInternals.emit;
		telemetryInternals.emit = ((event: TelemetryEvent) => {
			emitted.push(event);
		}) as typeof originalEmit;

		try {
			const sessionId = 'hardstop-no-duplicate-telemetry';
			await setupSubagent(hooks, sessionId);
			armBothTokens(sessionId);

			const messages: Msg[] = [
				systemMessage('You are a coder.', sessionId),
				userMessage('go', sessionId),
			];
			await hooks.messagesTransform({}, { messages } as never);

			expect(firstSystemText(messages)).toContain('[HARD STOP]');
			expect(emitted).not.toContain('prm_hard_stop');
		} finally {
			telemetryInternals.emit = originalEmit;
		}
	});
});
