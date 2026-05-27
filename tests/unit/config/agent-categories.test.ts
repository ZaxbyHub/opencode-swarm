import { describe, expect, test } from 'bun:test';
import {
	AGENT_CATEGORY,
	type AgentCategory,
	getAgentCategory,
} from '../../../src/config/agent-categories.ts';

describe('agent-categories', () => {
	describe('AgentCategory type', () => {
		test('category values are limited to the 4 expected values', () => {
			const validCategories: AgentCategory[] = [
				'orchestrator',
				'pipeline',
				'qa',
				'support',
			];
			const allCategories = Object.values(AGENT_CATEGORY);
			for (const category of allCategories) {
				expect(validCategories).toContain(category);
			}
		});
	});

	describe('AGENT_CATEGORY map', () => {
		test('has exactly 13 entries', () => {
			// v6.36.0: added critic_drift_verifier; v6.73.0: added critic_hallucination_verifier; #893: added critic_architecture_supervisor
			const entries = Object.entries(AGENT_CATEGORY);
			expect(entries).toHaveLength(13);
		});

		test('architect maps to orchestrator', () => {
			expect(AGENT_CATEGORY['architect']).toBe('orchestrator');
		});

		test('explorer maps to pipeline', () => {
			expect(AGENT_CATEGORY['explorer']).toBe('pipeline');
		});

		test('coder maps to pipeline', () => {
			expect(AGENT_CATEGORY['coder']).toBe('pipeline');
		});

		test('test_engineer maps to pipeline', () => {
			expect(AGENT_CATEGORY['test_engineer']).toBe('pipeline');
		});

		test('reviewer maps to qa', () => {
			expect(AGENT_CATEGORY['reviewer']).toBe('qa');
		});

		test('critic maps to qa', () => {
			expect(AGENT_CATEGORY['critic']).toBe('qa');
		});

		test('critic_sounding_board maps to qa', () => {
			expect(AGENT_CATEGORY['critic_sounding_board']).toBe('qa');
		});

		test('critic_drift_verifier maps to qa', () => {
			expect(AGENT_CATEGORY['critic_drift_verifier']).toBe('qa');
		});

		test('critic_hallucination_verifier maps to qa', () => {
			expect(AGENT_CATEGORY['critic_hallucination_verifier']).toBe('qa');
		});

		test('sme maps to support', () => {
			expect(AGENT_CATEGORY['sme']).toBe('support');
		});

		test('docs maps to support', () => {
			expect(AGENT_CATEGORY['docs']).toBe('support');
		});

		test('designer maps to support', () => {
			expect(AGENT_CATEGORY['designer']).toBe('support');
		});
	});

	describe('getAgentCategory', () => {
		test('returns orchestrator for architect', () => {
			const result = getAgentCategory('architect');
			expect(result).toBe('orchestrator');
		});

		test('returns pipeline for explorer', () => {
			const result = getAgentCategory('explorer');
			expect(result).toBe('pipeline');
		});

		test('returns pipeline for coder', () => {
			const result = getAgentCategory('coder');
			expect(result).toBe('pipeline');
		});

		test('returns pipeline for test_engineer', () => {
			const result = getAgentCategory('test_engineer');
			expect(result).toBe('pipeline');
		});

		test('returns qa for reviewer', () => {
			const result = getAgentCategory('reviewer');
			expect(result).toBe('qa');
		});

		test('returns qa for critic', () => {
			const result = getAgentCategory('critic');
			expect(result).toBe('qa');
		});

		test('returns qa for critic_sounding_board', () => {
			const result = getAgentCategory('critic_sounding_board');
			expect(result).toBe('qa');
		});

		test('returns qa for critic_drift_verifier', () => {
			const result = getAgentCategory('critic_drift_verifier');
			expect(result).toBe('qa');
		});

		test('returns qa for critic_hallucination_verifier', () => {
			const result = getAgentCategory('critic_hallucination_verifier');
			expect(result).toBe('qa');
		});

		test('returns support for sme', () => {
			const result = getAgentCategory('sme');
			expect(result).toBe('support');
		});

		test('returns support for docs', () => {
			const result = getAgentCategory('docs');
			expect(result).toBe('support');
		});

		test('returns support for designer', () => {
			const result = getAgentCategory('designer');
			expect(result).toBe('support');
		});

		test('returns undefined for unknown agent', () => {
			const result = getAgentCategory('unknown_agent');
			expect(result).toBeUndefined();
		});

		test('returns undefined for empty string', () => {
			const result = getAgentCategory('');
			expect(result).toBeUndefined();
		});

		test('returns undefined for random string', () => {
			const result = getAgentCategory('foobar');
			expect(result).toBeUndefined();
		});
	});
});
