/**
 * Issue #1619 — the final `experimental.chat.messages.transform` handler must
 * consolidate system messages by mutating `output.messages` IN PLACE.
 *
 * Why: the OpenCode host invokes each plugin hook as `M(input, output)`,
 * DISCARDS the handler's return value, and afterwards reads its OWN local
 * message array (host binary ~100,667,665:
 * `yield* d.trigger("experimental.chat.messages.transform",{},{messages:C})`
 * then `Me.toModelMessagesEffect(C,Z)`). The previous
 * `output.messages = consolidateSystemMessages(output.messages)` was therefore a
 * rebind that the host never observed — the consolidation claimed by
 * AGENTS.md invariant 10 and `docs/context-map.md` had never run in production.
 *
 * Now that it does run, it interacts with every hook that splices a
 * `role: 'system'` message into the live history. This file pins that
 * interaction — BOTH the merge to index 0 and the strip of leftovers — so the
 * behaviour is documented rather than accidental.
 */
import { describe, expect, test } from 'bun:test';
import { _test_exports as knowledgeTestExports } from '../../../src/hooks/knowledge-injector';
import type { MessageWithParts } from '../../../src/hooks/knowledge-types';
import {
	consolidateSystemMessages,
	consolidateSystemMessagesInPlace,
	type Message,
} from '../../../src/hooks/messages-transform';
import { _test_exports as memoryTestExports } from '../../../src/memory/injector';

const { injectKnowledgeMessage, INJECTION_SENTINEL } = knowledgeTestExports;
const { recallMessageInsertIndex } = memoryTestExports;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function userMessage(text: string): MessageWithParts {
	return { info: { role: 'user' }, parts: [{ type: 'text', text }] };
}

function assistantMessage(text: string): MessageWithParts {
	return { info: { role: 'assistant' }, parts: [{ type: 'text', text }] };
}

/**
 * The `{ info, parts }` system message shape that `guardrails/messages-transform`
 * unshifts at index 0 (e.g. `src/hooks/guardrails/messages-transform.ts:780-786`).
 */
function partsSystemMessage(text: string): MessageWithParts {
	return { info: { role: 'system' }, parts: [{ type: 'text', text }] };
}

/**
 * The FLAT `{ role, content: [{ type, text }] }` system message shape that
 * `src/hooks/issue-trace.ts:166-186` pushes onto the END of the array. It is a
 * different shape from every other injector, which is why the dual-shape
 * handling in `consolidateSystemMessages` matters here.
 */
function flatSystemMessage(text: string) {
	return { role: 'system', content: [{ type: 'text', text }] };
}

/** Recall message shape from `src/memory/injector.ts:132-139`. */
function memoryRecallMessage(text: string, agent: string, sessionID: string) {
	return {
		info: { role: 'system', agent, sessionID },
		parts: [{ type: 'text', text }],
	};
}

function roleOf(message: unknown): string | undefined {
	const m = message as {
		info?: { role?: string };
		role?: string;
	};
	return m.info?.role ?? m.role;
}

function textOf(message: unknown): string {
	const m = message as {
		parts?: Array<{ type?: string; text?: string }>;
		content?: unknown;
	};
	if (Array.isArray(m.parts)) {
		return m.parts
			.filter((p) => p.type === 'text' && typeof p.text === 'string')
			.map((p) => p.text as string)
			.join('\n');
	}
	if (typeof m.content === 'string') return m.content;
	if (Array.isArray(m.content)) {
		return (m.content as Array<{ type?: string; text?: string }>)
			.filter((p) => p.type === 'text' && typeof p.text === 'string')
			.map((p) => p.text as string)
			.join('\n');
	}
	return '';
}

function systemIndices(messages: unknown[]): number[] {
	return messages
		.map((m, i) => (roleOf(m) === 'system' ? i : -1))
		.filter((i) => i >= 0);
}

// ---------------------------------------------------------------------------
// The in-place contract itself
// ---------------------------------------------------------------------------

describe('consolidateSystemMessagesInPlace — host-visibility contract (#1619)', () => {
	test('the array the host still holds is the one that gets consolidated', () => {
		// `hostArray` stands in for the host's local `C`. The hook only ever sees
		// it through `output.messages`; the host never re-reads that property.
		const hostArray: Message[] = [
			partsSystemMessage('BASE') as unknown as Message,
			userMessage('hello') as unknown as Message,
			partsSystemMessage('EXTRA') as unknown as Message,
		];
		const output: { messages?: Message[] } = { messages: hostArray };

		consolidateSystemMessagesInPlace(output.messages as Message[]);

		// Assertions read `hostArray`, NOT `output.messages`.
		expect(hostArray).toHaveLength(2);
		expect(systemIndices(hostArray)).toEqual([0]);
		expect(textOf(hostArray[0])).toBe('BASE\n\nEXTRA');
		expect(roleOf(hostArray[1])).toBe('user');
	});

	test('regression: a REBIND leaves the host array untouched (the #1619 defect)', () => {
		// Previous code did exactly this. It is kept as an executable record of
		// why the in-place variant exists: the host reads `hostArray`, so the
		// consolidated value assigned to `output.messages` was thrown away.
		const hostArray: Message[] = [
			partsSystemMessage('BASE') as unknown as Message,
			userMessage('hello') as unknown as Message,
			partsSystemMessage('EXTRA') as unknown as Message,
		];
		const output: { messages?: Message[] } = { messages: hostArray };

		output.messages = consolidateSystemMessages(output.messages as Message[]);

		expect(output.messages).toHaveLength(2); // the rebound value is consolidated
		expect(hostArray).toHaveLength(3); // ...but the host still sees 3
		expect(systemIndices(hostArray)).toEqual([0, 2]);
	});

	test('no-op input still leaves the caller with a usable array', () => {
		const hostArray: Message[] = [
			userMessage('only user') as unknown as Message,
		];
		consolidateSystemMessagesInPlace(hostArray);
		expect(hostArray).toHaveLength(1);
		expect(roleOf(hostArray[0])).toBe('user');
	});

	test('an empty array is left empty', () => {
		const hostArray: Message[] = [];
		consolidateSystemMessagesInPlace(hostArray);
		expect(hostArray).toEqual([]);
	});

	test('a very long history does not blow the argument limit', () => {
		// Guards the deliberate `for … push` over `push(...consolidated)`:
		// history length is user-controlled, and spreading a large array into an
		// argument list throws `RangeError: Maximum call stack size exceeded`.
		const hostArray: Message[] = [
			partsSystemMessage('BASE') as unknown as Message,
		];
		for (let i = 0; i < 200_000; i++) {
			hostArray.push(userMessage(`turn ${i}`) as unknown as Message);
		}
		hostArray.push(partsSystemMessage('TAIL') as unknown as Message);

		expect(() => consolidateSystemMessagesInPlace(hostArray)).not.toThrow();
		expect(hostArray).toHaveLength(200_001);
		expect(textOf(hostArray[0])).toBe('BASE\n\nTAIL');
		expect(systemIndices(hostArray)).toEqual([0]);
	});
});

// ---------------------------------------------------------------------------
// Interaction with the real mid-history system-message injectors
// ---------------------------------------------------------------------------

describe('consolidation vs. mid-history system injectors (#1619)', () => {
	test('knowledge-injector: the block is merged to index 0, none left behind', () => {
		const hostArray = [
			userMessage('first question'),
			assistantMessage('first answer'),
			userMessage('second question'),
		];
		const output = { messages: hostArray };

		// Real production splice (`src/hooks/knowledge-injector.ts:746-774`).
		injectKnowledgeMessage(output, 'KNOWLEDGE-BLOCK');

		// Pin the pre-consolidation position so a change to the injector's
		// "just before the last user message" rule is visible here too.
		expect(systemIndices(hostArray)).toEqual([2]);

		consolidateSystemMessagesInPlace(hostArray as unknown as Message[]);

		// MERGE: the injected text survives, relocated to index 0.
		expect(systemIndices(hostArray)).toEqual([0]);
		expect(textOf(hostArray[0])).toContain('KNOWLEDGE-BLOCK');
		expect(textOf(hostArray[0])).toContain(INJECTION_SENTINEL);
		// STRIP: nothing system-role survives after index 0, and the three real
		// turns keep their order.
		expect(hostArray).toHaveLength(4);
		expect(hostArray.slice(1).map((m) => textOf(m))).toEqual([
			'first question',
			'first answer',
			'second question',
		]);
	});

	test('memory recall: the recall block is merged to index 0, none left behind', () => {
		const hostArray = [
			userMessage('first question'),
			assistantMessage('first answer'),
			userMessage('second question'),
		];
		// Real production insert position (`src/memory/injector.ts:131`).
		const insertAt = recallMessageInsertIndex(hostArray);
		hostArray.splice(
			insertAt,
			0,
			memoryRecallMessage('RECALL-BLOCK', 'coder', 's-1') as MessageWithParts,
		);
		expect(systemIndices(hostArray)).toEqual([2]);

		consolidateSystemMessagesInPlace(hostArray as unknown as Message[]);

		expect(systemIndices(hostArray)).toEqual([0]);
		expect(textOf(hostArray[0])).toBe('RECALL-BLOCK');
		expect(hostArray).toHaveLength(4);
	});

	test('both injectors: texts merge in array order and only one system survives', () => {
		const hostArray = [
			userMessage('first question'),
			assistantMessage('first answer'),
			userMessage('second question'),
		];
		// `memoryLifecycleHooks.messagesTransform` is registered before
		// `knowledgeInjectorHook` in the composed chain (`src/index.ts`). Both
		// target the last user message, and because each recomputes that index
		// against the array as it finds it, the recall block ends up ahead of the
		// knowledge block. The assertion below pins the resulting array, not the
		// registration order.
		const insertAt = recallMessageInsertIndex(hostArray);
		hostArray.splice(
			insertAt,
			0,
			memoryRecallMessage('RECALL-BLOCK', 'coder', 's-1') as MessageWithParts,
		);
		injectKnowledgeMessage({ messages: hostArray }, 'KNOWLEDGE-BLOCK');
		expect(systemIndices(hostArray)).toEqual([2, 3]);

		consolidateSystemMessagesInPlace(hostArray as unknown as Message[]);

		expect(systemIndices(hostArray)).toEqual([0]);
		const merged = textOf(hostArray[0]);
		expect(merged.indexOf('RECALL-BLOCK')).toBeGreaterThanOrEqual(0);
		expect(merged.indexOf('KNOWLEDGE-BLOCK')).toBeGreaterThan(
			merged.indexOf('RECALL-BLOCK'),
		);
		expect(hostArray).toHaveLength(4);
	});

	test('mixed shapes: parts-shape head + flat-shape tail merge into one parts message', () => {
		// Reproduces the real production mix: guardrails unshifts a `{info,parts}`
		// system message at index 0, issue-trace pushes a FLAT
		// `{role, content:[…]}` system message at the tail, and knowledge-injector
		// splices in the middle.
		const hostArray: unknown[] = [
			partsSystemMessage('[GUARDRAIL] stop'),
			userMessage('first question'),
			assistantMessage('first answer'),
			userMessage('second question'),
		];
		injectKnowledgeMessage(
			{ messages: hostArray as MessageWithParts[] },
			'KNOWLEDGE-BLOCK',
		);
		hostArray.push(flatSystemMessage('[MODE: EXECUTE]'));
		expect(systemIndices(hostArray)).toEqual([0, 3, 5]);

		consolidateSystemMessagesInPlace(hostArray as Message[]);

		expect(systemIndices(hostArray)).toEqual([0]);
		// Shape of the survivor follows the FIRST system message (parts shape).
		expect((hostArray[0] as { parts?: unknown[] }).parts).toBeInstanceOf(Array);
		const merged = textOf(hostArray[0]);
		expect(merged).toContain('[GUARDRAIL] stop');
		expect(merged).toContain('KNOWLEDGE-BLOCK');
		expect(merged).toContain('[MODE: EXECUTE]');
		// The tail directive is RELOCATED, not dropped: it no longer sits last.
		expect(textOf(hostArray[hostArray.length - 1])).toBe('second question');
		expect(hostArray).toHaveLength(4);
	});

	test('no injected system text is lost when several injectors stack', () => {
		const hostArray: unknown[] = [
			partsSystemMessage('S1'),
			userMessage('u1'),
			partsSystemMessage('S2'),
			assistantMessage('a1'),
			partsSystemMessage('S3'),
			userMessage('u2'),
			flatSystemMessage('S4'),
		];

		consolidateSystemMessagesInPlace(hostArray as Message[]);

		expect(textOf(hostArray[0])).toBe('S1\n\nS2\n\nS3\n\nS4');
		expect(hostArray.map((m) => textOf(m))).toEqual([
			'S1\n\nS2\n\nS3\n\nS4',
			'u1',
			'a1',
			'u2',
		]);
	});
});
