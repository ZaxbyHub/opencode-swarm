import { describe, expect, it } from 'bun:test';
import { createAgents } from '../../../src/agents';

function coderPrompt(): string {
	const coder = createAgents().find((agent) => agent.name === 'coder');
	expect(coder).toBeDefined();
	return coder?.config.prompt ?? '';
}

describe('coder prompt strict write-scope contract', () => {
	it('documents preflight failures and fail-closed write behavior', () => {
		const prompt = coderPrompt();

		expect(prompt).toContain(
			'Every coder Task call must pass controller preflight',
		);
		expect(prompt).toContain('exactly one current plan task');
		expect(prompt).toContain('SCOPE_NOT_DECLARED');
		expect(prompt).toContain('SCOPE_CONFLICT');
		expect(prompt).toContain('all writes fail closed');
		expect(prompt).toContain('write around a scope failure');
		expect(prompt).toContain('including shell and interpreter commands');
		expect(prompt).toContain('Unverifiable write payloads fail closed');
		expect(prompt).not.toContain('Bash and interpreter eval are unguarded');
	});

	it('documents precedence, subset checks, and the sole-source FILE fallback', () => {
		const prompt = coderPrompt();

		expect(prompt).toContain(
			"strict: matching declare_scope binding (explicit) > the resolved plan task's files_touched (plan) > FILE: directives",
		);
		expect(prompt).toContain(
			'A lower-precedence source may narrow the authoritative scope but must never widen it',
		);
		expect(prompt).toContain(
			'FILE: directives are the sole-source fallback only when both explicit and plan scopes are absent',
		);
		expect(prompt).toContain(
			'exactly one non-empty project-relative path per FILE: line',
		);
	});

	it('documents full invocation identity and worktree child derivation', () => {
		const prompt = coderPrompt();

		expect(prompt).toContain('canonical workspace');
		expect(prompt).toContain('current plan ID and structure');
		expect(prompt).toContain('exact task, parent session, and exact Task call');
		expect(prompt).toContain('derived child-root binding');
		expect(prompt).toContain(
			'Root-workspace authority is not directly reusable',
		);
		expect(prompt).toContain('sibling worktree');
	});
});
