import { describe, expect, it } from 'bun:test';
import {
	consolidateSystemMessages,
	type Message,
} from '../../../src/hooks/messages-transform';

/**
 * Issue #1778 H1: the OpenCode `messages.transform` hook delivers items in the
 * `{ info: { role }, parts: [{ type: 'text', text }] }` shape, NOT the flat
 * `{ role, content }` shape the earlier implementation gated on. These fixtures
 * exercise the production shape — the coverage whose absence let the function
 * ship as a silent no-op.
 */

function sysPart(text: string, extra: Record<string, unknown> = {}): Message {
	return {
		info: { role: 'system', ...extra },
		parts: [{ type: 'text', text }],
	};
}

function userPart(text: string): Message {
	return { info: { role: 'user' }, parts: [{ type: 'text', text }] };
}

function textOf(message: Message): string {
	const parts = (message as { parts?: Array<{ type?: string; text?: string }> })
		.parts;
	if (parts) {
		return parts
			.filter((p) => p.type === 'text' && typeof p.text === 'string')
			.map((p) => p.text)
			.join('\n');
	}
	const content = (message as { content?: unknown }).content;
	return typeof content === 'string' ? content : '';
}

function roleOf(message: Message): string | undefined {
	const info = (message as { info?: { role?: string } }).info;
	if (info && typeof info.role === 'string') return info.role;
	return (message as { role?: string }).role;
}

describe('consolidateSystemMessages — {info,parts} production shape (#1778 H1)', () => {
	it('merges multiple {info,parts} system messages into one at index 0', () => {
		const input: Message[] = [
			sysPart('Base prompt'),
			sysPart('Swarm agent prompt'),
			userPart('hello'),
		];

		const result = consolidateSystemMessages(input);

		const systemCount = result.filter((m) => roleOf(m) === 'system').length;
		expect(systemCount).toBe(1);
		expect(roleOf(result[0])).toBe('system');
		expect(textOf(result[0])).toBe('Base prompt\n\nSwarm agent prompt');
		// Non-system message preserved and still parts-shaped.
		expect(roleOf(result[result.length - 1])).toBe('user');
		expect(textOf(result[result.length - 1])).toBe('hello');
	});

	it('strips a {info,parts} system message injected at index > 0 (memory recall)', () => {
		// Mirrors src/memory/injector.ts splicing a system recall message at the
		// last-user index in a multi-turn session — exactly what the invariant-10
		// safety net must remove for local models (Qwen/Gemma).
		const input: Message[] = [
			sysPart('Base prompt'),
			userPart('turn 1'),
			{
				info: { role: 'system', agent: 'coder', sessionID: 's1' },
				parts: [{ type: 'text', text: 'RECALL BLOCK' }],
			},
			userPart('turn 2'),
		];

		const result = consolidateSystemMessages(input);

		// Exactly one system message, at index 0, and none survive at index > 0.
		expect(roleOf(result[0])).toBe('system');
		const laterSystem = result.slice(1).some((m) => roleOf(m) === 'system');
		expect(laterSystem).toBe(false);
		// The recall text was merged into the single system message, not dropped.
		expect(textOf(result[0])).toContain('Base prompt');
		expect(textOf(result[0])).toContain('RECALL BLOCK');
	});

	it('preserves info metadata on the consolidated system message', () => {
		const input: Message[] = [
			sysPart('First', { sessionID: 's9', id: 'm1', time: { created: 1 } }),
			sysPart('Second'),
		];

		const result = consolidateSystemMessages(input);

		expect(result).toHaveLength(1);
		const info = (result[0] as { info: Record<string, unknown> }).info;
		expect(info.role).toBe('system');
		expect(info.sessionID).toBe('s9');
		expect(info.id).toBe('m1');
	});

	it('is a no-op for a single canonical {info,parts} system message at index 0', () => {
		const input: Message[] = [sysPart('Only prompt'), userPart('hi')];

		const result = consolidateSystemMessages(input);

		expect(result).toHaveLength(2);
		expect(roleOf(result[0])).toBe('system');
		expect(textOf(result[0])).toBe('Only prompt');
	});

	it('is total: does not throw on a malformed info-shaped item with no parts array (#1778 H1 F1)', () => {
		// info.role set but no `parts` array — must not be narrowed to PartsMessage
		// and must not throw on `.parts.filter(...)`. The function stays total.
		const input = [
			{ info: { role: 'system' } },
			{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
		] as unknown as Message[];

		expect(() => consolidateSystemMessages(input)).not.toThrow();
		const result = consolidateSystemMessages(input);
		// The malformed item has no extractable text/role → passed through, no crash.
		expect(Array.isArray(result)).toBe(true);
	});

	it('handles a mixed flat + parts array without dropping either', () => {
		const input: Message[] = [
			{ role: 'system', content: 'Flat base' },
			sysPart('Parts swarm'),
			userPart('go'),
		];

		const result = consolidateSystemMessages(input);

		const systemCount = result.filter((m) => roleOf(m) === 'system').length;
		expect(systemCount).toBe(1);
		// First system message is flat, so the consolidated one preserves flat shape.
		const merged = result[0] as { content?: string };
		expect(merged.content).toBe('Flat base\n\nParts swarm');
	});
});
