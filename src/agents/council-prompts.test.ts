/**
 * Tests for src/agents/council-prompts.ts.
 *
 * Covers prompt content (NSED protocol markers, hardcoded persona/memberId),
 * AGENT_TOOL_MAP enforcement (empty tool lists for the three council agents,
 * web_search shifted to architect), and protocol preservation across the
 * Round 1 → Round 2 deliberation flow.
 */

import { describe, expect, test } from 'bun:test';
import { AGENT_TOOL_MAP } from '../config/constants';
import {
	DOMAIN_EXPERT_COUNCIL_PROMPT,
	GENERALIST_COUNCIL_PROMPT,
	SKEPTIC_COUNCIL_PROMPT,
} from './council-prompts';

const PROMPTS = [
	{
		name: 'GENERALIST_COUNCIL_PROMPT',
		prompt: GENERALIST_COUNCIL_PROMPT,
		memberId: 'council_generalist',
		role: 'generalist',
		personaKeyword: 'GENERALIST',
	},
	{
		name: 'SKEPTIC_COUNCIL_PROMPT',
		prompt: SKEPTIC_COUNCIL_PROMPT,
		memberId: 'council_skeptic',
		role: 'skeptic',
		personaKeyword: 'SKEPTIC',
	},
	{
		name: 'DOMAIN_EXPERT_COUNCIL_PROMPT',
		prompt: DOMAIN_EXPERT_COUNCIL_PROMPT,
		memberId: 'council_domain_expert',
		role: 'domain_expert',
		personaKeyword: 'DOMAIN EXPERT',
	},
] as const;

describe('council-prompts: shape and identity', () => {
	for (const { name, prompt, memberId, role, personaKeyword } of PROMPTS) {
		test(`${name} is a non-empty string`, () => {
			expect(typeof prompt).toBe('string');
			expect(prompt.length).toBeGreaterThan(0);
		});

		test(`${name} contains the expected persona keyword`, () => {
			expect(prompt).toContain(personaKeyword);
		});

		test(`${name} hardcodes its memberId and role`, () => {
			expect(prompt).toContain(`Member ID: "${memberId}"`);
			expect(prompt).toContain(`Role: "${role}"`);
		});
	}
});

describe('council-prompts: protocol preservation', () => {
	for (const { name, prompt } of PROMPTS) {
		test(`${name} preserves the Round 2 MAINTAIN/CONCEDE/NUANCE keywords`, () => {
			expect(prompt).toContain('MAINTAIN');
			expect(prompt).toContain('CONCEDE');
			expect(prompt).toContain('NUANCE');
		});

		test(`${name} preserves the JSON response format structure`, () => {
			expect(prompt).toContain('"memberId"');
			expect(prompt).toContain('"role"');
			expect(prompt).toContain('"confidence"');
			expect(prompt).toContain('"areasOfUncertainty"');
			expect(prompt).toContain('"sources"');
		});

		test(`${name} cites NSED arXiv:2601.16863`, () => {
			expect(prompt).toContain('NSED arXiv:2601.16863');
		});
	}
});

describe('council-prompts: web search ownership shifted to architect', () => {
	for (const { name, prompt } of PROMPTS) {
		test(`${name} does NOT instruct the agent to call web_search`, () => {
			expect(prompt).not.toContain('web_search');
		});

		test(`${name} instructs the agent to use the RESEARCH CONTEXT block`, () => {
			expect(prompt).toContain('RESEARCH CONTEXT');
		});

		test(`${name} declares the agent has no tools`, () => {
			expect(prompt).toContain('You have no tools.');
		});
	}
});

describe('AGENT_TOOL_MAP enforcement', () => {
	test('council_generalist has an empty tool list (synthesis only)', () => {
		expect(AGENT_TOOL_MAP.council_generalist).toEqual([]);
	});

	test('council_skeptic has an empty tool list (synthesis only)', () => {
		expect(AGENT_TOOL_MAP.council_skeptic).toEqual([]);
	});

	test('council_domain_expert has an empty tool list (synthesis only)', () => {
		expect(AGENT_TOOL_MAP.council_domain_expert).toEqual([]);
	});

	test('web_search is in architect (research phase ownership)', () => {
		expect(AGENT_TOOL_MAP.architect).toContain('web_search');
	});

	test('web_search is NOT in any council agent', () => {
		expect(AGENT_TOOL_MAP.council_generalist).not.toContain('web_search');
		expect(AGENT_TOOL_MAP.council_skeptic).not.toContain('web_search');
		expect(AGENT_TOOL_MAP.council_domain_expert).not.toContain('web_search');
	});

	test('convene_general_council is in architect', () => {
		expect(AGENT_TOOL_MAP.architect).toContain('convene_general_council');
	});

	test('convene_general_council is NOT in any other agent', () => {
		const others = Object.keys(AGENT_TOOL_MAP).filter((a) => a !== 'architect');
		for (const a of others) {
			expect(AGENT_TOOL_MAP[a as keyof typeof AGENT_TOOL_MAP]).not.toContain(
				'convene_general_council',
			);
		}
	});
});
