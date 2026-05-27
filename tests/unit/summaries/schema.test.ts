import { describe, expect, test } from 'bun:test';
import {
	AgentWorkSummarySchema,
	ArchitectureSupervisorReportSchema,
	capArray,
	countWords,
	MAX_AGENT_SUMMARY_WORDS,
	MAX_LIST_ITEMS,
	normalizeAgentWorkSummary,
	SUMMARY_SCHEMA_VERSION,
	SupervisorVerdictSchema,
	truncateWords,
} from '../../../src/summaries/schema';

describe('countWords', () => {
	test('counts whitespace-delimited words', () => {
		expect(countWords('one two three')).toBe(3);
	});
	test('collapses runs of whitespace', () => {
		expect(countWords('  one   two \n three  ')).toBe(3);
	});
	test('empty string is zero', () => {
		expect(countWords('   ')).toBe(0);
	});
});

describe('truncateWords', () => {
	test('leaves short text untouched', () => {
		const r = truncateWords('a b c', 5);
		expect(r.truncated).toBe(false);
		expect(r.text).toBe('a b c');
	});
	test('truncates and flags when over cap', () => {
		const r = truncateWords('a b c d e', 3);
		expect(r.truncated).toBe(true);
		expect(r.text).toBe('a b c…');
		expect(countWords(r.text)).toBe(3);
	});
});

describe('capArray', () => {
	test('keeps arrays at or under cap', () => {
		const r = capArray([1, 2, 3], 3);
		expect(r.truncated).toBe(false);
		expect(r.items).toEqual([1, 2, 3]);
	});
	test('drops overflow and flags', () => {
		const r = capArray([1, 2, 3, 4], 2);
		expect(r.truncated).toBe(true);
		expect(r.items).toEqual([1, 2]);
	});
});

describe('normalizeAgentWorkSummary', () => {
	const base = {
		phase: 1,
		session_id: 's1',
		agent: 'coder',
		summary: 'did the thing',
	};

	test('produces a schema-valid summary with defaults', () => {
		const s = normalizeAgentWorkSummary(base);
		expect(s.schema_version).toBe(SUMMARY_SCHEMA_VERSION);
		expect(s.key_decisions).toEqual([]);
		expect(s.truncated).toBeUndefined();
		// round-trips through the schema
		expect(() => AgentWorkSummarySchema.parse(s)).not.toThrow();
	});

	test('truncates an over-length summary and sets the flag', () => {
		const longSummary = Array.from(
			{ length: MAX_AGENT_SUMMARY_WORDS + 20 },
			(_, i) => `w${i}`,
		).join(' ');
		const s = normalizeAgentWorkSummary({ ...base, summary: longSummary });
		expect(s.truncated).toBe(true);
		expect(countWords(s.summary)).toBe(MAX_AGENT_SUMMARY_WORDS);
	});

	test('caps lists at MAX_LIST_ITEMS and flags truncation', () => {
		const many = Array.from({ length: MAX_LIST_ITEMS + 3 }, (_, i) => `d${i}`);
		const s = normalizeAgentWorkSummary({ ...base, key_decisions: many });
		expect(s.key_decisions).toHaveLength(MAX_LIST_ITEMS);
		expect(s.truncated).toBe(true);
	});

	test('respects a lower custom summary word cap', () => {
		const s = normalizeAgentWorkSummary(
			{ ...base, summary: 'one two three four five' },
			2,
		);
		expect(countWords(s.summary)).toBe(2);
		expect(s.truncated).toBe(true);
	});
});

describe('SupervisorVerdictSchema', () => {
	test('accepts the council verdict vocabulary', () => {
		for (const v of ['APPROVE', 'CONCERNS', 'REJECT']) {
			expect(SupervisorVerdictSchema.parse(v)).toBe(v);
		}
	});
	test('rejects anything else', () => {
		expect(SupervisorVerdictSchema.safeParse('info').success).toBe(false);
	});
});

describe('ArchitectureSupervisorReportSchema', () => {
	test('validates a minimal report and defaults arrays', () => {
		const report = ArchitectureSupervisorReportSchema.parse({
			schema_version: SUMMARY_SCHEMA_VERSION,
			phase: 2,
			verdict: 'CONCERNS',
			created_at: new Date().toISOString(),
		});
		expect(report.findings).toEqual([]);
		expect(report.knowledge_recommendations).toEqual([]);
	});

	test('rejects an invalid verdict', () => {
		const result = ArchitectureSupervisorReportSchema.safeParse({
			schema_version: SUMMARY_SCHEMA_VERSION,
			phase: 2,
			verdict: 'MAYBE',
			created_at: new Date().toISOString(),
		});
		expect(result.success).toBe(false);
	});
});
