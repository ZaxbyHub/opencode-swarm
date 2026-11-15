/**
 * First-turn bundled-skill materialization gate (#3364).
 *
 * The deferred bundled-skill sync (post-resolution task, AGENTS.md Invariant 1)
 * can still be copying `.swarm/bundled-skills/` when the first chat turn
 * arrives — measured 16/16 live observations with the first-turn arrival
 * 1249-3558 ms BEFORE the copy finished (issue #3364), and the architect's
 * MODE self-load protocol reports `SKILL_LOAD_FAILED` on a missing file.
 * Nothing ordered the read after the copy.
 *
 * This gate closes that ordering gap WITHOUT touching the init path: composed
 * as the FIRST step of `experimental.chat.messages.transform`, its first
 * invocation (and any concurrent invocation arriving before settlement) awaits
 * the root's registered materialization promise with a single total budget.
 * The current turn therefore proceeds only after materialization settled (or
 * the budget expired) — a copy that finishes mid-wait is observed by the SAME
 * turn. The settled shared promise IS the latch: there is no once-flag set
 * ahead of the await, so a concurrent second transform cannot slip past while
 * the first is still waiting (it joins the same wait), and post-settlement
 * invocations await an already-resolved promise (a microtask, effectively
 * free). Fail-open by contract: never throws, never mutates the hook
 * input/output.
 */

import {
	awaitBundledSkillsMaterialization,
	type BundledSkillsMaterializationStatus,
} from '../config/bundled-skills.js';
import { log } from '../utils/logger.js';

/** Single total wait budget: ~4x the committed final-batch max window
 * (3.612 s); >= 3.5x the widest observed window across all 19 ADR
 * observations (~4.2 s). */
export const FIRST_TURN_GATE_TOTAL_BUDGET_MS = 15_000;

export type BundledSkillsFirstTurnGate = (
	input: unknown,
	output: unknown,
) => Promise<void>;

/**
 * Create the gate for one project root. SINGLE-WAIT semantics:
 * - the shared wait is created once and awaited by EVERY invocation —
 *   pre-settlement invocations join it, post-settlement invocations return
 *   through the resolved promise;
 * - 'not-started' (no registration: writes disabled at enqueue, or the
 *   registry cap refused the root) resolves immediately — today's ordering
 *   (the command-path sync backstop) applies, disclosed in the fragment/ADR.
 */
export function createBundledSkillsFirstTurnGate(
	projectRoot: string,
	timeoutMs: number = FIRST_TURN_GATE_TOTAL_BUDGET_MS,
): BundledSkillsFirstTurnGate {
	let shared: Promise<void> | null = null;
	const run = (): Promise<void> => {
		if (shared) return shared;
		shared = (async () => {
			let status: BundledSkillsMaterializationStatus;
			try {
				status = await awaitBundledSkillsMaterialization(
					projectRoot,
					timeoutMs,
				);
			} catch {
				status = 'timeout';
			}
			if (status !== 'ready') {
				log('bundled-skills first-turn gate degraded (fail-open)', {
					projectRoot,
					status,
				});
			}
		})();
		return shared;
	};
	const gate = async (_input: unknown, _output: unknown): Promise<void> => {
		const wait = run();
		try {
			await wait;
		} catch {
			// Fail-open by contract; the shared wait itself never throws.
		}
	};
	return gate;
}
