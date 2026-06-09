import { describe, expect, test } from 'bun:test';

import { makeWorktreeBranchName } from '../../../src/worktree';

describe('shared worktree branch naming', () => {
	test('uses generalized purpose-prefixed branch names by default', () => {
		expect(
			makeWorktreeBranchName('parent-session', '1.1', { purpose: 'lane' }),
		).toBe('swarm/lane/parent-session/1.1');
	});

	test('preserves Lean Turbo legacy lane branch names for existing callers', () => {
		expect(
			makeWorktreeBranchName('parent-session', 'lane-a', {
				purpose: 'lane',
				branchStyle: 'legacy-lane',
			}),
		).toBe('swarm-lane/parent-session/lane-a');
	});
});
