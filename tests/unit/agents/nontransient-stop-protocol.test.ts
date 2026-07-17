import { describe, expect, it } from 'bun:test';
import { createAgents } from '../../../src/agents';

describe('agent prompts — regression: issue #1875 non-transient STOP protocol', () => {
	it('injects the shared protocol into every generated agent prompt', () => {
		const agents = createAgents();
		expect(agents.length).toBeGreaterThan(0);

		for (const agent of agents) {
			const prompt = agent.config.prompt ?? '';
			expect(prompt).toContain('NON-TRANSIENT TOOL FAILURE PROTOCOL');
			expect(prompt).toContain('ParserError');
			expect(prompt).toContain('MissingEndCurlyBrace');
			expect(prompt).toContain('CommandNotFoundException');
			expect(prompt).toContain('[sandbox] BLOCKED');
			expect(prompt).toContain('NON-TRANSIENT CIRCUIT BREAKER');
			expect(prompt).toContain('third same-category permanent failure');
			expect(prompt).toContain('STOP. Do not retry');
		}
	});
});
