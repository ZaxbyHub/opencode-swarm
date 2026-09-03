/**
 * Guidance-carrier unit tests (issue #2526).
 *
 * Pins the carrier contract: identity by id prefix (never text), the
 * fence-on-first-fill behavior, empty-carrier inertness (zero parts),
 * null-on-empty text for value construction sites, the host-render shape
 * predicate, and the boundary materializer's dual-shape conversion.
 */
import { describe, expect, test } from 'bun:test';
import {
	materializeSystemGuidance,
	materializeSystemGuidanceInPlace,
} from '../../../src/hooks/messages-transform';
import {
	appendGuidanceCarrier,
	buildGuidanceCarrier,
	deliveredGuidanceDelta,
	ensureGuidanceCarrier,
	fenceGuidanceText,
	findGuidanceCarriers,
	type GuidanceMessage,
	guidanceCarrierId,
	insertGuidanceCarrier,
	isGuidanceCarrier,
	isRenderableGuidance,
	messageTextOf,
	prependGuidanceText,
} from '../../../src/hooks/system-guidance-carrier';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';

function userMessage(text: string): GuidanceMessage {
	return {
		info: { id: 'u1', role: 'user', sessionID: 's1' },
		parts: [{ type: 'text', text }],
	};
}

describe('guidance carrier construction', () => {
	test('buildGuidanceCarrier fences the text and carries the id prefix', () => {
		const carrier = buildGuidanceCarrier('delegation', 'delegate everything');
		expect(carrier).not.toBeNull();
		expect(carrier?.info.role).toBe('user');
		expect(carrier?.info.id).toBe('swarm-guidance:delegation');
		expect(carrier?.parts[0]?.text).toBe(
			'<swarm_system_directive source="opencode-swarm" kind="delegation">\ndelegate everything\n</swarm_system_directive>',
		);
	});

	test('buildGuidanceCarrier returns null for empty/whitespace text', () => {
		expect(buildGuidanceCarrier('knowledge', '')).toBeNull();
		expect(buildGuidanceCarrier('knowledge', '   \n  ')).toBeNull();
	});

	test('insert/append return null and insert nothing on empty text', () => {
		const messages: GuidanceMessage[] = [userMessage('hi')];
		expect(insertGuidanceCarrier(messages, 'memory-recall', '', 0)).toBeNull();
		expect(appendGuidanceCarrier(messages, 'memory-recall', ' \t ')).toBeNull();
		expect(messages).toHaveLength(1);
	});

	test('isGuidanceCarrier detects by id prefix, never by text', () => {
		const carrier = buildGuidanceCarrier('guardrails', 'x');
		expect(isGuidanceCarrier(carrier)).toBe(true);
		// A user message containing the fence TEXT but no carrier id is NOT one.
		expect(isGuidanceCarrier(userMessage('<swarm_system_directive>'))).toBe(
			false,
		);
		// System-shaped and null/undefined entries are not carriers.
		expect(isGuidanceCarrier({ info: { role: 'system' }, parts: [] })).toBe(
			false,
		);
		expect(isGuidanceCarrier(undefined)).toBe(false);
		expect(isGuidanceCarrier(null)).toBe(false);
	});

	test('fenceGuidanceText is the single fence format', () => {
		expect(fenceGuidanceText('issue-trace', '[MODE: TRACE]')).toBe(
			'<swarm_system_directive source="opencode-swarm" kind="issue-trace">\n[MODE: TRACE]\n</swarm_system_directive>',
		);
		expect(fenceGuidanceText('knowledge', '')).toBeNull();
	});
});

describe('ensureGuidanceCarrier + prependGuidanceText', () => {
	test('empty carrier has ZERO parts (truly inert) and fence appears on first fill', () => {
		const messages: GuidanceMessage[] = [userMessage('real user')];
		const carrier = ensureGuidanceCarrier(messages, 'guardrails');
		expect(carrier.parts).toEqual([]);
		expect(messages[0]).toBe(carrier); // unshifted at index 0

		const delivered = prependGuidanceText(carrier, 'guardrails', 'first block');
		expect(delivered).toBe('first block');
		expect(carrier.parts).toHaveLength(1);
		expect(carrier.parts[0]?.text).toBe(
			'<swarm_system_directive source="opencode-swarm" kind="guardrails">\nfirst block\n</swarm_system_directive>',
		);
	});

	test('second prepend inserts inside the existing fence, never a second fence', () => {
		const messages: GuidanceMessage[] = [];
		const carrier = ensureGuidanceCarrier(messages, 'guardrails');
		prependGuidanceText(carrier, 'guardrails', 'first');
		prependGuidanceText(carrier, 'guardrails', 'second');
		const text = carrier.parts[0]?.text ?? '';
		expect(text.match(/<swarm_system_directive/g)?.length).toBe(1);
		expect(text.match(/<\/swarm_system_directive>/g)?.length).toBe(1);
		// top-of-body order preserved (second prepended ABOVE first)
		expect(text.indexOf('second')).toBeLessThan(text.indexOf('first'));
	});

	test('whitespace-only prepend is a no-op returning null', () => {
		const carrier = ensureGuidanceCarrier([], 'guardrails');
		expect(prependGuidanceText(carrier, 'guardrails', '  ')).toBeNull();
		expect(carrier.parts).toEqual([]);
	});

	test('findGuidanceCarriers returns carriers in order', () => {
		const a = buildGuidanceCarrier('guardrails', 'a');
		const b = buildGuidanceCarrier('knowledge', 'b');
		const messages = [
			userMessage('x'),
			a as GuidanceMessage,
			userMessage('y'),
			b as GuidanceMessage,
		];
		expect(findGuidanceCarriers(messages)).toEqual([a, b]);
	});

	test('messageTextOf joins text parts for dedupe predicates', () => {
		const carrier = ensureGuidanceCarrier([], 'guardrails');
		prependGuidanceText(carrier, 'guardrails', '[ADVISORIES] x [/ADVISORIES]');
		expect(messageTextOf(carrier)).toContain('[ADVISORIES]');
		expect(messageTextOf(undefined)).toBe('');
	});
});

describe('delivery predicates', () => {
	test('isRenderableGuidance requires user role + string id + non-empty text part', () => {
		const good = buildGuidanceCarrier('memory-recall', 'recall bundle');
		expect(isRenderableGuidance(good)).toBe(true);
		const empty = ensureGuidanceCarrier([], 'guardrails');
		expect(isRenderableGuidance(empty)).toBe(false);
		const whitespace = buildGuidanceCarrier('x', 'ok')!;
		whitespace.parts[0]!.text = '   ';
		expect(isRenderableGuidance(whitespace)).toBe(false);
		expect(isRenderableGuidance(null)).toBe(false);
	});

	test('deliveredGuidanceDelta gates on delta AND renderable shape', () => {
		const carrier = ensureGuidanceCarrier([], 'knowledge');
		const delta = prependGuidanceText(carrier, 'knowledge', 'directives');
		expect(deliveredGuidanceDelta(carrier, delta)).toBe(true);
		expect(deliveredGuidanceDelta(carrier, null)).toBe(false);
		expect(deliveredGuidanceDelta(carrier, '  ')).toBe(false);
		expect(deliveredGuidanceDelta(null, 'x')).toBe(false);
	});

	test('carriers render through the pinned host converter; empty carriers do not', () => {
		const messages: GuidanceMessage[] = [userMessage('real user')];
		const carrier = ensureGuidanceCarrier(messages, 'guardrails');
		const filled = buildGuidanceCarrier('memory-recall', 'RECALL-BUNDLE');
		messages.push(filled as GuidanceMessage);
		const rendered = hostToModelMessages(
			messages as unknown as HostPartsMessage[],
		);
		const text = renderedText(rendered);
		expect(text).toContain('real user');
		expect(text).not.toContain('guardrails'); // empty carrier inert
		expect(text).toContain('RECALL-BUNDLE'); // filled carrier renders
	});
});

describe('boundary materializer (messages-transform)', () => {
	test('parts-shaped system entries convert in place, preserving position and identity', () => {
		const sysEntry = {
			info: { role: 'system', sessionID: 's1' },
			parts: [{ type: 'text', text: 'GUIDANCE-BLOCK' }],
		};
		const messages = [
			userMessage('first'),
			sysEntry as unknown as GuidanceMessage,
			userMessage('last'),
		];
		const result = materializeSystemGuidance(
			messages as never,
		) as unknown as GuidanceMessage[];
		expect(result).toHaveLength(3);
		expect(result[1]).toBe(sysEntry); // reference identity preserved
		expect(
			(sysEntry as { info?: { role?: string; id?: string } }).info?.role,
		).toBe('user');
		expect(
			(sysEntry as { info?: { role?: string; id?: string } }).info?.id,
		).toBe(guidanceCarrierId('legacy-system'));
		expect((sysEntry as GuidanceMessage).parts[0]?.text).toContain(
			'GUIDANCE-BLOCK',
		);
	});

	test('flat system entries convert; the result survives the host converter (no TypeError)', () => {
		const flat = {
			role: 'system',
			content: [{ type: 'text', text: '[MODE: TRACE]' }],
		};
		const messages = [flat, userMessage('hi')] as never;
		const result = materializeSystemGuidance(
			messages,
		) as unknown as GuidanceMessage[];
		const rendered = hostToModelMessages(result as never);
		expect(renderedText(rendered)).toContain('[MODE: TRACE]');
	});

	test('tool-result-shaped and whitespace-only system entries are dropped', () => {
		const messages = [
			{ role: 'system', content: 'keep me', tool_call_id: 'tc_1' },
			{ role: 'system', content: '   ' },
			{ role: 'system', content: 'real guidance' },
		] as never;
		const result = materializeSystemGuidance(
			messages,
		) as unknown as GuidanceMessage[];
		expect(result).toHaveLength(1);
		expect(result[0]?.parts[0]?.text).toContain('real guidance');
	});

	test('materializeSystemGuidanceInPlace mutates the caller-held array (#1619)', () => {
		const original = [
			{
				info: { role: 'system' },
				parts: [{ type: 'text', text: 'boundary' }],
			},
			userMessage('user turn'),
		] as never;
		const hostArray = original as GuidanceMessage[];
		materializeSystemGuidanceInPlace(hostArray);
		expect(
			hostArray.every((m) => (m.info as { role?: string })?.role !== 'system'),
		).toBe(true);
		expect(hostArray).toHaveLength(2);
	});

	test('non-system entries pass through untouched', () => {
		const user = userMessage('plain');
		const assistant = {
			info: { id: 'a1', role: 'assistant' },
			parts: [{ type: 'text', text: 'reply' }],
		} as GuidanceMessage;
		const result = materializeSystemGuidance([
			user,
			assistant,
		] as never) as GuidanceMessage[];
		expect(result[0]).toBe(user);
		expect(result[1]).toBe(assistant);
	});
});
