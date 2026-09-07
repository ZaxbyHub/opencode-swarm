import { describe, expect, test } from 'bun:test';
import { isSubagentDelegation } from '../../../src/full-auto/policy';

/**
 * Issue #2529 (critic round 2): the full-auto permission classifier receives
 * the RAW tool id, so isSubagentDelegation must not classify a dot-bearing
 * filesystem custom tool id (`notes.task`) as a subagent delegation via any
 * dot-stripping lookup, and the plain task id keeps its args requirement.
 */
describe('isSubagentDelegation task-id boundary (issue #2529)', () => {
	test('dotted custom tool ids are not subagent delegations', () => {
		expect(isSubagentDelegation('notes.task', { subagent_type: 'coder' })).toBe(
			false,
		);
		expect(isSubagentDelegation('my.tool.task', undefined)).toBe(false);
	});

	test('the task leg requires an args object', () => {
		expect(isSubagentDelegation('task', undefined)).toBe(false);
		expect(isSubagentDelegation('Task', undefined)).toBe(false);
		expect(isSubagentDelegation('task', { subagent_type: 'coder' })).toBe(true);
		expect(isSubagentDelegation('x:task', { prompt: 'hi' })).toBe(true);
	});

	test('agent and delegate remain unconditional', () => {
		expect(isSubagentDelegation('agent', undefined)).toBe(true);
		expect(isSubagentDelegation('delegate', undefined)).toBe(true);
	});
});
