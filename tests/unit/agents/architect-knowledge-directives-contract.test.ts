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

	it('requires KNOWLEDGE_APPLIED / IGNORED / VIOLATED markers', () => {
		expect(prompt).toContain('KNOWLEDGE_APPLIED');
		expect(prompt).toContain('KNOWLEDGE_IGNORED');
		expect(prompt).toContain('KNOWLEDGE_VIOLATED');
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
