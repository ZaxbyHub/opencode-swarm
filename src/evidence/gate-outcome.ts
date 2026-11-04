/**
 * Shared durable-gate derivation (issue #3560).
 *
 * Task-kind durable gate records come in two producer shapes (writer census,
 * issue #3560 claims 4/5):
 *
 * - VERDICT-BEARING (council via src/council/council-evidence-writer.ts):
 *   the entry carries a `verdict` field. It MUST be reflected: APPROVE→pass,
 *   REJECT→block, CONCERNS→pass+code (durable CONCERNS is the advisory form
 *   AT TASK LEVEL — blocking concerns are promoted and write no record; the
 *   `phaseConcernsAllowComplete` knob governs the PHASE gate only). ANY
 *   present verdict that is not one of those recognized STRINGS — including a
 *   non-string value (number/null/boolean/object/array) — yields `error`, so a
 *   malformed or future-vocabulary verdict can only degrade toward scrutiny,
 *   never improve to pass (#3560 review FB-001).
 * - PRESENCE-ONLY (pre_check/reviewer/test_engineer/critic family): the entry
 *   carries NO `verdict` field. Written ONLY on positive settlement, and
 *   failure DELETES the key (stage_a_failed/stage_b_failed in
 *   src/gate-evidence.ts). Presence ⇒ pass is honest BY PRODUCER CONTRACT —
 *   there is no durable failure entry these kinds could misreport.
 *   (Limitation, "nothing is reconstructed": absence cannot distinguish "never
 *   ran" from "ran and failed (record deleted)"; failure detail lives in
 *   workflow.lastOutcome/retryHistory, which is capped and lossy —
 *   intentionally NOT derived into gate rows.)
 *
 * `responsible_actor` comes from the durable entry's `agent` when present —
 * the same truthfulness rule as the phase arm's `responsibleActor`.
 */

/** Outcome the receipt task arm records for a PRESENT durable gate entry. */
export type DurableTaskGateOutcome = 'pass' | 'block' | 'error';

/** Full outcome union, including the empty-gates synthesis arm. */
export type DurableGateOutcome = DurableTaskGateOutcome | 'not_applicable';

export type DurableTaskGateDerivation = {
	outcome: DurableTaskGateOutcome;
	code?: string;
	responsible_actor: string;
};

/** Bounded display evidence: verdict strings are capped (then md-escaped). */
const MAX_VERDICT_CODE_CHARS = 64;

function boundedCode(value: unknown): string {
	const str = typeof value === 'string' ? value : String(value);
	return str.length > MAX_VERDICT_CODE_CHARS
		? str.slice(0, MAX_VERDICT_CODE_CHARS)
		: str;
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
	if (verdict === undefined) {
		// Presence-only kinds: pass-on-presence is honest by producer contract.
		return { outcome: 'pass', responsible_actor: actor };
	}
	// A verdict-bearing entry: the value MUST be a recognized string. Any
	// other value (unrecognized string OR non-string) is a malformed/foreign
	// verdict and degrades to `error` — it is NEVER allowed to fall through to
	// the presence-only pass arm (that was the #3560-review fail-open).
	if (verdict === 'APPROVE') {
		return {
			outcome: 'pass',
			code: boundedCode(verdict),
			responsible_actor: actor,
		};
	}
	if (verdict === 'REJECT') {
		return {
			outcome: 'block',
			code: boundedCode(verdict),
			responsible_actor: actor,
		};
	}
	if (verdict === 'CONCERNS') {
		// Task-level advisory form (see module docstring).
		return {
			outcome: 'pass',
			code: boundedCode(verdict),
			responsible_actor: actor,
		};
	}
	return {
		outcome: 'error',
		code: boundedCode(verdict),
		responsible_actor: actor,
	};
}

/**
 * Empty-`gates` synthesis for task receipts (issue #3560 AC5): with no
 * durable gate records a receipt must not fabricate a passed gate. Only the
 * CALLER's canonical `isDurableNoMutationSettlement(evidence)` predicate —
 * authoritative generation-0 idle/complete workflow with a bound settlement
 * proof — may make the synthesized row `pass`; anything else is
 * `not_applicable`. Bare field truthiness is NOT sufficient: a
 * blocked/closed workflow can preserve the marker through later transitions.
 */
export function deriveTaskEvidenceSynthesis(canonicalProof: boolean): {
	outcome: DurableGateOutcome;
	code?: string;
	responsible_actor: string;
} {
	if (canonicalProof) {
		return {
			outcome: 'pass',
			code: 'no_mutation_settlement',
			responsible_actor: 'swarm',
		};
	}
	return { outcome: 'not_applicable', responsible_actor: 'swarm' };
}

/** Evidence-summary verdict vocabulary (subset of EvidenceVerdictSchema). */
export type DurableEvidenceVerdict =
	| 'pass'
	| 'fail'
	| 'warn'
	| 'approved'
	| 'rejected';

/**
 * Map a PRESENT durable gate entry onto the evidence-summary verdict tokens
 * (#3560 AC7). The recorded verdict is returned alongside so the summary
 * surface can report it verbatim (REJECT is reported as REJECT, not collapsed
 * to a generic `fail`), and REJECT stays distinguishable from a malformed
 * verdict — the earlier collapse made the two identical. Not_applicable is
 * out of scope here (the bridge only renders present records); the receipt
 * synthesis path handles it separately.
 */
export function evidenceSummaryForDurableGate(entry: unknown): {
	verdict: DurableEvidenceVerdict;
	recordedVerdict?: string;
} {
	const derived = deriveDurableTaskGate(entry);
	switch (derived.outcome) {
		case 'block':
			return { verdict: 'rejected', recordedVerdict: derived.code };
		case 'error':
			return { verdict: 'fail', recordedVerdict: derived.code };
		case 'pass':
			if (derived.code === 'APPROVE') {
				return { verdict: 'approved', recordedVerdict: derived.code };
			}
			if (derived.code === 'CONCERNS') {
				return { verdict: 'warn', recordedVerdict: derived.code };
			}
			return { verdict: 'pass' };
	}
}

/**
 * Sanitize a dynamic value for a GitHub-flavored Markdown table cell (#3560
 * FB-003): pipe characters are escaped and CR/LF are collapsed so durable
 * bytes (gate id, verdict code, actor, artifact path) cannot inject forged
 * rows or break the table structure. The receipt.md is the human/export
 * attestation surface and is not itself hash-bound, so it must not be able to
 * display content absent from the hash-bound receipt.json.
 */
export function markdownTableCell(value: string): string {
	return value.replace(/\r\n|\r|\n/g, ' ').replace(/\|/g, '\\|');
}
