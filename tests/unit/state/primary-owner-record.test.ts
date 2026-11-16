/**
 * Issue #3320 AC9 — new state surface `getPrimaryOwner` /
 * `isSwarmOwnedSession`. Expected ERROR at base (export absent), GREEN after
 * the fix.
 *
 * At the base commit `src/state.ts` does NOT export `getPrimaryOwner` or
 * `isSwarmOwnedSession` (they are added by the #3320 fix), so this file fails
 * at module resolution with
 * `SyntaxError: Export named 'getPrimaryOwner' not found in module
 * '<repo>/src/state.ts'.` — that import error IS the required base signature
 * of this NEW-SURFACE acceptance check. After the fix both exports exist and
 * the behavioral contract below must hold:
 *
 *  (a) `getPrimaryOwner(sessionID)` reports the last PRIMARY agent identity
 *      recorded for the session. PRIMARY identities are the swarm architect
 *      (plain or swarm-prefixed) and opencode native primary agents (build,
 *      plan, general); swarm SUBAGENTS (coder, reviewer, ...) are delegation
 *      workers and must never become the primary owner. Driving the real
 *      delegation tracker hook through 'architect' → 'build' → 'coder' must
 *      therefore report 'build' — the last PRIMARY agent — even though the
 *      live `swarmState.activeAgent` entry reads 'coder'.
 *  (b) `isSwarmOwnedSession(sessionID)` is FALSE when the session's resolved
 *      primary owner is a native agent ('build', 'plan', 'general') and TRUE
 *      when it is the swarm architect ('architect', 'mega_architect').
 *
 * Identity is recorded through the documented production path — the
 * `chat.message` delegation tracker hook (`src/hooks/delegation-tracker.ts`)
 * — not by hand-writing internal state, so the check exercises the recording
 * seam the fix actually feeds from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createDelegationTrackerHook } from '../../../src/hooks/delegation-tracker';
import * as swarmStateModule from '../../../src/state';
// NEW-SURFACE import (issue #3320 AC9): `getPrimaryOwner` is deliberately the
// ONLY static named import from src/state so the required base signature —
// the missing-export resolution error — names `getPrimaryOwner`, the primary
// new export under test. The remaining bindings are taken through a namespace
// destructure (property access, not link-time validation), which is inert at
// base (the file already failed at the import above) and exact after the fix.
import { getPrimaryOwner } from '../../../src/state';

const { isSwarmOwnedSession, resetSwarmState, swarmState } = swarmStateModule;

const trackerConfig: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

describe('primary-owner record and swarm-ownership predicate (#3320 AC9)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('getPrimaryOwner reports the last PRIMARY agent; a swarm subagent never becomes primary owner', async () => {
		const hook = createDelegationTrackerHook(trackerConfig);
		const sessionID = 'ac9-primary-owner-session';

		// Architect (PRIMARY) takes the session...
		await hook({ sessionID, agent: 'architect' }, {});
		// ...then the native 'build' agent (PRIMARY) takes over...
		await hook({ sessionID, agent: 'build' }, {});
		// ...then the swarm subagent 'coder' is delegated to (NOT primary).
		await hook({ sessionID, agent: 'coder' }, {});

		// The live identity is the subagent — the delegation tracker's contract.
		expect(swarmState.activeAgent.get(sessionID)).toBe('coder');
		// The primary OWNER is the last PRIMARY agent: 'build'. 'coder' is a
		// swarm subagent and must not have displaced it.
		expect(getPrimaryOwner(sessionID)).toBe('build');
	});

	it('isSwarmOwnedSession is false for native primary identities and true for architect identities', async () => {
		const hook = createDelegationTrackerHook(trackerConfig);

		// Native opencode primary agents on separate sessions: NOT swarm-owned.
		for (const nativeAgent of ['build', 'plan', 'general']) {
			const sessionID = `ac9-native-${nativeAgent}`;
			await hook({ sessionID, agent: nativeAgent }, {});
			expect(
				isSwarmOwnedSession(sessionID),
				`identity ${nativeAgent} must not be swarm-owned`,
			).toBe(false);
		}

		// Plain and swarm-prefixed architect identities: swarm-owned.
		for (const architectAgent of ['architect', 'mega_architect']) {
			const sessionID = `ac9-architect-${architectAgent}`;
			await hook({ sessionID, agent: architectAgent }, {});
			expect(
				isSwarmOwnedSession(sessionID),
				`identity ${architectAgent} must be swarm-owned`,
			).toBe(true);
		}
	});
});
