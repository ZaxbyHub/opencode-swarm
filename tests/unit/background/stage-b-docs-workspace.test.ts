import { describe, expect, test } from 'bun:test';
import type {
	BackgroundDelegationRecord,
	BackgroundWorkspaceSnapshot,
} from '../../../src/background/pending-delegations';
import { compareStageBWorkspace } from '../../../src/background/stage-b-gates';

function snapshot(
	overrides: Partial<BackgroundWorkspaceSnapshot> = {},
): BackgroundWorkspaceSnapshot {
	return {
		directory: '/project',
		gitHead: 'head-a',
		dirtyHash: 'dirty-a',
		prHeadSha: 'pr-a',
		scope: null,
		...overrides,
	};
}

function record(role: string): BackgroundDelegationRecord {
	return {
		schemaVersion: 3,
		correlationId: 'child',
		jobId: 'job',
		subagentSessionId: 'child',
		parentSessionId: 'parent',
		callID: 'call',
		normalizedAgent: role,
		swarmPrefixedAgent: role,
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		status: 'completed',
		createdAt: 1,
		updatedAt: 1,
		workspace: snapshot(),
	};
}

describe('background docs workspace freshness', () => {
	test('allows docs to change the dirty tree they were dispatched to author', () => {
		expect(
			compareStageBWorkspace(
				record('docs'),
				snapshot({ dirtyHash: 'dirty-after-docs' }),
			),
		).toEqual({ stale: false });
	});

	test('keeps non-authoring gate roles bound to the exact dirty tree', () => {
		expect(
			compareStageBWorkspace(
				record('reviewer'),
				snapshot({ dirtyHash: 'dirty-after-change' }),
			).stale,
		).toBe(true);
	});

	test('still rejects docs completion after repository identity changes', () => {
		expect(
			compareStageBWorkspace(record('docs'), snapshot({ gitHead: 'head-b' }))
				.stale,
		).toBe(true);
		expect(
			compareStageBWorkspace(
				record('docs'),
				snapshot({ directory: '/other-project' }),
			).stale,
		).toBe(true);
	});
});
