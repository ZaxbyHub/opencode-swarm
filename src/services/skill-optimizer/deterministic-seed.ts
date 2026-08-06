/**
 * Deterministic candidate seed (Workstream A, issue #1822 — #1771 lifecycle closure).
 *
 * The seed is deterministic-first: it composes the existing eligibility
 * functions (`selectCandidateEntries` + `isSkillMaturityEligible` from
 * skill-generator.ts) and sanitizes them into `GeneratorInputs`. LLM free text
 * is supplemental only and is gated off by default (the controller may wire a
 * delegate if `skill_opt.enabled === true` and a delegate is supplied).
 */

import {
	DEFAULT_SKILL_MIN_CONFIDENCE,
	DEFAULT_SKILL_MIN_CONFIRMATIONS,
	selectCandidateEntries,
} from '../skill-generator.js';
import type { SanitizedEvidence } from './candidates.js';

export interface DeterministicSeedInput {
	directory: string;
	/** Override confidence/confirmation floors. */
	minConfidence?: number;
	minConfirmations?: number;
}

export interface DeterministicSeedResult {
	evidence: readonly SanitizedEvidence[];
	/** Count of considered entries that were filtered out (diagnostic). */
	filteredOut: number;
}

/**
 * Produce a deterministic seed of eligible evidence for a candidate draft.
 * Mirrors the eligibility logic in `selectCandidateEntries` /
 * `isSkillMaturityEligible` so the optimizer's seed is consistent with the
 * rest of the skill system. LLM free text is supplemental only and not
 * produced here.
 */
export async function deterministicSeed(
	input: DeterministicSeedInput,
): Promise<DeterministicSeedResult> {
	const entries = await selectCandidateEntries(input.directory, {
		minConfidence: input.minConfidence ?? DEFAULT_SKILL_MIN_CONFIDENCE,
		minConfirmations: input.minConfirmations ?? DEFAULT_SKILL_MIN_CONFIRMATIONS,
	});
	const evidence: SanitizedEvidence[] = [];
	let filteredOut = 0;
	for (const entry of entries) {
		// Defensive sanitization: only structured fields are passed to the
		// generator. Free-text fields (notes, rationale) are intentionally
		// excluded so historical evidence is treated as data, not instructions.
		const triggers = (entry.triggers ?? []).slice(0, 8).map(String);
		const requiredActions = (entry.required_actions ?? [])
			.slice(0, 8)
			.map(String);
		const forbiddenActions = (entry.forbidden_actions ?? [])
			.slice(0, 8)
			.map(String);
		if (triggers.length === 0 && requiredActions.length === 0) {
			filteredOut++;
			continue;
		}
		evidence.push({
			id: String(entry.id),
			triggers,
			requiredActions,
			forbiddenActions,
			confidence: typeof entry.confidence === 'number' ? entry.confidence : 0,
		});
	}
	// Cap the seed size to keep the generator's input bounded.
	const capped = evidence.slice(0, 24);
	return {
		evidence: capped,
		filteredOut: filteredOut + Math.max(0, evidence.length - capped.length),
	};
}
