/**
 * PRM course corrections reach subagent sessions (issue #2063 C1).
 *
 * `messagesTransform`'s non-architect branch forwards only an allowlist of
 * advisory prefixes and silently discards everything else. PRM advisories are
 * pushed as `[prm:<pattern>:<level>] …` and were not on that list — yet PRM
 * only runs for sessions with `delegationActive`, i.e. subagents. So every
 * level-1 and level-2 course correction the containment ladder produced was
 * drained unread, and the first PRM signal a looping subagent ever saw was the
 * level-3 hard stop.
 *
 * Forwarding them re-opens a flood risk (course corrections are multi-kilobyte),
 * so this branch now applies the same `boundAdvisoryBytes` backstop the
 * architect branch uses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ADVISORY_TRUNCATION_NOTE,
	MAX_ADVISORY_BLOCK_BYTES,
} from '../../../src/hooks/guardrails/messages-transform';
import {
	ensureAgentSession,
	getAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const TEST_DIR = path.join(os.tmpdir(), 'guardrails-prm-advisory-forward');

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

function buildMessages(sessionId: string, systemText: string): Msg[] {
	return [
		{
			info: { role: 'system', sessionID: sessionId },
			parts: [{ type: 'text', text: systemText }],
		},
		{
			info: { role: 'user', sessionID: sessionId },
			parts: [{ type: 'text', text: 'do the task' }],
		},
	];
}

function firstSystemText(messages: Msg[]): string {
	const sys = messages.find((m) => m.info.role === 'system');
	const part = sys?.parts.find(
		(p) => p.type === 'text' && typeof p.text === 'string',
	);
	return (part?.text as string) ?? '';
}

function setupSubagent(sessionId: string, agentName = 'coder') {
	ensureAgentSession(sessionId, agentName);
	swarmState.activeAgent.set(sessionId, agentName);
	const session = getAgentSession(sessionId);
	if (!session) throw new Error('test setup: session missing');
	return session;
}

describe('[prm: advisories forwarded to subagent sessions (#2063 C1)', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, config);
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('a [prm: course correction is injected into the subagent system message', async () => {
		const sessionId = 'prm-forward-basic';
		const session = setupSubagent(sessionId);
		session.pendingAdvisoryMessages = [
			'[prm:repetition_loop:1] TRAJECTORY ALERT: repetition_loop detected. Consolidate your edits.',
		];

		const messages = buildMessages(sessionId, 'You are a coder agent.');
		await hooks.messagesTransform({}, { messages } as never);

		const text = firstSystemText(messages);
		expect(text).toContain('[ADVISORIES]');
		expect(text).toContain('[prm:repetition_loop:1]');
		expect(text).toContain('Consolidate your edits.');
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('non-allowlisted advisories are still discarded, and the queue is fully drained', async () => {
		const sessionId = 'prm-forward-mixed';
		const session = setupSubagent(sessionId);
		session.pendingAdvisoryMessages = [
			'SLOP DETECTED: abstraction_bloat in src/utils.ts',
			'[prm:ping_pong:2] TRAJECTORY ALERT: ping_pong detected.',
			'TRANSIENT ERROR: HTTP 503',
		];

		const messages = buildMessages(sessionId, 'You are a coder agent.');
		await hooks.messagesTransform({}, { messages } as never);

		const text = firstSystemText(messages);
		expect(text).toContain('[prm:ping_pong:2]');
		expect(text).toContain('TRANSIENT ERROR: HTTP 503');
		expect(text).not.toContain('SLOP DETECTED');
		// Drain is total — non-forwarded entries do not accumulate for later turns.
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('the forwarded block is byte-bounded, keep-latest, with a disclosure note', async () => {
		// Without the bound this branch would admit an unbounded [prm:] block into
		// a subagent prompt — the same flood the architect branch was hardened
		// against in #1976.
		const sessionId = 'prm-forward-bounded';
		const session = setupSubagent(sessionId);
		const body = 'X'.repeat(2000);
		session.pendingAdvisoryMessages = [
			`[prm:repetition_loop:1] OLDEST ${body}`,
			`[prm:repetition_loop:2] MIDDLE ${body}`,
			`[prm:repetition_loop:3] NEWEST ${body}`,
		];

		const messages = buildMessages(sessionId, 'BASE');
		await hooks.messagesTransform({}, { messages } as never);

		const text = firstSystemText(messages);
		const block = text.slice(
			text.indexOf('[ADVISORIES]'),
			text.indexOf('[/ADVISORIES]'),
		);
		expect(text).toContain(ADVISORY_TRUNCATION_NOTE);
		// Keep-latest: high-value advisories arrive late in a turn.
		expect(block).toContain('NEWEST');
		expect(block).not.toContain('OLDEST');
		// Three 2000-char entries exceed the budget; what survives fits it.
		expect(block.length).toBeLessThanOrEqual(MAX_ADVISORY_BLOCK_BYTES + 200);
		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('a within-budget block carries no truncation note', async () => {
		const sessionId = 'prm-forward-small';
		const session = setupSubagent(sessionId);
		session.pendingAdvisoryMessages = [
			'[prm:stuck_on_test:1] TRAJECTORY ALERT: stuck_on_test detected.',
		];

		const messages = buildMessages(sessionId, 'BASE');
		await hooks.messagesTransform({}, { messages } as never);

		const text = firstSystemText(messages);
		expect(text).toContain('[prm:stuck_on_test:1]');
		expect(text).not.toContain(ADVISORY_TRUNCATION_NOTE);
	});

	test('a subagent with no system message gets one created for the [prm: block', async () => {
		const sessionId = 'prm-forward-no-system';
		const session = setupSubagent(sessionId, 'reviewer');
		session.pendingAdvisoryMessages = [
			'[prm:context_thrash:1] TRAJECTORY ALERT: context_thrash detected.',
		];

		const messages: Msg[] = [
			{
				info: { role: 'user', sessionID: sessionId },
				parts: [{ type: 'text', text: 'review this' }],
			},
		];
		await hooks.messagesTransform({}, { messages } as never);

		expect(messages).toHaveLength(2);
		expect(messages[0].info.role).toBe('system');
		expect(firstSystemText(messages)).toContain('[prm:context_thrash:1]');
	});
});
