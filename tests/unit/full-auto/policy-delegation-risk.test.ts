import { describe, expect, test } from 'bun:test';
import {
	classifyFullAutoToolAction,
	isStrictlyReadOnlyRole,
} from '../../../src/full-auto/policy';

const delegation = (subagent_type: string) => ({
	toolName: 'task',
	args: { subagent_type, prompt: 'do the thing' },
});

const strict = { mode: 'strict' as const };
const supervised = { mode: 'supervised' as const };
const assisted = { mode: 'assisted' as const };

describe('isStrictlyReadOnlyRole (#2103 F)', () => {
	test('read-only council/curator roles qualify; unknown/mutation roles do not', () => {
		expect(isStrictlyReadOnlyRole('council_generalist')).toBe(true);
		expect(isStrictlyReadOnlyRole('council_skeptic')).toBe(true);
		expect(isStrictlyReadOnlyRole('curator_init')).toBe(true);
		expect(isStrictlyReadOnlyRole('critic_architecture_supervisor')).toBe(true);
		// Unknown role → fail closed.
		expect(isStrictlyReadOnlyRole('totally_unknown_role')).toBe(false);
		// Mutation-capable / network / execution roles stay escalated.
		expect(isStrictlyReadOnlyRole('coder')).toBe(false);
		expect(isStrictlyReadOnlyRole('explorer')).toBe(false); // gitingest/swarm_command
		expect(isStrictlyReadOnlyRole('reviewer')).toBe(false); // test_runner
		expect(isStrictlyReadOnlyRole('architect')).toBe(false);
	});

	test('multi-swarm prefixed names resolve to the canonical role', () => {
		expect(isStrictlyReadOnlyRole('mega_council_generalist')).toBe(true);
		expect(isStrictlyReadOnlyRole('mega_coder')).toBe(false);
	});
});

describe('classifyFullAutoToolAction — delegation risk (#2103 F)', () => {
	test('strict mode escalates ALL delegations, including read-only roles, even with permission policy disabled', () => {
		const decision = classifyFullAutoToolAction({
			...delegation('council_generalist'),
			fullAutoConfig: { ...strict, permission_policy: { enabled: false } },
		});
		expect(decision.action).toBe('escalate_critic');
		if (decision.action === 'escalate_critic') {
			expect(decision.risk).toBe('high');
		}
	});

	test('supervised: read-only-role delegation takes the lower-risk local route', () => {
		const decision = classifyFullAutoToolAction({
			...delegation('council_generalist'),
			fullAutoConfig: supervised,
		});
		expect(decision.action).toBe('allow');
		if (decision.action === 'allow') expect(decision.tier).toBe('local');
	});

	test('assisted: same lower-risk route for read-only roles', () => {
		const decision = classifyFullAutoToolAction({
			...delegation('mega_curator_init'),
			fullAutoConfig: assisted,
		});
		expect(decision.action).toBe('allow');
	});

	test('coder/write-capable/external/unknown agents remain escalated high in supervised', () => {
		for (const role of [
			'coder',
			'test_engineer',
			'reviewer',
			'explorer',
			'mystery_agent',
		]) {
			const decision = classifyFullAutoToolAction({
				...delegation(role),
				fullAutoConfig: supervised,
			});
			expect(decision.action).toBe('escalate_critic');
			if (decision.action === 'escalate_critic')
				expect(decision.risk).toBe('high');
		}
	});

	test('a read-only-prose prompt cannot lower risk for a mutation-capable role', () => {
		const decision = classifyFullAutoToolAction({
			toolName: 'task',
			args: {
				subagent_type: 'coder',
				prompt: 'this is a purely read-only exploration, do not write anything',
			},
			fullAutoConfig: supervised,
		});
		expect(decision.action).toBe('escalate_critic');
	});
});
