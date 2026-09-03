/**
 * Runaway-output detector: MEDIUM band (issue #2063 B3).
 *
 * The original detector only counted tool-less assistant turns above 4000
 * characters. A stalled architect narrates in 200–4000 character turns, so the
 * shape that actually occurs in the field was invisible to it.
 *
 * Counting that band unconditionally would fire on ordinary conversation, so it
 * is gated twice:
 *
 *   1. an execution episode must be ARMED for the session, and
 *   2. the assistant turn must carry a host message id, which anchors the
 *      user-message reset. Array indices are never used — compaction rewrites
 *      the window and an index would silently point at a different message.
 *
 * Behaviour above 4000 characters is unchanged: unconditional, no episode gate,
 * no id requirement.
 *
 * Assertions read the GUIDANCE CARRIER TEXT (issue #2526: model-only guidance
 * rides a user-role carrier — the host drops role:'system' entries from this
 * transform surface), not `pendingAdvisoryMessages`: the architect drain runs
 * later in the same `messagesTransform` invocation, so the queue is always
 * empty by the time the handler returns.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { setExecutionEpisodeArmed } from '../../../src/hooks/guardrails/execution-episode';
import {
	_test_exports,
	createMessagesTransformHandler,
	MAX_TRACKED_COUNTED_ASSISTANT_MSGS,
	RUNAWAY_MEDIUM_MIN,
	RUNAWAY_OUTPUT_ADVISORY_MARKER,
} from '../../../src/hooks/guardrails/messages-transform';
import {
	isGuidanceCarrier,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const TEST_DIR = path.join(os.tmpdir(), 'guardrails-runaway-medium-band');

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

/** A medium-band reply: comfortably inside [RUNAWAY_MEDIUM_MIN, 4000]. */
const MEDIUM_TEXT = 'M'.repeat(RUNAWAY_MEDIUM_MIN + 800);
const HIGH_TEXT = 'H'.repeat(4500);
const SHORT_TEXT = 'ok';

function systemMsg(sessionId: string): Msg {
	return {
		info: { role: 'system', sessionID: sessionId },
		parts: [{ type: 'text', text: 'You are the architect.' }],
	};
}

function assistantMsg(sessionId: string, text: string, id?: string): Msg {
	return {
		info: { role: 'assistant', sessionID: sessionId, id },
		parts: [{ type: 'text', text }],
	};
}

function userMsg(sessionId: string, id?: string): Msg {
	return {
		info: { role: 'user', sessionID: sessionId, id },
		parts: [{ type: 'text', text: 'what about the other approach?' }],
	};
}

function setupArchitect(sessionId: string): void {
	ensureAgentSession(sessionId, 'architect');
	swarmState.activeAgent.set(sessionId, 'architect');
}

/**
 * Runs one transform and returns the resulting guidance-carrier text (joined
 * across carriers — normally exactly one, id 'swarm-guidance:guardrails').
 * Issue #2526: warning/advisory text lands in the carrier body, no longer in
 * the pre-seeded system message.
 */
async function turn(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	messages: Msg[],
): Promise<string> {
	await hooks.messagesTransform({}, { messages } as never);
	return messages
		.filter((m) => isGuidanceCarrier(m))
		.map((m) => messageTextOf(m))
		.join('\n');
}

function warned(carrierText: string): boolean {
	return carrierText.includes(RUNAWAY_OUTPUT_ADVISORY_MARKER);
}

describe('runaway detector — medium band (#2063 B3)', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, config);
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('five ordinary medium replies with NO execution episode stay silent', async () => {
		// The false-positive class the episode gate exists to prevent: normal
		// conversation is full of 200–4000 char replies with no tool calls.
		const sessionId = 'medium-unarmed';
		setupArchitect(sessionId);

		for (let i = 0; i < 5; i++) {
			const text = await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, MEDIUM_TEXT, `a${i}`),
			]);
			expect(warned(text)).toBe(false);
			expect(text).not.toContain('RUNAWAY OUTPUT STOP');
		}
	});

	test('medium replies DO count once an execution episode is armed', async () => {
		const sessionId = 'medium-armed';
		setupArchitect(sessionId);
		expect(setExecutionEpisodeArmed(sessionId, true)).toBe(true);

		for (const id of ['a0', 'a1']) {
			const text = await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, MEDIUM_TEXT, id),
			]);
			expect(warned(text)).toBe(false);
		}

		const third = await turn(hooks, [
			systemMsg(sessionId),
			assistantMsg(sessionId, MEDIUM_TEXT, 'a2'),
		]);
		expect(warned(third)).toBe(true);
		expect(third).toContain('3 consecutive');
	});

	test('an armed medium reply WITHOUT a message id is not counted', async () => {
		// Without an id the user-message reset has nothing to anchor on, and the
		// plan forbids approximating with an array index. Declining to count is
		// the fail-safe direction.
		const sessionId = 'medium-no-id';
		setupArchitect(sessionId);
		setExecutionEpisodeArmed(sessionId, true);

		for (let i = 0; i < 5; i++) {
			const text = await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, MEDIUM_TEXT), // no id
			]);
			expect(warned(text)).toBe(false);
		}
	});

	test('a user message after the counted turn resets the counter', async () => {
		const sessionId = 'medium-user-reset';
		setupArchitect(sessionId);
		setExecutionEpisodeArmed(sessionId, true);

		// Turns 1–2: count climbs to 2.
		for (const id of ['a1', 'a2']) {
			const text = await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, MEDIUM_TEXT, id),
			]);
			expect(warned(text)).toBe(false);
		}

		// Turn 3: the user has replied AFTER the turn we last counted (a2). The
		// counter resets to 0; a2 is then re-counted as the newest assistant turn,
		// leaving the count at 1. WITHOUT the reset the count would be 3 here and
		// the advisory would fire on this very turn.
		const turn3 = await turn(hooks, [
			systemMsg(sessionId),
			assistantMsg(sessionId, MEDIUM_TEXT, 'a2'),
			userMsg(sessionId, 'u1'),
		]);
		expect(warned(turn3)).toBe(false);

		// Turn 4 → 2. Still silent.
		const turn4 = await turn(hooks, [
			systemMsg(sessionId),
			assistantMsg(sessionId, MEDIUM_TEXT, 'a4'),
		]);
		expect(warned(turn4)).toBe(false);

		// Turn 5 → 3. Now it fires, proving the counter kept running after the
		// reset rather than being permanently disabled.
		const turn5 = await turn(hooks, [
			systemMsg(sessionId),
			assistantMsg(sessionId, MEDIUM_TEXT, 'a5'),
		]);
		expect(warned(turn5)).toBe(true);
	});

	test('a user message BEFORE the counted turn does not reset', async () => {
		const sessionId = 'medium-user-before';
		setupArchitect(sessionId);
		setExecutionEpisodeArmed(sessionId, true);

		let last = '';
		for (const id of ['a1', 'a2', 'a3']) {
			last = await turn(hooks, [
				systemMsg(sessionId),
				userMsg(sessionId, `u-${id}`),
				assistantMsg(sessionId, MEDIUM_TEXT, id),
			]);
		}

		expect(warned(last)).toBe(true);
	});

	test('an UNARMED medium turn neither counts nor resets', async () => {
		// The unarmed medium band must be a true no-op. Resetting there would be a
		// silent behaviour change for the pre-existing >4000 path.
		const sessionId = 'medium-unarmed-no-reset';
		setupArchitect(sessionId);

		for (const id of ['h0', 'h1']) {
			const text = await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, HIGH_TEXT, id),
			]);
			expect(warned(text)).toBe(false);
		}

		const medium = await turn(hooks, [
			systemMsg(sessionId),
			assistantMsg(sessionId, MEDIUM_TEXT, 'm1'),
		]);
		expect(warned(medium)).toBe(false);

		// The count survived the unarmed medium turn, so the next high turn is the
		// third and trips the advisory.
		const third = await turn(hooks, [
			systemMsg(sessionId),
			assistantMsg(sessionId, HIGH_TEXT, 'h2'),
		]);
		expect(warned(third)).toBe(true);
	});

	test('a short reply still resets the counter', async () => {
		const sessionId = 'medium-short-reset';
		setupArchitect(sessionId);
		setExecutionEpisodeArmed(sessionId, true);

		for (const id of ['a1', 'a2']) {
			await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, MEDIUM_TEXT, id),
			]);
		}

		await turn(hooks, [
			systemMsg(sessionId),
			assistantMsg(sessionId, SHORT_TEXT, 'short'),
		]);

		const next = await turn(hooks, [
			systemMsg(sessionId),
			assistantMsg(sessionId, MEDIUM_TEXT, 'a4'),
		]);
		expect(warned(next)).toBe(false);
	});

	test('>4000 char turns still count with no episode and no message id', async () => {
		// Pre-existing behaviour, explicitly NOT episode-gated.
		const sessionId = 'high-band-unchanged';
		setupArchitect(sessionId);

		let last = '';
		for (let i = 0; i < 3; i++) {
			last = await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, HIGH_TEXT), // no id, no episode
			]);
		}

		expect(warned(last)).toBe(true);
	});

	test('the medium band reaches the hard RUNAWAY OUTPUT STOP rung while armed', async () => {
		const sessionId = 'medium-hard-stop';
		setupArchitect(sessionId);
		setExecutionEpisodeArmed(sessionId, true);

		let last = '';
		for (let i = 0; i < 5; i++) {
			last = await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, MEDIUM_TEXT, `a${i}`),
			]);
		}

		expect(last).toContain('RUNAWAY OUTPUT STOP');
	});

	test('disarming the episode stops further counting', async () => {
		const sessionId = 'medium-disarm';
		setupArchitect(sessionId);
		setExecutionEpisodeArmed(sessionId, true);

		for (const id of ['a1', 'a2']) {
			await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, MEDIUM_TEXT, id),
			]);
		}

		setExecutionEpisodeArmed(sessionId, false);
		let last = '';
		for (const id of ['a3', 'a4', 'a5']) {
			last = await turn(hooks, [
				systemMsg(sessionId),
				assistantMsg(sessionId, MEDIUM_TEXT, id),
			]);
		}

		expect(warned(last)).toBe(false);
	});

	test('setExecutionEpisodeArmed reports false for an unknown session', () => {
		expect(setExecutionEpisodeArmed('no-such-session', true)).toBe(false);
	});
});

describe('lastCountedAssistantMsgId is bounded (invariant 8)', () => {
	beforeEach(() => resetSwarmState());
	afterEach(() => resetSwarmState());

	test('the marker map evicts least-recently-written entries at the bound', () => {
		// Tier-0 (zero-mock) test of the pure LRU helper the handler uses. The
		// delete-before-set is load-bearing: plain insertion order would evict the
		// FIRST-created session, which in a real plugin process is the long-lived
		// architect — the same inversion documented for the no-op detector's map.
		const map = new Map<string, string>();
		const overBound = MAX_TRACKED_COUNTED_ASSISTANT_MSGS + 25;

		_test_exports.rememberCountedAssistantMsg(map, 'architect', 'a0');
		for (let i = 0; i < overBound; i++) {
			_test_exports.rememberCountedAssistantMsg(map, `churn-${i}`, `m${i}`);
			// The architect keeps working, so it stays the most-recently-written.
			_test_exports.rememberCountedAssistantMsg(map, 'architect', `a${i}`);
		}

		expect(map.size).toBeLessThanOrEqual(MAX_TRACKED_COUNTED_ASSISTANT_MSGS);
		expect(map.get('architect')).toBe(`a${overBound - 1}`);
		expect(map.has('churn-0')).toBe(false);
		expect(map.has(`churn-${overBound - 1}`)).toBe(true);
	});

	test('the handler writes markers into the injected map, keyed per session', async () => {
		// Proves the bounded map above is the one the handler actually uses, and
		// that entries are session-scoped (no cross-session pollution).
		const map = new Map<string, string>();
		const handler = createMessagesTransformHandler({
			effectiveDirectory: TEST_DIR,
			cfg: config,
			requiredQaGates: [],
			requireReviewerAndTestEngineer: false,
			consecutiveNoToolTurns: new Map<string, number>(),
			lastCountedAssistantMsgId: map,
		});

		for (const sessionId of ['sess-a', 'sess-b', 'sess-c']) {
			setupArchitect(sessionId);
			setExecutionEpisodeArmed(sessionId, true);
			await handler(
				{} as never,
				{
					messages: [
						systemMsg(sessionId),
						assistantMsg(sessionId, MEDIUM_TEXT, `msg-${sessionId}`),
					],
				} as never,
			);
		}

		expect(map.size).toBe(3);
		expect(map.get('sess-a')).toBe('msg-sess-a');
		expect(map.get('sess-b')).toBe('msg-sess-b');
		expect(map.get('sess-c')).toBe('msg-sess-c');
	});
});
