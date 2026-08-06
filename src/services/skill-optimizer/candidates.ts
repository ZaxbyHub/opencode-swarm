/**
 * Constrained candidate generation (Workstream B, issue #1822).
 *
 * A candidate is a constrained edit of ONE allowlisted `SKILL.md`. The
 * generator:
 *   - is deterministic-first (the deterministic proposal is the seed; LLM free
 *     text is supplemental only);
 *   - CANNOT see held-out contents/scores/evaluator implementation — its inputs
 *     are an explicit allowlist (baseline content, eligible evidence,
 *     counterexamples from the rejection ledger). Any attempt to inject a
 *     claimed held-out task ID throws LEAKAGE_DETECTED (critic I2);
 *   - enforces a trust region (max changed lines/bytes/sections; one target;
 *     preserve frontmatter/schema/discoverability/progressive disclosure);
 *   - treats historical evidence as untrusted DATA, not instructions (sanitized
 *     before injection).
 */

import { createHash } from 'node:crypto';
import type { SkillOptConfig } from '../../config/schema.js';

/** Allowlisted generator inputs — anything else is leakage. */
export interface GeneratorInputs {
	/** Current baseline SKILL.md content. */
	baselineContent: string;
	/** Eligible evidence entries (sanitized, untrusted-as-data). */
	eligibleEvidence: readonly SanitizedEvidence[];
	/** Counterexamples from the rejection ledger (prevents re-drafting rejects). */
	counterexamples: readonly string[];
	/** Edit/token budget for this round. */
	budget: { maxChangedLines: number; maxChangedBytes: number; maxChangedSections: number };
}

export interface SanitizedEvidence {
	id: string;
	triggers: string[];
	requiredActions: string[];
	forbiddenActions: string[];
	confidence: number;
}

/** IDs of held-out test tasks the generator must never see. */
export type ClaimedTestTaskIds = ReadonlySet<string>;

/**
 * Build the generator's input slice from raw materials. Throws LEAKAGE_DETECTED
 * if any held-out task ID is referenced in evidence (defense-in-depth — the
 * generator should never receive held-out task content, but we also refuse the
 * IDs to prevent indirect leakage through metadata).
 */
export function buildGeneratorInputs(args: {
	baselineContent: string;
	eligibleEvidence: readonly SanitizedEvidence[];
	counterexamples: readonly string[];
	budget: SkillOptConfig;
	claimedTestTaskIds: ClaimedTestTaskIds;
}): GeneratorInputs {
	// Leakage check: evidence must not reference a claimed held-out task ID.
	// The evidence `id` is matched by exact equality (a held-out ID is a unique
	// identifier, not a phrase). Phrase fields (triggers/actions) are matched on
	// word boundaries so a short held-out ID like `task-1` does NOT false-positive
	// against a legitimate phrase containing `task-123` (final critic FI2).
	for (const ev of args.eligibleEvidence) {
		// Exact-equality on the evidence id.
		if (args.claimedTestTaskIds.has(ev.id)) {
			throw new Error(`LEAKAGE_DETECTED: evidence id ${ev.id} is a held-out task`);
		}
		// Word-boundary match on phrase fields.
		const phraseFields = [...ev.triggers, ...ev.requiredActions, ...ev.forbiddenActions];
		for (const id of args.claimedTestTaskIds) {
			const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const re = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`);
			for (const phrase of phraseFields) {
				if (re.test(phrase)) {
					throw new Error(`LEAKAGE_DETECTED: evidence ${ev.id} phrase references held-out task ${id}`);
				}
			}
		}
	}
	return {
		baselineContent: args.baselineContent,
		eligibleEvidence: args.eligibleEvidence,
		counterexamples: args.counterexamples,
		budget: {
			maxChangedLines: args.budget.max_changed_lines,
			maxChangedBytes: args.budget.max_changed_bytes,
			maxChangedSections: args.budget.max_changed_sections,
		},
	};
}

export interface DraftedCandidate {
	content: string;
	diffSummary: { changedLines: number; changedBytes: number; changedSections: number };
	rationale: string;
	risks: string[];
	rollbackSnapshot: string; // == baselineContent, stored for atomic rollback
	metric: { eligibilityScore: number };
}

/** DI seam. The deterministic drafter is the default; LLM supplemental is optional. */
export const _internals = {
	/** Deterministic draft: appends a constrained "## Optimization Notes" section. */
	draftDeterministic: defaultDeterministicDraft,
};

function defaultDeterministicDraft(inputs: GeneratorInputs): DraftedCandidate {
	const baseline = inputs.baselineContent;
	const evidenceLines = inputs.eligibleEvidence
		.slice(0, 6)
		.map(
			(e) =>
				`- ${e.id} (confidence ${e.confidence.toFixed(2)}): triggers=${e.triggers.slice(0, 3).join('; ')}`,
		)
		.join('\n');
	const counterexampleNote =
		inputs.counterexamples.length > 0
			? `\n\n## Forbidden Patterns (from rejection ledger)\n${inputs.counterexamples
					.slice(0, 5)
					.map((c) => `- avoid: ${c.slice(0, 160)}`)
					.join('\n')}`
			: '';
	const section = `## Optimization Notes\n\nEvidence-weighted refinements (deterministic seed):\n${evidenceLines}${counterexampleNote}\n`;
	// Only append if the baseline doesn't already end with the section.
	const content = baseline.trimEnd().endsWith('## Optimization Notes')
		? baseline
		: `${baseline.trimEnd()}\n\n${section}`;
	const changedLines = countChangedLines(baseline, content);
	const changedBytes = Buffer.byteLength(content, 'utf8') - Buffer.byteLength(baseline, 'utf8');
	return {
		content,
		diffSummary: {
			changedLines,
			changedBytes: Math.abs(changedBytes),
			changedSections: content.split(/^## /m).length - baseline.split(/^## /m).length,
		},
		rationale: 'deterministic seed from eligible evidence + rejection-ledger counterexamples',
		risks: [
			'deterministic draft may underfit if evidence is sparse',
			'supplemental LLM draft gated off (proposal-only)',
		],
		rollbackSnapshot: baseline,
		metric: { eligibilityScore: inputs.eligibleEvidence.reduce((s, e) => s + e.confidence, 0) },
	};
}

/** Enforce the trust region; throws TrustRegionViolation on breach. */
export function enforceTrustRegion(
	candidate: DraftedCandidate,
	budget: { maxChangedLines: number; maxChangedBytes: number; maxChangedSections: number },
): void {
	const v = candidate.diffSummary;
	const breaches: string[] = [];
	if (v.changedLines > budget.maxChangedLines) {
		breaches.push(`changedLines ${v.changedLines} > ${budget.maxChangedLines}`);
	}
	if (v.changedBytes > budget.maxChangedBytes) {
		breaches.push(`changedBytes ${v.changedBytes} > ${budget.maxChangedBytes}`);
	}
	if (v.changedSections > budget.maxChangedSections) {
		breaches.push(`changedSections ${v.changedSections} > ${budget.maxChangedSections}`);
	}
	if (breaches.length > 0) {
		throw new Error(`TrustRegionViolation: ${breaches.join('; ')}`);
	}
}

/** Equivalent-patch detection: identical content hash → no-op, stop convergence. */
export function isEquivalentPatch(baselineContent: string, candidateContent: string): boolean {
	return hashContent(baselineContent) === hashContent(candidateContent);
}

function hashContent(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

function countChangedLines(a: string, b: string): number {
	const aLines = a.split('\n');
	const bLines = b.split('\n');
	const max = Math.max(aLines.length, bLines.length);
	let changed = 0;
	for (let i = 0; i < max; i++) {
		if (aLines[i] !== bLines[i]) changed++;
	}
	return changed;
}

/**
 * Produce a candidate from inputs. Deterministic-first; the LLM delegate (if
 * wired) is supplemental and must stay within the same trust region.
 */
export function draftCandidate(inputs: GeneratorInputs): DraftedCandidate {
	const candidate = _internals.draftDeterministic(inputs);
	enforceTrustRegion(candidate, inputs.budget);
	return candidate;
}
