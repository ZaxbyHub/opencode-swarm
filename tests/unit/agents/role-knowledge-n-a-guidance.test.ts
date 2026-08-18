/**
 * Role-prompt N_A guidance contract (issue #2032).
 *
 * Every role that instructs agents on knowledge-directive acknowledgment or
 * knowledge_receipt filing must offer the neutral N_A channel for
 * non-applicable entries and reserve IGNORED for applicable-but-deliberately-
 * not-followed. Producers are where the old IGNORED-for-irrelevance steering
 * lived; these assertions keep the atomic semantic migration from regressing.
 */

import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { createCoderAgent } from '../../../src/agents/coder';
import { createReviewerAgent } from '../../../src/agents/reviewer';
import { createSpecWriterAgent } from '../../../src/agents/spec-writer';
import { createTestEngineerAgent } from '../../../src/agents/test-engineer';

describe('role prompts: knowledge N_A guidance (#2032)', () => {
	/**
	 * Section-anchored extraction (PRR-010): bare toContain over the whole
	 * prompt passes even when the phrase wanders into an unrelated section.
	 * The receipt-tool guidance lives in each role's KNOWLEDGE RECEIPTS
	 * section, which runs to the next '## ' heading or end of prompt.
	 */
	function receiptGuidanceSection(prompt: string): string {
		const start = prompt.indexOf('## KNOWLEDGE RECEIPTS');
		expect(start).toBeGreaterThanOrEqual(0);
		const next = prompt.indexOf('\n## ', start + 1);
		return prompt.slice(start, next > start ? next : undefined);
	}

	it('spec_writer steers non-applicable directives to KNOWLEDGE_N_A', () => {
		const agent = createSpecWriterAgent('opencode/big-pickle');
		const prompt = agent.config.prompt!;
		expect(prompt).toContain('KNOWLEDGE_N_A: <id> reason=');
		// IGNORED is reserved, not the irrelevance channel.
		expect(prompt).toMatch(/reserve\s+KNOWLEDGE_IGNORED/i);
		expect(prompt).toMatch(
			/When a directive does not apply to this task, record\s+KNOWLEDGE_N_A/s,
		);
	});

	it('coder receipt-tool guidance offers the n_a channel and N_A chat marker', () => {
		const section = receiptGuidanceSection(
			createCoderAgent('opencode/big-pickle').config.prompt!,
		);
		expect(section).toContain('as n_a with a reason (neutral;');
		expect(section).toContain('use ignored ONLY when');
		expect(section).toContain('KNOWLEDGE_N_A');
	});

	it('reviewer receipt-tool guidance offers the n_a channel and N_A chat marker', () => {
		const section = receiptGuidanceSection(
			createReviewerAgent('opencode/big-pickle').config.prompt!,
		);
		expect(section).toContain('as n_a with a reason (neutral;');
		expect(section).toContain('use ignored ONLY when');
		expect(section).toContain('KNOWLEDGE_N_A');
	});

	it('test_engineer receipt-tool guidance offers the n_a channel and N_A chat marker', () => {
		const section = receiptGuidanceSection(
			createTestEngineerAgent('opencode/big-pickle').config.prompt!,
		);
		expect(section).toContain('as n_a with a reason (neutral;');
		expect(section).toContain('use ignored ONLY when');
		expect(section).toContain('KNOWLEDGE_N_A');
	});

	it('architect prompt still carries the full marker contract (guard against factory drift)', () => {
		const agent = createArchitectAgent('opencode/big-pickle');
		expect(agent.config.prompt).toContain(
			'KNOWLEDGE_N_A:<trace_id>:<entry_id>',
		);
	});
});
