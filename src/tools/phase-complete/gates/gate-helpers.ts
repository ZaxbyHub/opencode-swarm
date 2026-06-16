/**
 * Shared preamble helpers for QA-gate modules.
 *
 * Multiple gates (mutation, hallucination, drift, phase-council, final-council)
 * repeat the same loadPlan → derivePlanId → getProfile → resolve session
 * overrides → getEffectiveGates sequence.  This module extracts that
 * preamble into a single reusable function so each gate only contains its
 * unique verdict logic.
 */

import type { RuntimePlan } from '../../../config/plan-schema';
import type { QaGates } from '../../../db/qa-gate-profile.js';
import { getEffectiveGates, getProfile } from '../../../db/qa-gate-profile.js';
import { loadPlan } from '../../../plan/manager';
import { derivePlanId } from '../../../plan/utils';
import { swarmState } from '../../../state';

/**
 * Result of resolving the shared QA-gate preamble.
 *
 * - `resolved === false`  → plan or profile could not be loaded.
 *                            Gates that default to *disabled* when the
 *                            preamble fails should return pass-through.
 * - `resolved === true`   → `plan`, `profile`, and `effectiveGates`
 *                            are all populated and the gate can inspect
 *                            the flag it cares about.
 */
export interface GatePreambleResult {
	resolved: boolean;
	plan?: RuntimePlan;
	effectiveGates?: QaGates;
}

/**
 * Load the plan, derive its identity, look up the QA-gate profile, resolve
 * any session-level overrides, and compute the effective gate flags.
 *
 * Returns `{ resolved: false }` for expected soft-failure cases (plan or
 * profile missing).  Unexpected errors (e.g. JSON parse errors, file
 * system errors) are allowed to propagate so that each gate's outer
 * catch block can report them with gate-specific diagnostics via
 * `safeWarn()`.
 */
export async function resolveGatePreamble(
	dir: string,
	sessionID: string | undefined,
): Promise<GatePreambleResult> {
	const plan = await loadPlan(dir);
	if (!plan) {
		return { resolved: false };
	}
	const planId = derivePlanId(plan);
	const profile = getProfile(dir, planId);
	if (!profile) {
		return { resolved: false, plan };
	}
	const session = sessionID
		? swarmState.agentSessions.get(sessionID)
		: undefined;
	const overrides = session?.qaGateSessionOverrides ?? {};
	const effective = getEffectiveGates(profile, overrides);
	return { resolved: true, plan, effectiveGates: effective };
}
