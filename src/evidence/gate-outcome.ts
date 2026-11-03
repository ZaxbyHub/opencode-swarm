/**
 * Shared durable-gate derivation (issue #3560).
 *
 * Task-kind durable gate records come in two producer shapes (writer census,
 * issue #3560 claims 4/5):
 *
 * - VERDICT-BEARING (council via src/council/council-evidence-writer.ts):
 *   the entry carries `verdict: 'APPROVE' | 'REJECT' | 'CONCERNS' | ...`.
 *   The receipt/summary surfaces MUST reflect it: APPROVE→pass,
 *   REJECT→block, CONCERNS→pass+code (durable CONCERNS is the advisory form
 *   AT TASK LEVEL — blocking concerns are promoted and write no record; the
 *   `phaseConcernsAllowComplete` knob governs the PHASE gate only), any
 *   other string→error. The outcome is never a constant.
 * - PRESENCE-ONLY (pre_check/reviewer/test_engineer/critic family): written
 *   ONLY on positive settlement, and failure DELETES the key
 *   (stage_a_failed/stage_b_failed in src/gate-evidence.ts). Presence ⇒ pass
 *   is honest BY PRODUCER CONTRACT — there is no durable failure entry these
 *   kinds could misreport. (Limitation, "nothing is reconstructed": absence
 *   cannot distinguish "never ran" from "ran and failed (record deleted)";
 *   failure detail lives in workflow.lastOutcome/retryHistory, which is
 *   capped and lossy — intentionally NOT derived into gate rows.)
 *
 * `responsible_actor` comes from the durable entry's `agent` when present —
 * the same truthfulness rule as the phase arm's `responsibleActor`.
 */

export type DurableTaskGateDerivation = {
	outcome: 'pass' | 'block' | 'error' | 'not_applicable';
	code?: string;
	responsible_actor: string;
};

/** Bounded display evidence: verdict strings are capped, never echoed raw. */
const MAX_VERDICT_CODE_CHARS = 64;

function verdictCode(verdict: string): string {
	return verdict.length > MAX_VERDICT_CODE_CHARS
		? verdict.slice(0, MAX_VERDICT_CODE_CHARS)
		: verdict;
}

export function deriveDurableTaskGate(
	entry: unknown,
): DurableTaskGateDerivation {
	const record = (entry ?? {}) as Record<string, unknown>;
	const actor =
		typeof record.agent === 'string' && record.agent.trim() !== ''
			? record.agent
			: 'swarm';
	const verdict = record.verdict;
	if (typeof verdict === 'string') {
		if (verdict === 'APPROVE') {
			return {
				outcome: 'pass',
				code: verdictCode(verdict),
				responsible_actor: actor,
			};
		}
		if (verdict === 'REJECT') {
			return {
				outcome: 'block',
				code: verdictCode(verdict),
				responsible_actor: actor,
			};
		}
		if (verdict === 'CONCERNS') {
			// Task-level advisory form (see module docstring).
			return {
				outcome: 'pass',
				code: verdictCode(verdict),
				responsible_actor: actor,
			};
		}
		// Unknown verdict: report it, never improve on it — a future verdict
		// vocabulary change degrades the receipt toward scrutiny, not pass.
		return {
			outcome: 'error',
			code: verdictCode(verdict),
			responsible_actor: actor,
		};
	}
	// Presence-only kinds: pass-on-presence is honest by producer contract.
	return { outcome: 'pass', responsible_actor: actor };
}

/**
 * Empty-`gates` synthesis for task receipts (issue #3560 AC5): with no
 * durable gate records a receipt must not fabricate a passed gate. A
 * settled read-only task (durable `workflow.noMutationSettlement`) is
 * honestly pass-bearing; anything else is `not_applicable`.
 */
export function deriveTaskEvidenceSynthesis(
	workflow: unknown,
): DurableTaskGateDerivation {
	const wf = (workflow ?? {}) as Record<string, unknown>;
	if (wf.noMutationSettlement && typeof wf.noMutationSettlement === 'object') {
		return {
			outcome: 'pass',
			code: 'no_mutation_settlement',
			responsible_actor: 'swarm',
		};
	}
	return { outcome: 'not_applicable', responsible_actor: 'swarm' };
}

/** Map a receipt outcome onto the Evidence-summary verdict vocabulary. */
export function evidenceVerdictForDurableGate(
	entry: unknown,
): 'pass' | 'fail' | 'warn' | 'skip' {
	const derived = deriveDurableTaskGate(entry);
	if (derived.outcome === 'block' || derived.outcome === 'error') {
		return 'fail';
	}
	if (derived.outcome === 'not_applicable') {
		return 'skip';
	}
	return derived.code === 'CONCERNS' ? 'warn' : 'pass';
}
