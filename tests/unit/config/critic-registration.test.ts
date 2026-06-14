import { describe, expect, test } from 'bun:test';
import type { CriticRole } from '../../../src/agents/critic';
import {
	AGENT_TOOL_MAP,
	ALL_AGENT_NAMES,
	ALL_SUBAGENT_NAMES,
	DEFAULT_MODELS,
	QA_AGENTS,
} from '../../../src/config/constants';

describe('Critic Agent Registration', () => {
	describe('QA_AGENTS includes critic variants', () => {
		test('critic is in QA_AGENTS', () => {
			expect(QA_AGENTS).toContain('critic');
		});

		test('QA_AGENTS has exactly 3 members', () => {
			expect(QA_AGENTS).toHaveLength(3);
		});

		test('critic_oversight is in QA_AGENTS', () => {
			expect(QA_AGENTS).toContain('critic_oversight');
		});
	});

	describe('ALL_SUBAGENT_NAMES includes critic_sounding_board', () => {
		test('critic_sounding_board is in ALL_SUBAGENT_NAMES', () => {
			expect(ALL_SUBAGENT_NAMES).toContain('critic_sounding_board');
		});

		test('critic_sounding_board appears before QA_AGENTS spread', () => {
			const index = ALL_SUBAGENT_NAMES.indexOf('critic_sounding_board');
			const reviewerIndex = ALL_SUBAGENT_NAMES.indexOf('reviewer');
			expect(index).toBeLessThan(reviewerIndex);
		});
	});

	describe('ALL_AGENT_NAMES includes critic variants', () => {
		test('critic_sounding_board is in ALL_AGENT_NAMES', () => {
			expect(ALL_AGENT_NAMES).toContain('critic_sounding_board');
		});

		test('critic is in ALL_AGENT_NAMES', () => {
			expect(ALL_AGENT_NAMES).toContain('critic');
		});

		test('architect is first in ALL_AGENT_NAMES', () => {
			expect(ALL_AGENT_NAMES[0]).toBe('architect');
		});
	});

	describe('AGENT_TOOL_MAP has entries for critic variants', () => {
		test('critic has AGENT_TOOL_MAP entry', () => {
			expect(AGENT_TOOL_MAP).toHaveProperty('critic');
		});

		test('critic_sounding_board has AGENT_TOOL_MAP entry', () => {
			expect(AGENT_TOOL_MAP).toHaveProperty('critic_sounding_board');
		});
	});

	describe('Tool lists for critic vs critic_sounding_board — least-privilege divergence', () => {
		const criticTools = AGENT_TOOL_MAP.critic;
		const criticSoundingBoardTools = AGENT_TOOL_MAP.critic_sounding_board;

		test('critic has get_approved_plan (plan baseline retrieval for drift comparison)', () => {
			expect(criticTools).toContain('get_approved_plan');
		});

		test('critic_sounding_board does NOT have get_approved_plan (least-privilege — sounding_board is advisory only, not a baseline authority)', () => {
			expect(criticSoundingBoardTools).not.toContain('get_approved_plan');
		});

		test('critic and critic_sounding_board both have shared base tools', () => {
			expect(criticTools).toContain('complexity_hotspots');
			expect(criticSoundingBoardTools).toContain('complexity_hotspots');
			expect(criticTools).toContain('detect_domains');
			expect(criticSoundingBoardTools).toContain('detect_domains');
			expect(criticTools).toContain('imports');
			expect(criticSoundingBoardTools).toContain('imports');
			expect(criticTools).toContain('retrieve_summary');
			expect(criticSoundingBoardTools).toContain('retrieve_summary');
			expect(criticTools).toContain('symbols');
			expect(criticSoundingBoardTools).toContain('symbols');
			expect(criticTools).toContain('knowledge_recall');
			expect(criticSoundingBoardTools).toContain('knowledge_recall');
			expect(criticTools).toContain('req_coverage');
			expect(criticSoundingBoardTools).toContain('req_coverage');
			expect(criticTools).toContain('repo_map');
			expect(criticSoundingBoardTools).toContain('repo_map');
		});
	});

	describe('DEFAULT_MODELS has entries for critic variants', () => {
		test('critic_sounding_board has DEFAULT_MODELS entry', () => {
			expect(DEFAULT_MODELS).toHaveProperty('critic_sounding_board');
		});

		test('critic_sounding_board uses gpt-5-nano model', () => {
			expect(DEFAULT_MODELS.critic_sounding_board).toBe('opencode/gpt-5-nano');
		});
	});

	describe('CriticRole type is properly exported from critic module', () => {
		test('CriticRole type can be imported', () => {
			// This test verifies the import works - if it compiles, the type exists
			const role: CriticRole = 'plan_critic';
			expect(role).toBe('plan_critic');
		});

		test('CriticRole supports all three critic roles', () => {
			const planCritic: CriticRole = 'plan_critic';
			const soundingBoard: CriticRole = 'sounding_board';
			const phaseDriftVerifier: CriticRole = 'phase_drift_verifier';

			expect(planCritic).toBe('plan_critic');
			expect(soundingBoard).toBe('sounding_board');
			expect(phaseDriftVerifier).toBe('phase_drift_verifier');
		});
	});
});
