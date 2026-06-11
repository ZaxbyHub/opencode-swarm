/**
 * Tests for the agent-classification predicates in knowledge-injector.ts
 * (Swarm Learning System, Change 1 / Task 1.1).
 *
 * `isOrchestratorAgent` must remain architect-only. `isDelegatedAgent` must
 * return true for exactly the eight delegated subagent roles and false for the
 * architect and any unrecognized name. Both must respect swarm-prefix stripping.
 */

import { describe, expect, it } from 'bun:test';
import {
	defaultExpectedToolsForAgent,
	isDelegatedAgent,
	isOrchestratorAgent,
	matchesDelegateScope,
} from '../../../src/hooks/knowledge-injector.js';

const DELEGATED = [
	'coder',
	'reviewer',
	'test_engineer',
	'sme',
	'docs',
	'designer',
	'critic',
	'curator',
] as const;

describe('isDelegatedAgent', () => {
	for (const agent of DELEGATED) {
		it(`returns true for delegated agent '${agent}'`, () => {
			expect(isDelegatedAgent(agent)).toBe(true);
		});
	}

	it('returns false for the architect (orchestrator, not delegate)', () => {
		expect(isDelegatedAgent('architect')).toBe(false);
	});

	for (const unknown of ['unknown', 'critic_sounding_board', '']) {
		it(`returns false for unrecognized agent '${unknown}'`, () => {
			expect(isDelegatedAgent(unknown)).toBe(false);
		});
	}

	it('strips swarm prefixes before matching', () => {
		expect(isDelegatedAgent('mega_coder')).toBe(true);
		expect(isDelegatedAgent('mega_architect')).toBe(false);
	});

	it('is case-insensitive', () => {
		expect(isDelegatedAgent('Coder')).toBe(true);
		expect(isDelegatedAgent('REVIEWER')).toBe(true);
	});
});

describe('isOrchestratorAgent', () => {
	it('returns true only for the architect', () => {
		expect(isOrchestratorAgent('architect')).toBe(true);
		expect(isOrchestratorAgent('mega_architect')).toBe(true);
		expect(isOrchestratorAgent('Architect')).toBe(true);
	});

	for (const agent of DELEGATED) {
		it(`returns false for delegated agent '${agent}'`, () => {
			expect(isOrchestratorAgent(agent)).toBe(false);
		});
	}

	it('returns false for unknown agents', () => {
		expect(isOrchestratorAgent('unknown')).toBe(false);
		expect(isOrchestratorAgent('')).toBe(false);
	});
});

describe('predicates are mutually exclusive', () => {
	for (const agent of [...DELEGATED, 'architect', 'unknown']) {
		it(`'${agent}' is not classified as both delegate and orchestrator`, () => {
			expect(isDelegatedAgent(agent) && isOrchestratorAgent(agent)).toBe(false);
		});
	}
});

describe('defaultExpectedToolsForAgent', () => {
	it('returns the coder write toolset', () => {
		expect(defaultExpectedToolsForAgent('coder')).toEqual([
			'edit',
			'write',
			'patch',
			'bash',
		]);
	});

	it('returns the reviewer read toolset', () => {
		expect(defaultExpectedToolsForAgent('reviewer')).toEqual([
			'read',
			'grep',
			'glob',
		]);
	});

	it('strips prefixes', () => {
		expect(defaultExpectedToolsForAgent('mega_coder')).toEqual([
			'edit',
			'write',
			'patch',
			'bash',
		]);
	});

	it('returns an empty list for unknown agents', () => {
		expect(defaultExpectedToolsForAgent('unknown')).toEqual([]);
	});
});

describe('matchesDelegateScope', () => {
	it('includes untargeted directives (no agent + no tool scope)', () => {
		expect(matchesDelegateScope({}, 'coder', ['edit'])).toBe(true);
		expect(
			matchesDelegateScope(
				{ applies_to_agents: [], applies_to_tools: [] },
				'coder',
				['edit'],
			),
		).toBe(true);
	});

	it('includes directives scoped to the agent role', () => {
		expect(
			matchesDelegateScope({ applies_to_agents: ['coder'] }, 'coder', []),
		).toBe(true);
	});

	it('includes directives scoped to an expected tool', () => {
		expect(
			matchesDelegateScope({ applies_to_tools: ['edit'] }, 'coder', [
				'edit',
				'write',
			]),
		).toBe(true);
	});

	it('matches on tool scope even when agent scope targets a different role', () => {
		// reviewer-scoped by agent, but edit-scoped by tool → coder using edit sees it
		expect(
			matchesDelegateScope(
				{ applies_to_agents: ['reviewer'], applies_to_tools: ['edit'] },
				'coder',
				['edit'],
			),
		).toBe(true);
	});

	it('excludes directives targeted at a different agent with no matching tool', () => {
		expect(
			matchesDelegateScope({ applies_to_agents: ['reviewer'] }, 'coder', [
				'edit',
			]),
		).toBe(false);
	});

	it('excludes directives whose tool scope does not intersect expected tools', () => {
		expect(
			matchesDelegateScope({ applies_to_tools: ['read'] }, 'coder', [
				'edit',
				'write',
			]),
		).toBe(false);
	});

	it('strips swarm prefixes on both sides', () => {
		expect(
			matchesDelegateScope({ applies_to_agents: ['mega_coder'] }, 'coder', []),
		).toBe(true);
	});
});
