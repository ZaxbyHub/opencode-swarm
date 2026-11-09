/**
 * #3372 AC1 — instruction-selection pairing must not overwrite a recorded
 * session owner's live identity.
 *
 * Defect (src/memory/instruction-pairing.ts makeMessages): the measurement
 * harness stamps `swarmState.activeAgent.set(sessionId, 'architect')`
 * UNCONDITIONALLY while composing its synthetic host input. For a session
 * whose recorded PRIMARY owner (#3320 owner map) is a non-architect primary
 * such as 'build' or 'plan', that stamp overwrites the live identity map
 * entry DURING the pairing run (the finally block deletes the entry again
 * post-run, so the during-run value is the only directly observable stamp).
 *
 * Observation seam: `makeMessages` is module-private. Following the repo DI
 * seam convention (cf. `src/utils/gitignore-warning.ts:_internals`), the fix
 * is expected to expose it as `_internals.makeMessages`. The seam is loaded
 * through a dynamic import + runtime shape check so that, at base (no seam
 * yet), ONLY the seam-dependent tests fail with a descriptive error while the
 * seam-free end-to-end leg still runs and records its base status. This is a
 * deliberate per-test RED instead of a whole-file module-load ERROR.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	type InstructionPairingTask,
	runInstructionSelectionPairing,
} from '../../../src/memory/instruction-pairing.js';
import {
	getPrimaryOwner,
	recordPrimaryOwner,
	swarmState,
} from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Shape of the sanctioned `_internals` DI seam (see file header). */
interface PairingInternals {
	makeMessages: (sessionId: string) => {
		messages: Array<{ info?: { sessionID?: string } }>;
	};
}

const SEAM_BUILD_SID = 'pairing-identity-seam-build';
const SEAM_PLAN_SID = 'pairing-identity-seam-plan';
const SEAM_OWNERLESS_SID = 'pairing-identity-seam-ownerless';
const E2E_TASK_ID = 'identity-e2e';
const E2E_SID = `pairing-${E2E_TASK_ID}`;

/**
 * Loads `_internals` from the real module. Throws a descriptive error (a
 * per-test failure, not a module-load error) when the seam is absent at base.
 */
async function loadPairingInternals(): Promise<PairingInternals> {
	const mod = (await import('../../../src/memory/instruction-pairing.js')) as {
		_internals?: PairingInternals;
	};
	const internals = mod._internals;
	if (!internals || typeof internals.makeMessages !== 'function') {
		throw new Error(
			'#3372 seam missing: src/memory/instruction-pairing.ts exports no ' +
				'`_internals.makeMessages`. The during-run identity stamp is ' +
				'module-private; this check observes it through the repo DI-seam ' +
				'convention (cf. src/utils/gitignore-warning.ts `_internals`). ' +
				'Expected shape: `export const _internals = { makeMessages };`',
		);
	}
	return internals;
}

afterEach(() => {
	// Invariant-8 hygiene: never leave synthetic pairing sessions mapped.
	for (const sid of [
		SEAM_BUILD_SID,
		SEAM_PLAN_SID,
		SEAM_OWNERLESS_SID,
		E2E_SID,
	]) {
		swarmState.activeAgent.delete(sid);
		swarmState.primaryOwnerBySession.delete(sid);
	}
});

describe('instruction-pairing session identity (#3372 AC1)', () => {
	it('keeps a recorded "build" owner untouched while composing measurement messages', async () => {
		const internals = await loadPairingInternals();
		recordPrimaryOwner(SEAM_BUILD_SID, 'build');
		swarmState.activeAgent.set(SEAM_BUILD_SID, 'build');

		const output = internals.makeMessages(SEAM_BUILD_SID);

		// The seam must be the real harness input composer: a user message
		// carrying the synthetic session id.
		expect(output.messages.length).toBeGreaterThan(0);
		expect(output.messages[0].info?.sessionID).toBe(SEAM_BUILD_SID);
		// DISCRIMINATING: base stamps 'architect' here, clobbering the live
		// identity entry of a session whose recorded primary owner is 'build'.
		expect(swarmState.activeAgent.get(SEAM_BUILD_SID)).toBe('build');
		expect(getPrimaryOwner(SEAM_BUILD_SID)).toBe('build');
		// agentSessions.agentName unchanged: the synthetic session must not
		// gain an agentSessions entry either.
		expect(swarmState.agentSessions.has(SEAM_BUILD_SID)).toBe(false);
	});

	it('keeps a recorded "plan" owner untouched while composing measurement messages', async () => {
		const internals = await loadPairingInternals();
		recordPrimaryOwner(SEAM_PLAN_SID, 'plan');
		swarmState.activeAgent.set(SEAM_PLAN_SID, 'plan');

		internals.makeMessages(SEAM_PLAN_SID);

		// DISCRIMINATING: same contract for the 'plan' owner named by the AC.
		expect(swarmState.activeAgent.get(SEAM_PLAN_SID)).toBe('plan');
		expect(getPrimaryOwner(SEAM_PLAN_SID)).toBe('plan');
		expect(swarmState.agentSessions.has(SEAM_PLAN_SID)).toBe(false);
	});

	it('still stamps architect for the harness own synthetic ownerless sessions', async () => {
		const internals = await loadPairingInternals();
		expect(getPrimaryOwner(SEAM_OWNERLESS_SID)).toBeUndefined();
		expect(swarmState.activeAgent.has(SEAM_OWNERLESS_SID)).toBe(false);

		internals.makeMessages(SEAM_OWNERLESS_SID);

		// PRESERVING: the knowledge-injector hook resolves the agent through
		// swarmState.activeAgent, so the measurement harness must keep
		// stamping its own synthetic sessions (no owner record) as architect —
		// otherwise every pairing arm measures an empty injection.
		expect(swarmState.activeAgent.get(SEAM_OWNERLESS_SID)).toBe('architect');
	});

	it('end-to-end pairing run neither demotes a pre-seeded build owner nor leaves activeAgent residue', async () => {
		const dir = canonicalMkdtemp('pairing-identity-3372-');
		try {
			const task: InstructionPairingTask = {
				id: E2E_TASK_ID,
				lastUserMessage: 'Continue the current work.',
				expectedLabels: [],
				records: [],
			};
			recordPrimaryOwner(E2E_SID, 'build');

			const report = await runInstructionSelectionPairing({
				directory: dir,
				tasks: [task],
			});

			expect(report.pairs).toHaveLength(1);
			// PRESERVING at base and after the fix: the owner record survives
			// the run …
			expect(getPrimaryOwner(E2E_SID)).toBe('build');
			// … and the finally-block hygiene still removes the synthetic
			// session's activeAgent entry (no cross-run residue).
			expect(swarmState.activeAgent.has(E2E_SID)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
