/**
 * Verifies that the architect prompt contains the v2 knowledge-directive
 * acknowledgment contract introduced for issue #629.
 */

import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';

describe('architect prompt: knowledge directive contract', () => {
	const agent = createArchitectAgent('opencode/big-pickle');
	const prompt = agent.config.prompt!;

	it('mentions the swarm_knowledge_directives block', () => {
		expect(prompt).toContain('<swarm_knowledge_directives>');
	});

	it('requires KNOWLEDGE_APPLIED / N_A / IGNORED / CONTRADICTED / VIOLATED markers', () => {
		expect(prompt).toContain('KNOWLEDGE_APPLIED');
		expect(prompt).toContain('KNOWLEDGE_N_A');
		expect(prompt).toContain('KNOWLEDGE_IGNORED');
		expect(prompt).toContain('KNOWLEDGE_CONTRADICTED');
		expect(prompt).toContain('KNOWLEDGE_VIOLATED');
	});

	it('regression: steers non-applicable directives to reasoned N_A, not IGNORED (#2032)', () => {
		// Previous behavior: the prompt told the architect to record
		// KNOWLEDGE_IGNORED when a directive "does NOT apply", but ignored is a
		// NEGATIVE outcome signal — routine irrelevance damaged ranking and
		// curation. Anchor to the directives section, not the whole prompt.
		const sectionStart = prompt.indexOf(
			'SWARM KNOWLEDGE DIRECTIVES (v2 acknowledgment contract',
		);
		expect(sectionStart).toBeGreaterThanOrEqual(0);
		const sectionEnd = prompt.indexOf('SKILL IMPROVER', sectionStart);
		const section = prompt.slice(
			sectionStart,
			sectionEnd > sectionStart ? sectionEnd : undefined,
		);
		// The not-applicable bullet names KNOWLEDGE_N_A ...
		expect(section).toMatch(
			/does NOT apply[^]*?KNOWLEDGE_N_A:<trace_id>:<entry_id> reason=<short reason>/,
		);
		// ... and IGNORED is explicitly reserved for deliberate non-compliance.
		expect(section).toMatch(
			/deliberately chose not to follow[^]*?reserve it for deliberate non-compliance, never for mere irrelevance/,
		);
		// The sole-mechanism enumeration includes N_A.
		expect(prompt).toContain(
			'Chat-text markers (KNOWLEDGE_APPLIED/IGNORED/N_A/CONTRADICTED/VIOLATED)',
		);
	});

	it('explicitly forbids silently ignoring critical directives', () => {
		expect(prompt).toMatch(/never silently ignore .* critical/i);
	});

	it('mentions skill_improve and require_user_approval', () => {
		expect(prompt).toContain('skill_improve');
		expect(prompt).toMatch(/require_user_approval|ask the user/i);
	});

	it('mentions delegating spec authoring to spec_writer', () => {
		expect(prompt).toContain('spec_writer');
		expect(prompt).toContain('spec_write');
	});
});
