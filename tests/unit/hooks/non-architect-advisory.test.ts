import { afterEach, describe, expect, test } from 'bun:test';
import {
	maybeEmitNonArchitectAdvisory,
	NON_ARCHITECT_ADVISORY_KEY,
} from '../../../src/hooks/non-architect-advisory';
import { resetSwarmState, swarmState } from '../../../src/state';

/**
 * Issue #2493 (K3 UX-3): the one-time in-session advisory for non-architect
 * sessions. "Session starts on a non-architect agent" is operationalized as
 * the first user message observed on a non-architect agent (no session-start
 * hook exists in the OpenCode plugin v1 shape).
 */
describe('non-architect advisory (issue #2493)', () => {
	afterEach(() => {
		resetSwarmState();
	});

	test('fires once per session on a non-architect agent, then never again', () => {
		const first = maybeEmitNonArchitectAdvisory('sess-a', 'general');
		expect(first).toBe(true);

		const session = swarmState.agentSessions.get('sess-a');
		expect(session?.nonArchitectAdvisoryDone).toBe(true);
		expect(session?.pendingAdvisoryMessages?.length).toBe(1);
		expect(session?.pendingAdvisoryMessages?.[0]).toContain(
			NON_ARCHITECT_ADVISORY_KEY,
		);

		const second = maybeEmitNonArchitectAdvisory('sess-a', 'general');
		expect(second).toBe(false);
		expect(session?.pendingAdvisoryMessages?.length).toBe(1);
	});

	test('a different session fires its own advisory (session-keyed, not global)', () => {
		expect(maybeEmitNonArchitectAdvisory('sess-b', 'build')).toBe(true);
		expect(maybeEmitNonArchitectAdvisory('sess-c', 'general')).toBe(true);
		expect(
			swarmState.agentSessions.get('sess-b')?.pendingAdvisoryMessages?.length,
		).toBe(1);
		expect(
			swarmState.agentSessions.get('sess-c')?.pendingAdvisoryMessages?.length,
		).toBe(1);
	});

	test('architect agents (including swarm-prefixed) never fire', () => {
		expect(maybeEmitNonArchitectAdvisory('sess-d', 'architect')).toBe(false);
		expect(maybeEmitNonArchitectAdvisory('sess-e', 'mega_architect')).toBe(
			false,
		);
		expect(swarmState.agentSessions.get('sess-d')).toBeUndefined();
		expect(swarmState.agentSessions.get('sess-e')).toBeUndefined();
	});

	test('host-internal agents never fire', () => {
		for (const internal of ['compaction', 'title', 'summary']) {
			expect(maybeEmitNonArchitectAdvisory(`sess-${internal}`, internal)).toBe(
				false,
			);
			expect(swarmState.agentSessions.get(`sess-${internal}`)).toBeUndefined();
		}
	});

	test('empty agent name or sessionID is a no-op (defensive guard)', () => {
		expect(maybeEmitNonArchitectAdvisory('sess-f', '')).toBe(false);
		expect(maybeEmitNonArchitectAdvisory('sess-f', '   ')).toBe(false);
		expect(maybeEmitNonArchitectAdvisory('', 'general')).toBe(false);
	});
});
