import { describe, expect, it } from 'bun:test';
import { createCoderAgent } from '../../../src/agents/coder';
import { createReviewerAgent } from '../../../src/agents/reviewer';
import { createTestEngineerAgent } from '../../../src/agents/test-engineer';

describe('knowledge receipt prompt alignment', () => {
	it('work agents tell recall users to file knowledge_receipt audit events', () => {
		const prompts = [
			createCoderAgent('test-model').config.prompt ?? '',
			createReviewerAgent('test-model').config.prompt ?? '',
			createTestEngineerAgent('test-model').config.prompt ?? '',
		];

		for (const prompt of prompts) {
			expect(prompt).toContain('## KNOWLEDGE RECEIPTS');
			expect(prompt).toContain('knowledge_recall');
			expect(prompt).toContain('knowledge_receipt');
			expect(prompt).toContain('no_relevant_knowledge:true');
		}
	});
});
