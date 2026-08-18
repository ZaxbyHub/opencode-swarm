/**
 * Regression tests: session-keyed satellite maps (activeAgent,
 * delegationChains) must be evicted with the same lifecycle as their
 * agentSessions entry.
 *
 * Prior behavior under test:
 *  - sweepStaleSessions deleted agentSessions + delegationChains but NOT
 *    activeAgent, so every evicted session left a permanent ghost entry that
 *    the snapshot writer re-serialized on every tool.execute.after (observed
 *    in production: 69 activeAgent entries vs 23 agentSessions).
 *  - endAgentSession deleted ONLY agentSessions, orphaning both satellite
 *    maps. Orphans are unreachable by any later sweep (the sweep iterates
 *    agentSessions, which no longer contains the id), so they persisted until
 *    process exit and into every snapshot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DelegationEntry } from '../../../src/state';
import {
	endAgentSession,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
	sweepStaleSessions,
} from '../../../src/state';
import { withFrozenClock } from '../../helpers/test-clock';

const NOW = 1_700_000_000_000;
const TTL_MS = 7_200_000; // matches STALE_SESSION_TTL_MS

function makeChain(): DelegationEntry[] {
	return [{ from: 'architect', to: 'coder', timestamp: NOW - 1 }];
}

beforeEach(() => {
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
});

describe('sweepStaleSessions — regression: activeAgent entries never evicted', () => {
	it('deletes the activeAgent entry of every evicted stale session', () => {
		// ensureAgentSession creates the session AND sets activeAgent.
		const stale = ensureAgentSession('stale-session', 'coder');
		ensureAgentSession('fresh-session', 'architect');
		swarmState.delegationChains.set('stale-session', makeChain());

		// Age only the stale session past the TTL.
		stale.lastToolCallTime = NOW - TTL_MS - 1;
		const fresh = swarmState.agentSessions.get('fresh-session');
		if (fresh) fresh.lastToolCallTime = NOW;

		const evicted = sweepStaleSessions(TTL_MS, NOW);

		expect(evicted).toEqual(['stale-session']);
		// Previous code deleted agentSessions + delegationChains here but left
		// activeAgent['stale-session'] behind forever.
		expect(swarmState.activeAgent.has('stale-session')).toBe(false);
		expect(swarmState.delegationChains.has('stale-session')).toBe(false);
		expect(swarmState.agentSessions.has('stale-session')).toBe(false);
	});

	it('preserves the activeAgent entry of sessions that are not stale', () => {
		const live = ensureAgentSession('live-session', 'reviewer');
		live.lastToolCallTime = NOW;

		sweepStaleSessions(TTL_MS, NOW);

		expect(swarmState.activeAgent.get('live-session')).toBe('reviewer');
		expect(swarmState.agentSessions.has('live-session')).toBe(true);
	});

	it('never evicts the activeAgent entry of a session refreshed on the hot path', () => {
		// ensureAgentSession refreshes lastToolCallTime before its opportunistic
		// sweep runs, so a session that is actively calling tools cannot become
		// its own eviction victim — and therefore cannot lose its activeAgent
		// entry mid-turn. ensureAgentSession reads Date.now() internally
		// (not clock-injectable), so the clock is frozen for determinism.
		withFrozenClock(
			() => {
				const session = ensureAgentSession('hot-session', 'coder');
				session.lastToolCallTime = NOW - TTL_MS - 1;

				// Re-entering via ensureAgentSession refreshes the timestamp first.
				ensureAgentSession('hot-session', 'coder');
				sweepStaleSessions(TTL_MS, NOW);

				expect(swarmState.activeAgent.get('hot-session')).toBe('coder');
				expect(swarmState.agentSessions.has('hot-session')).toBe(true);
			},
			{ fixedNow: NOW },
		);
	});
});

describe('endAgentSession — regression: satellite maps orphaned on session end', () => {
	it('deletes activeAgent and delegationChains along with the session', () => {
		ensureAgentSession('ending-session', 'coder');
		swarmState.delegationChains.set('ending-session', makeChain());

		endAgentSession('ending-session');

		expect(swarmState.agentSessions.has('ending-session')).toBe(false);
		// Previous code left both satellite entries behind: with the session
		// gone, sweepStaleSessions could never reach them again, so they
		// leaked until process exit and were written into every snapshot.
		expect(swarmState.activeAgent.has('ending-session')).toBe(false);
		expect(swarmState.delegationChains.has('ending-session')).toBe(false);
	});

	it('does not disturb other sessions when one ends', () => {
		ensureAgentSession('ending-session', 'coder');
		ensureAgentSession('other-session', 'architect');
		swarmState.delegationChains.set('other-session', makeChain());

		endAgentSession('ending-session');

		expect(swarmState.activeAgent.get('other-session')).toBe('architect');
		expect(swarmState.delegationChains.has('other-session')).toBe(true);
		expect(swarmState.agentSessions.has('other-session')).toBe(true);
	});

	it('is a safe no-op for an unknown session id', () => {
		ensureAgentSession('only-session', 'architect');

		expect(() => endAgentSession('never-existed')).not.toThrow();
		expect(swarmState.activeAgent.get('only-session')).toBe('architect');
	});
});
