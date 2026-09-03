/**
 * Boundary materializer tests (issue #2526).
 *
 * Replaces the pre-#2526 consolidation suites
 * (`system-message-consolidation*`, `messages-transform*`): merging system
 * entries into one index-0 message is dead semantics — the pinned host DROPS
 * role:'system' entries from `experimental.chat.messages.transform` output, so
 * `materializeSystemGuidanceInPlace` now converts each remaining system entry
 * into a user-role guidance carrier in place (or drops it when it could never
 * render). Coverage classes carried over from the old suites: totality on
 * malformed input (#1778 H1), tool-result and whitespace handling, the
 * no-system-anywhere output contract, no-injected-text-lost, in-place mutation
 * (#1619), and the adversarial corpus (__proto__, control characters, >100KB,
 * huge arrays, unicode).
 */
import { describe, expect, it } from 'bun:test';
import {
	materializeSystemGuidance,
	materializeSystemGuidanceInPlace,
} from '../../../src/hooks/messages-transform';
import { guidanceCarrierId } from '../../../src/hooks/system-guidance-carrier';

function partsSystem(text: string): Record<string, unknown> {
	return {
		info: { role: 'system', sessionID: 's1' },
		parts: [{ type: 'text', text }],
	};
}

function roleOf(message: unknown): unknown {
	const info = (message as { info?: { role?: unknown } })?.info;
	if (info && typeof info.role === 'string') return info.role;
	return (message as { role?: unknown })?.role;
}

function textOf(message: unknown): string {
	const m = message as {
		parts?: Array<{ type?: string; text?: string }>;
	};
	return (m?.parts ?? [])
		.filter((p) => p.type === 'text' && typeof p.text === 'string')
		.map((p) => p.text)
		.join('\n');
}

describe('materializeSystemGuidance', () => {
	it('leaves non-system messages untouched, same references', () => {
		const user = {
			info: { id: 'u', role: 'user' },
			parts: [{ type: 'text', text: 'hi' }],
		};
		const assistant = {
			info: { id: 'a', role: 'assistant' },
			parts: [{ type: 'text', text: 'ok' }],
		};
		const result = materializeSystemGuidance([user, assistant] as never);
		expect(result[0]).toBe(user);
		expect(result[1]).toBe(assistant);
	});

	it('converts every system entry in position — no text lost, no system left anywhere', () => {
		const messages = [
			partsSystem('BASE-PROMPT'),
			{ info: { id: 'u', role: 'user' }, parts: [{ type: 'text', text: 'q' }] },
			partsSystem('MEMORY-RECALL-BLOCK'),
			{ role: 'system', content: 'FLAT-KNOWLEDGE' },
		];
		const result = materializeSystemGuidance(messages as never);
		expect(result).toHaveLength(4);
		expect(result.every((m) => roleOf(m) !== 'system')).toBe(true);
		const allText = result.map((m) => textOf(m)).join('\n');
		expect(allText).toContain('BASE-PROMPT');
		expect(allText).toContain('MEMORY-RECALL-BLOCK');
		expect(allText).toContain('FLAT-KNOWLEDGE');
		// order preserved
		expect(textOf(result[0])).toContain('BASE-PROMPT');
		expect(textOf(result[2])).toContain('MEMORY-RECALL-BLOCK');
		expect(textOf(result[3])).toContain('FLAT-KNOWLEDGE');
	});

	it('converted entries are guidance carriers with preserved metadata', () => {
		const entry = partsSystem('GUIDANCE') as { info?: Record<string, unknown> };
		materializeSystemGuidance([entry] as never);
		expect(entry.info?.role).toBe('user');
		expect(entry.info?.id).toBe(guidanceCarrierId('legacy-system'));
		expect(entry.info?.sessionID).toBe('s1'); // metadata preserved
		expect(textOf(entry)).toContain('GUIDANCE');
	});

	it('drops misclassified tool-result system entries (flat tool_call_id/name)', () => {
		const messages = [
			{ role: 'system', content: 'tool out', tool_call_id: 'tc_1' },
			{ role: 'system', content: 'real guidance' },
		] as never;
		const result = materializeSystemGuidance(messages);
		expect(result).toHaveLength(1);
		expect(textOf(result[0])).toContain('real guidance');
	});

	it('drops whitespace-only and textless system entries; extracts array-content text', () => {
		const messages = [
			{ role: 'system', content: '   ' },
			{ role: 'system', content: [{ type: 'text', text: 'from array' }] },
			{ role: 'system', content: [{ type: 'image' }] },
			{ role: 'system', content: null },
			{ role: 'system' },
		] as never;
		const result = materializeSystemGuidance(messages);
		expect(result).toHaveLength(1);
		expect(textOf(result[0])).toContain('from array');
	});

	it('is total on malformed input (#1778 H1 F1: info-shaped without parts array)', () => {
		const malformed = { info: { role: 'system' } }; // no parts
		expect(() => materializeSystemGuidance([malformed] as never)).not.toThrow();
		// Neither shape is readable (info.role set but no parts; no top-level
		// role/content), so the entry passes through untouched — the same total
		// non-throwing semantics the consolidator had (#1778 H1 F1).
		const result = materializeSystemGuidance([malformed] as never);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(malformed);
	});

	it('handles mixed shapes without dropping either', () => {
		const messages = [
			partsSystem('PARTS-TEXT'),
			{ role: 'system', content: 'STRING-CONTENT' },
		];
		const result = materializeSystemGuidance(messages as never);
		expect(result).toHaveLength(2);
		expect(textOf(result[0])).toContain('PARTS-TEXT');
		expect(textOf(result[1])).toContain('STRING-CONTENT');
	});
});

describe('materializeSystemGuidanceInPlace (#1619 discipline)', () => {
	it('mutates the caller-held array; the host reference observes the change', () => {
		const hostArray = [
			partsSystem('A'),
			{ info: { id: 'u', role: 'user' }, parts: [{ type: 'text', text: 'q' }] },
			partsSystem('B'),
		];
		materializeSystemGuidanceInPlace(hostArray as never);
		expect(hostArray.every((m) => roleOf(m) !== 'system')).toBe(true);
		expect(hostArray).toHaveLength(3);
	});

	it('leaves an empty array empty and usable', () => {
		const arr: unknown[] = [];
		materializeSystemGuidanceInPlace(arr as never);
		expect(arr).toEqual([]);
	});

	it('preserves entry object identity (other handlers hold references)', () => {
		const entry = partsSystem('X');
		materializeSystemGuidanceInPlace([entry] as never);
		expect(roleOf(entry)).toBe('user'); // same object, mutated in place
	});
});

describe('materializeSystemGuidance adversarial corpus', () => {
	it('does not merge or prototype-pollute on __proto__ payloads', () => {
		const messages = [
			{ role: 'system', content: '{"__proto__":{"polluted":"yes"}}' },
		] as never;
		const result = materializeSystemGuidance(messages);
		expect(({} as { polluted?: string }).polluted).toBeUndefined();
		expect(textOf(result[0])).toContain('__proto__');
	});

	it('handles null bytes, control characters, and surrogate pairs without loss', () => {
		// Control characters stay as source-level escape sequences so this
		// file remains plain text for grep-based tooling.
		const weird = 'a\x00b\nc\x01d\x7f with \u{1F600} emoji';
		const messages = [{ role: 'system', content: weird }] as never;
		const result = materializeSystemGuidance(messages);
		expect(textOf(result[0])).toContain(weird.trim());
	});

	it('handles a >100KB system content', () => {
		const big = 'x'.repeat(120_000);
		const messages = [{ role: 'system', content: big }] as never;
		const result = materializeSystemGuidance(messages);
		expect(textOf(result[0])).toContain('x'.repeat(100));
	});

	it('handles huge arrays (10k entries) with system at both ends', () => {
		const messages: unknown[] = [partsSystem('HEAD')];
		for (let i = 0; i < 10_000; i++) {
			messages.push({
				info: { id: `u${i}`, role: 'user' },
				parts: [{ type: 'text', text: 'm' }],
			});
		}
		messages.push(partsSystem('TAIL'));
		const result = materializeSystemGuidance(messages as never);
		expect(result).toHaveLength(10_002);
		expect(result.every((m) => roleOf(m) !== 'system')).toBe(true);
		const joined = result.map((m) => textOf(m)).join('\n');
		expect(joined).toContain('HEAD');
		expect(joined).toContain('TAIL');
	});

	it('does not throw on adversarial role types (number/null/undefined role)', () => {
		const messages = [
			{ role: 123, content: 'x' },
			{ role: null, content: 'y' },
			{ role: undefined, content: 'z' },
		] as never;
		expect(() => materializeSystemGuidance(messages)).not.toThrow();
	});
});
