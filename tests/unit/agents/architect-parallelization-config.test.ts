import { describe, expect, test } from 'bun:test';
import { createAgents } from '../../../src/agents';

function getArchitectPrompt(
	config?: Parameters<typeof createAgents>[0],
): string {
	const architect = createAgents(config).find(
		(agent) => agent.name === 'architect',
	);
	expect(architect).toBeDefined();
	return architect!.config.prompt ?? '';
}

describe('architect prompt — standard parallelization config', () => {
	test('disabled or absent config injects disabled non-Lean parallelization guidance', () => {
		const prompt = getArchitectPrompt();

		expect(prompt).toContain('## PARALLELIZATION CONFIG');
		expect(prompt).toContain('Global non-Lean parallelization is DISABLED');
		expect(prompt).toContain('Do not fan out independent coder tasks');
		expect(prompt).not.toContain('{{PARALLELIZATION_CONFIG}}');
	});

	test('enabled config injects bounded non-Lean parallel dispatch guidance', () => {
		const prompt = getArchitectPrompt({
			parallelization: {
				enabled: true,
				maxConcurrentTasks: 4,
				evidenceLockTimeoutMs: 60000,
				max_coders: 3,
				max_reviewers: 2,
			},
		});

		expect(prompt).toContain('Global non-Lean parallelization is ENABLED');
		expect(prompt).toContain('Max concurrent tasks: 4');
		expect(prompt).toContain('Max concurrent coder dispatches: 3');
		expect(prompt).toContain('Max concurrent Stage B gate groups: 2');
		expect(prompt).toContain('Do not require /swarm turbo lean');
		expect(prompt).toContain('dispatch up to 3 coder agents in one message');
		expect(prompt).toContain('dispatch all applicable Stage B gates');
		expect(prompt).toContain('conditional adversarial test_engineer');
		expect(prompt).toContain('run up to 2 independent Stage B gate groups');
	});

	test('enabled config clamps per-role guidance to maxConcurrentTasks', () => {
		const prompt = getArchitectPrompt({
			parallelization: {
				enabled: true,
				maxConcurrentTasks: 2,
				evidenceLockTimeoutMs: 60000,
				max_coders: 8,
				max_reviewers: 6,
			},
		});

		expect(prompt).toContain('Max concurrent coder dispatches: 2');
		expect(prompt).toContain('Max concurrent Stage B gate groups: 2');
	});
});
