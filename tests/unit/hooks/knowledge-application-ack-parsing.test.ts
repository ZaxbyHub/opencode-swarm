/**
 * Tests for parseAcknowledgments (the ACK_PATTERN regex) and the
 * KnowledgeApplicationConfigSchema fields it's gated behind. Split from
 * knowledge-application.test.ts to stay under the repo's 500-line test file
 * limit (AGENTS.md invariant 7).
 */

import { describe, expect, it } from 'bun:test';
import { KnowledgeApplicationConfigSchema } from '../../../src/config/schema';
import { parseAcknowledgments } from '../../../src/hooks/knowledge-application';

describe('parseAcknowledgments', () => {
	it('decodes exact trace-entry markers without conflating sibling traces', () => {
		const entry = 'shared entry';
		const acks = parseAcknowledgments(
			`KNOWLEDGE_IGNORED:trace%3Aone:${encodeURIComponent(entry)} reason=not applicable`,
		);
		expect(acks).toEqual([
			{
				trace_id: 'trace:one',
				id: entry,
				result: 'ignored',
				reason: 'not applicable',
			},
		]);
	});

	it('extracts applied/ignored/violated markers with reasons', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const text = `KNOWLEDGE_APPLIED: ${id}
KNOWLEDGE_IGNORED: ${id} reason=not relevant
KNOWLEDGE_VIOLATED: ${id} reason=scope breach`;
		const acks = parseAcknowledgments(text);
		expect(acks).toHaveLength(3);
		expect(acks[0].result).toBe('applied');
		expect(acks[1].result).toBe('ignored');
		expect(acks[1].reason).toBe('not relevant');
		expect(acks[2].result).toBe('violated');
		expect(acks[2].reason).toBe('scope breach');
	});

	it('returns empty for non-matching text', () => {
		expect(parseAcknowledgments('plain prose, no markers')).toEqual([]);
	});

	it('matches when ID is followed by trailing explanation text', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const text = `KNOWLEDGE_APPLIED: ${id} - I have incorporated this directive.`;
		const acks = parseAcknowledgments(text);
		expect(acks).toHaveLength(1);
		expect(acks[0].id).toBe(id);
		expect(acks[0].result).toBe('applied');
	});

	it('matches when ID is followed by a period', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const text = `KNOWLEDGE_APPLIED: ${id}. Moving on to the next step.`;
		const acks = parseAcknowledgments(text);
		expect(acks).toHaveLength(1);
		expect(acks[0].id).toBe(id);
		expect(acks[0].result).toBe('applied');
	});

	it('matches when ID is followed by parenthetical', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const text = `KNOWLEDGE_APPLIED: ${id}(used in plan)`;
		const acks = parseAcknowledgments(text);
		expect(acks).toHaveLength(1);
		expect(acks[0].id).toBe(id);
		expect(acks[0].result).toBe('applied');
	});

	it('matches inline multi-marker on same line separated by spaces', () => {
		const id1 = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const id2 = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
		const text = `KNOWLEDGE_APPLIED: ${id1} KNOWLEDGE_IGNORED: ${id2} reason=not relevant`;
		const acks = parseAcknowledgments(text);
		expect(acks).toHaveLength(2);
		expect(acks[0].id).toBe(id1);
		expect(acks[0].result).toBe('applied');
		expect(acks[1].id).toBe(id2);
		expect(acks[1].result).toBe('ignored');
		expect(acks[1].reason).toBe('not relevant');
	});

	it('handles N_A marker', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const text = `KNOWLEDGE_N_A: ${id} reason=directive not applicable to this context`;
		const acks = parseAcknowledgments(text);
		expect(acks).toHaveLength(1);
		expect(acks[0].result).toBe('n_a');
		expect(acks[0].reason).toBe('directive not applicable to this context');
	});

	it('handles CONTRADICTED marker with observable evidence', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const text = `KNOWLEDGE_CONTRADICTED: ${id} reason=current scope requires workspace-relative paths`;
		const acks = parseAcknowledgments(text);
		expect(acks).toEqual([
			{
				id,
				result: 'contradicted',
				reason: 'current scope requires workspace-relative paths',
			},
		]);
	});

	it('matches ID at end of string without newline', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
		const text = `KNOWLEDGE_APPLIED: ${id}`;
		const acks = parseAcknowledgments(text);
		expect(acks).toHaveLength(1);
		expect(acks[0].id).toBe(id);
	});
});

describe('KnowledgeApplicationConfigSchema — max_gate_denials / gate_staleness_ms', () => {
	it('parses an empty object to the documented defaults', () => {
		const parsed = KnowledgeApplicationConfigSchema.parse({});
		expect(parsed.max_gate_denials).toBe(5);
		expect(parsed.gate_staleness_ms).toBe(600_000);
	});

	it('accepts explicit values within bounds', () => {
		const parsed = KnowledgeApplicationConfigSchema.parse({
			max_gate_denials: 10,
			gate_staleness_ms: 60_000,
		});
		expect(parsed.max_gate_denials).toBe(10);
		expect(parsed.gate_staleness_ms).toBe(60_000);
	});

	it('accepts the documented floor values (max_gate_denials=1, gate_staleness_ms=10000)', () => {
		const parsed = KnowledgeApplicationConfigSchema.parse({
			max_gate_denials: 1,
			gate_staleness_ms: 10_000,
		});
		expect(parsed.max_gate_denials).toBe(1);
		expect(parsed.gate_staleness_ms).toBe(10_000);
	});

	it('accepts the documented ceiling values (max_gate_denials=100, gate_staleness_ms=3600000)', () => {
		const parsed = KnowledgeApplicationConfigSchema.parse({
			max_gate_denials: 100,
			gate_staleness_ms: 3_600_000,
		});
		expect(parsed.max_gate_denials).toBe(100);
		expect(parsed.gate_staleness_ms).toBe(3_600_000);
	});

	it('rejects max_gate_denials below the floor or above the ceiling', () => {
		expect(() =>
			KnowledgeApplicationConfigSchema.parse({ max_gate_denials: 0 }),
		).toThrow();
		expect(() =>
			KnowledgeApplicationConfigSchema.parse({ max_gate_denials: 101 }),
		).toThrow();
	});

	it('rejects gate_staleness_ms below the floor or above the ceiling', () => {
		expect(() =>
			KnowledgeApplicationConfigSchema.parse({ gate_staleness_ms: 9_999 }),
		).toThrow();
		expect(() =>
			KnowledgeApplicationConfigSchema.parse({
				gate_staleness_ms: 3_600_001,
			}),
		).toThrow();
	});

	it('rejects non-integer values', () => {
		expect(() =>
			KnowledgeApplicationConfigSchema.parse({ max_gate_denials: 2.5 }),
		).toThrow();
	});
});
