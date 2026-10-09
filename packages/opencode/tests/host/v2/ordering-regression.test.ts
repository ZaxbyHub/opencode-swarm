/**
 * v2 context-hook ordering regression (issue #3151, critic-F1 mandated).
 *
 * Pins the interleaved tool-call/tool-result ordering contract of the
 * translated context event (src/host/v2/guidance.ts): when the v1
 * messages-transform chain runs against a session containing an assistant
 * tool-call message followed by a user tool-result message —
 *
 *   user text → assistant [text, tool-call] → user [tool-result, text] → user text
 *
 * — the adapter's translation/write-back must (a) keep the same number of
 * messages in the same order with the same roles, (b) place any injected
 * guidance text at the END of a message's parts (or re-home a trailing
 * carrier into event.system) — never between a tool-call and its tool-result,
 * and (c) drop no part.
 *
 * Both legs use controlled transform hooks (the adapter's input contract is
 * the v1 parts view) with observable effects (spy flag + text rewrite) so the
 * assertions cannot pass vacuously. The real 8.x chain is composeHandlers-
 * assembled in src/index.ts and mutates the same output.messages surface;
 * these tests pin the adapter boundary it flows through.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '@opencode-swarm/core';
import { onV2ContextEvent, registerV2ContextHook } from '../../../src/host/v2/guidance';
import type {
	V1HooksSubset,
	V2SessionContextEvent,
} from '../../../src/host/v2/types';
import { canonicalMkdtemp } from './tmpdir';

const INJECTED = '<<ordering-guidance>>';

interface V1ViewMessage {
	info: { id?: string; role?: string };
	parts: Array<{ type: string; text?: string }>;
}

/** The interleaved session under test: text → tool-call → tool-result → text. */
function interleavedEvent(): V2SessionContextEvent {
	return {
		sessionID: 'ordering-regression-session',
		agent: {
			id: 'architect',
			name: 'architect',
			mode: 'primary',
			hidden: false,
		},
		system: [],
		messages: [
			{
				id: 'm1',
				role: 'user',
				content: [{ type: 'text', text: 'question' }],
			},
			{
				id: 'm2',
				role: 'assistant',
				content: [
					{ type: 'text', text: 'calling' },
					{
						type: 'tool-call',
						id: 'call-1',
						tool: 'read',
						args: { path: 'x.ts' },
					},
				],
			},
			{
				id: 'm3',
				role: 'user',
				content: [
					{
						type: 'tool-result',
						callID: 'call-1',
						output: 'file contents',
					},
					{ type: 'text', text: 'continue' },
				],
			},
			{
				id: 'm4',
				role: 'user',
				content: [{ type: 'text', text: 'final note' }],
			},
		],
		options: {},
		tools: {},
	};
}

const TOOL_CALL = {
	type: 'tool-call',
	id: 'call-1',
	tool: 'read',
	args: { path: 'x.ts' },
};
const TOOL_RESULT = {
	type: 'tool-result',
	callID: 'call-1',
	output: 'file contents',
};

afterEach(() => {
	resetSwarmState();
});

describe('ordering regression: interleaved tool-call / tool-result (critic F1)', () => {
	test('appended guidance lands at message tails; order, roles, and every part survive', async () => {
		let messagesChainRan = false;
		const hooks: V1HooksSubset = {
			'experimental.chat.messages.transform': async (_input, output) => {
				messagesChainRan = true;
				const messages = output.messages as V1ViewMessage[];
				// Observable rewrite of m1's own text (proves the chain ran).
				if (messages[0]?.parts[0]) messages[0].parts[0].text = 'question [seen]';
				// Standard injection shape: append guidance text to the tail of the
				// tool-result message AND the final message.
				const m3 = messages.find((m) => m.info.id === 'm3');
				if (m3) m3.parts.push({ type: 'text', text: INJECTED });
				const last = messages[messages.length - 1];
				if (last) last.parts.push({ type: 'text', text: INJECTED });
			},
			'experimental.chat.system.transform': async () => {},
		};
		const directory = canonicalMkdtemp('swarm-v2-ordering-');
		// Drive through the REGISTERED context hook (registerV2ContextHook), the
		// way a v2 host would.
		const captured: Array<(event: unknown) => unknown> = [];
		await registerV2ContextHook(
			{
				session: {
					hook: async (_name: string, cb: (event: never) => unknown) => {
						captured.push(cb);
						return { dispose: async () => {} };
					},
				},
			} as never,
			hooks,
			directory,
			[],
		);
		expect(captured.length).toBe(1);
		const event = interleavedEvent();
		await captured[0]?.(event as never);

		// Not vacuous: the chain observably ran.
		expect(messagesChainRan).toBe(true);

		// (a) same number of messages, same order, same roles.
		expect(event.messages.length).toBe(4);
		expect(event.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(event.messages.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'user',
			'user',
		]);

		// (c) no part dropped + (b) injection only appended: exact content pin.
		// Text parts of a message are written back after its non-text parts
		// (writeBackTextParts: kept non-text first, then transformed texts), so
		// m2's original [text, tool-call] order becomes [tool-call, text] — no
		// part is lost, and nothing lands between the tool-call and its result.
		expect(event.messages[0].content).toEqual([
			{ type: 'text', text: 'question [seen]' },
		]);
		expect(event.messages[1].content).toEqual([
			TOOL_CALL,
			{ type: 'text', text: 'calling' },
		]);
		expect(event.messages[2].content).toEqual([
			TOOL_RESULT,
			{ type: 'text', text: 'continue' },
			{ type: 'text', text: INJECTED },
		]);
		expect(event.messages[3].content).toEqual([
			{ type: 'text', text: 'final note' },
			{ type: 'text', text: INJECTED },
		]);

		// (b) belt-and-braces: every injected part sits at the LAST index of its
		// message — never inside/before the tool-call → tool-result pair.
		for (const message of event.messages) {
			const injectedAt: number[] = [];
			message.content.forEach((part, index) => {
				if (part.type === 'text' && part.text === INJECTED)
					injectedAt.push(index);
			});
			for (const index of injectedAt) {
				expect(index).toBe(message.content.length - 1);
			}
		}
		const toolResultIndex = event.messages[2].content.findIndex(
			(p) => p.type === 'tool-result',
		);
		const m3InjectedIndex = event.messages[2].content.findIndex(
			(p) => p.type === 'text' && p.text === INJECTED,
		);
		expect(m3InjectedIndex).toBeGreaterThan(toolResultIndex);
	});

	test('a front-inserted carrier message never displaces the tool pair (re-homed to system)', async () => {
		let chainRan = false;
		const CARRIER_TEXT =
			'<swarm_system_directive source="opencode-swarm" kind="ordering">\ndirective\n</swarm_system_directive>';
		const hooks: V1HooksSubset = {
			'experimental.chat.messages.transform': async (_input, output) => {
				chainRan = true;
				const messages = output.messages as V1ViewMessage[];
				// Observable rewrite (proves the chain ran and pairing is
				// identity-based, not positional).
				for (const m of messages) {
					if (m.info.id === 'm1' && m.parts[0])
						m.parts[0].text = 'question [seen]';
				}
				// Harshest insertion: a guidance carrier unshifted BEFORE the real
				// messages (positional pairing would misalign everything).
				messages.unshift({
					info: { id: 'swarm-guidance:ordering', role: 'user' },
					parts: [{ type: 'text', text: CARRIER_TEXT }],
				});
			},
			'experimental.chat.system.transform': async (_input, output) => {
				(output as { system: string[] }).system.push('sys-rule');
			},
		};
		const directory = canonicalMkdtemp('swarm-v2-ordering-c-');
		const event = interleavedEvent();
		await onV2ContextEvent(event, hooks, directory);

		// Not vacuous.
		expect(chainRan).toBe(true);

		// The carrier was re-homed into system (exactly one destination), the
		// system chain ran, and NO message carries the directive text — so
		// nothing was inserted into the tool-call → tool-result window.
		expect(
			event.system.filter((p) => p.text === CARRIER_TEXT).length,
		).toBe(1);
		expect(event.system.some((p) => p.text === 'sys-rule')).toBe(true);
		for (const message of event.messages) {
			expect(
				message.content.some((p) => p.text === CARRIER_TEXT),
			).toBe(false);
		}

		// (a) original four messages, same order/roles; (c) every original part
		// survived, each on its OWN message (identity pairing).
		expect(event.messages.length).toBe(4);
		expect(event.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(event.messages.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'user',
			'user',
		]);
		expect(event.messages[0].content).toEqual([
			{ type: 'text', text: 'question [seen]' },
		]);
		expect(event.messages[1].content).toEqual([
			TOOL_CALL,
			{ type: 'text', text: 'calling' },
		]);
		expect(event.messages[2].content).toEqual([
			TOOL_RESULT,
			{ type: 'text', text: 'continue' },
		]);
		expect(event.messages[3].content).toEqual([
			{ type: 'text', text: 'final note' },
		]);
	});
});
