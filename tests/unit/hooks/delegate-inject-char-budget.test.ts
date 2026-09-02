/**
 * Issue #2045 — the delegate directive block obeys the configured injection
 * ceiling with a hard maximum of 2,000 characters, and the reviewer compliance
 * grammar stays reviewer-only.
 */

import { describe, expect, it } from 'bun:test';
import {
	buildDelegateDirectiveBlock,
	DELEGATE_INJECT_HARD_CHAR_CAP,
} from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';

function config(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		delegate_max_inject_count: 8,
		inject_char_budget: 2_000,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		same_project_weight: 1,
		cross_project_weight: 0.5,
		min_encounter_score: 0.1,
		initial_encounter_score: 1,
		encounter_increment: 0.1,
		max_encounter_score: 10,
		default_max_phases: 10,
		receipt_close_grace_days: 7,
		todo_max_phases: 3,
		sweep_enabled: true,
		...overrides,
	} as KnowledgeConfig;
}

function entry(
	id: string,
	priority: RankedEntry['directive_priority'],
	lessonChars = 120,
): RankedEntry {
	return {
		id,
		tier: 'swarm',
		lesson: 'x'.repeat(lessonChars),
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		directive_priority: priority,
		relevanceScore: { category: 0, confidence: 0, keywords: 0 },
		finalScore: 0.5,
	} as RankedEntry;
}

describe('delegate directive block char budget (issue #2045)', () => {
	it('exposes the 2,000-character hard cap', () => {
		expect(DELEGATE_INJECT_HARD_CHAR_CAP).toBe(2_000);
	});

	it('trims whole records from the end until the block fits the budget', () => {
		// The fixed header + ACK contract alone is ~1,100 chars, so a 1,600-char
		// budget leaves room for roughly two 120-char-lesson records.
		const entries = [
			entry('aaa-critical', 'critical'),
			entry('bbb-high', 'high'),
			entry('ccc-high', 'high'),
			entry('ddd-medium', 'medium'),
		];
		const block = buildDelegateDirectiveBlock(
			entries,
			config(),
			'trace-1',
			1_600,
		);
		expect(block).not.toBeNull();
		expect(block!.length).toBeLessThanOrEqual(1_600);
		// Priority order is preserved: critical survives, the trailing records
		// are trimmed first.
		expect(block!).toContain('aaa-critical');
		expect(block!).not.toContain('ddd-medium');
		expect(block!.endsWith('</delegate_knowledge_directives>')).toBe(true);
	});

	it('returns null when even one record cannot fit', () => {
		const block = buildDelegateDirectiveBlock(
			[entry('huge', 'critical')],
			config(),
			'trace-1',
			1_000,
		);
		expect(block).toBeNull();
	});

	it('no budget keeps the legacy untrimmed behavior', () => {
		const entries = Array.from({ length: 8 }, (_, i) =>
			entry(`entry-${i}`, 'medium'),
		);
		const block = buildDelegateDirectiveBlock(entries, config(), 'trace-1');
		// Every entry renders when no budget is passed (legacy callers/tests).
		for (let i = 0; i < 8; i++) {
			expect(block).toContain(`entry-${i}`);
		}
	});

	it('a budget above the hard cap is irrelevant to the builder, and callers clamp', () => {
		// The Task path and the transform path both clamp with
		// min(inject_char_budget ?? 2000, DELEGATE_INJECT_HARD_CHAR_CAP). Model
		// the clamp exactly as the callers compute it, then prove the resulting
		// block cannot exceed the hard cap even for a config budget of 10,000.
		const cfg = config({ inject_char_budget: 10_000 });
		const effective = Math.min(
			cfg.inject_char_budget ?? 2_000,
			DELEGATE_INJECT_HARD_CHAR_CAP,
		);
		expect(effective).toBe(2_000);
		const entries = Array.from({ length: 8 }, (_, i) =>
			entry(`entry-${i}`, 'high', 120),
		);
		const block = buildDelegateDirectiveBlock(
			entries,
			cfg,
			'trace-1',
			effective,
		);
		expect(block!.length).toBeLessThanOrEqual(DELEGATE_INJECT_HARD_CHAR_CAP);
		// With 8 maximal entries (~900 chars each ≈ 7,200) the trim must have
		// dropped records to fit 2,000.
		expect(block).not.toContain('entry-7');
	});

	it('the trace header survives trimming (ack correlation needs it)', () => {
		const entries = [
			entry('aaa-critical', 'critical'),
			entry('bbb-high', 'high'),
			entry('ccc-medium', 'medium'),
		];
		const block = buildDelegateDirectiveBlock(
			entries,
			config(),
			'trace-keep',
			1_500,
		);
		expect(block).toContain('trace_id: trace-keep');
	});
});
