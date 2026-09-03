/**
 * Issue #1619, review round 2 (F3): the behavioural backstop for the in-place
 * `messages.transform` contract must drive the ACTUAL composed handler array
 * registered by `src/index.ts`, not `consolidateSystemMessagesInPlace` in
 * isolation.
 *
 * Why this file exists separately from
 * tests/unit/hooks/system-message-consolidation-in-place.test.ts: that suite
 * calls the helper directly, so all of its tests still passed with the
 * `output.messages = consolidateSystemMessages(output.messages)` rebind
 * reintroduced in `src/index.ts`. Only the composed chain can distinguish a
 * rebind from an in-place mutation, because the distinction is *whose array
 * reference ends up holding the result*.
 *
 * The host contract being pinned (host binary ~100,667,665):
 *
 *   yield* d.trigger("experimental.chat.messages.transform", {}, {messages: C})
 *   ... Me.toModelMessagesEffect(C, Z)
 *
 * The host builds `C`, hands the plugin a FRESH wrapper object `{messages: C}`,
 * discards the hook's return value, and then uses its own `C`. So this test
 * holds `C` itself (`original`) and asserts the system-entry materialization (#2526) is visible
 * through that reference — exactly what the host would see. Under a rebind,
 * `original` is untouched and `output.messages` points at a discarded clone.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetSwarmState } from '../../../src/state';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../../helpers/knowledge-real-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

interface PartsMessage {
	info: { role: string; agent?: string; sessionID?: string };
	parts: Array<{ type: string; text?: string }>;
}

const SYSTEM_A = 'SENTINEL-BASE-PROMPT-ALPHA';
const SYSTEM_B = 'SENTINEL-MID-HISTORY-BRAVO';

function systemMessage(text: string): PartsMessage {
	return {
		info: { role: 'system', sessionID: 'composed-chain-session' },
		parts: [{ type: 'text', text }],
	};
}

function userMessage(text: string): PartsMessage {
	return {
		info: {
			role: 'user',
			agent: 'architect',
			sessionID: 'composed-chain-session',
		},
		parts: [{ type: 'text', text }],
	};
}

function allText(messages: PartsMessage[]): string {
	return messages
		.flatMap((message) => message.parts ?? [])
		.map((part) => part.text ?? '')
		.join('\n');
}

describe('composed experimental.chat.messages.transform mutates the host array in place (#1619 F3)', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		try {
			safeRmRecursive(directory);
		} catch {
			// Best-effort cleanup only — never an assertion. Booting the real host
			// starts background workers that can still hold a handle on the temp
			// directory, which surfaces on Windows as EBUSY. This is pre-existing
			// and host-specific: tests/unit/index-background-advisory-delivery.test.ts
			// fails the same way on an unmodified origin/main checkout on this
			// platform. Swallowing it here keeps a teardown artifact from
			// masquerading as a failed behavioural assertion; the temp directory
			// lives under the system temp root and is reclaimed by the OS.
		}
	});

	test('the consolidation is visible through the caller-held array reference', async () => {
		const plugin = await bootKnowledgeHost(directory);

		// `original` stands in for the host's local `C`. The wrapper object handed
		// to the hook is separate, exactly as in the host.
		const original: PartsMessage[] = [
			systemMessage(SYSTEM_A),
			userMessage('first user turn'),
			systemMessage(SYSTEM_B),
			userMessage('second user turn'),
		];
		const output: { messages: PartsMessage[] } = { messages: original };

		await plugin.hooks['experimental.chat.messages.transform']({}, output);

		// 1. The host still holds the SAME array object. A rebind fails here.
		expect(output.messages).toBe(original);

		// 2. System-entry materialization actually happened in that array
		//    (issue #2526): every role:'system' entry was converted IN PLACE to
		//    a user-role guidance carrier. Under a rebind the original array is
		//    untouched and still has two system messages.
		const systemRoles = original.filter(
			(message) => message.info?.role === 'system',
		);
		expect(systemRoles).toHaveLength(0);
		// Both legacy system entries were converted to carriers (position
		// preserved); other handlers may add their own carriers (e.g. the
		// delegation [NEXT] carrier at index 0), so assert by identity, not index.
		const legacyCarriers = original.filter(
			(message) => message.info?.id === 'swarm-guidance:legacy-system',
		);
		expect(legacyCarriers).toHaveLength(2);
		expect(legacyCarriers.every((m) => m.info?.role === 'user')).toBe(true);

		// 3. No injected text was lost — both system blocks survive as carrier
		//    bodies at their original positions. Asserted on content rather than
		//    exact indices so unrelated handlers in the chain (knowledge
		//    injection, delegation guidance, sanitizer) cannot make this brittle.
		const body3 = allText(original);
		expect(body3).toContain(SYSTEM_A);
		expect(body3).toContain(SYSTEM_B);

		// 4. The user turns are still present and still in order.
		const body = allText(original);
		expect(body).toContain('first user turn');
		expect(body).toContain('second user turn');
		expect(body.indexOf('first user turn')).toBeLessThan(
			body.indexOf('second user turn'),
		);
	});

	test('a second pass over the already-consolidated host array is stable', async () => {
		const plugin = await bootKnowledgeHost(directory);
		const original: PartsMessage[] = [
			systemMessage(SYSTEM_A),
			userMessage('only user turn'),
			systemMessage(SYSTEM_B),
		];
		const output: { messages: PartsMessage[] } = { messages: original };

		await plugin.hooks['experimental.chat.messages.transform']({}, output);
		const afterFirst = original.length;
		await plugin.hooks['experimental.chat.messages.transform']({}, output);

		expect(output.messages).toBe(original);
		expect(
			original.filter((message) => message.info?.role === 'system'),
		).toHaveLength(0);
		// Idempotence over HISTORY: every pre-existing entry survives the second
		// pass exactly once, in order, and no system entries reappear. (Plugin
		// producers legitimately re-emit per-transform guidance — the host hands
		// a FRESH array per request in production — so only history entries are
		// held stable here.)
		const firstPassHistory = original.slice(0, afterFirst);
		const historyIds = firstPassHistory.map((m) => m.info?.id);
		for (const message of firstPassHistory) {
			expect(
				original.filter((m) => m === message),
				'history entry duplicated by the second pass',
			).toHaveLength(1);
		}
		const positions = historyIds.map((id) =>
			original.findIndex((m) => m.info?.id === id),
		);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(allText(original)).toContain(SYSTEM_A);
		expect(allText(original)).toContain('only user turn');
	});
});
