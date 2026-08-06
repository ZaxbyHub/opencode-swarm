/**
 * Distinct `promoted_external` staleness policy (Workstream A, issue #1822).
 *
 * Today `curator.ts:1791` SKIPS promoted-external skills entirely during the
 * staleness sweep. That means a promoted-external skill whose source knowledge
 * changed (or which became unsupported) is never reconciled. This module
 * provides the distinct policy the curator now consults:
 *
 *   - source-knowledge-changed → regenerate (advisory: the curator LOGS source
 *     drift; it does not auto-regenerate promoted-external skills — the user
 *     re-runs external discovery);
 *   - wall-clock retirement (configurable) using the REAL usage signal (#1770),
 *     with minimum-age and support safeguards, and a REVERSIBLE archive.
 *
 * The decision is advisory: the curator routes `retire` to `retireSkill`
 * (reversible / marked); `regenerate` is log-only advisory (the user decides
 * whether to re-run discovery/regeneration).
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export type PromotedExternalStalenessDecision =
	| { action: 'current'; reason: string }
	| { action: 'regenerate'; reason: string; sourceKnowledgeIds: string[] }
	| { action: 'retire'; reason: string };

export interface PromotedExternalStalenessInput {
	directory: string;
	skillSlug: string;
	/** Frontmatter `skill_origin` — must be `promoted_external`. */
	origin?: string;
	/** Frontmatter `source_knowledge_ids` (the knowledge entries this skill came from). */
	sourceKnowledgeIds?: string[];
	/** Real usage counts (from the #1770 skill-usage signal). */
	usage: {
		appliedExplicitCount: number;
		ignoredCount: number;
		violatedCount: number;
	};
	/**
	 * Caller signals that the source knowledge entries have changed since the
	 * skill was promoted (F5 fix: makes the 'regenerate' action reachable).
	 * The curator compares the source knowledge IDs' current content/revision
	 * against what the skill was compiled from.
	 */
	sourceChanged?: boolean;
	/** Days since the skill was last regenerated / promoted. */
	ageDays: number;
	/** Configurable floor; defaults to 60. */
	retirementMinAgeDays: number;
}

/**
 * Parse `source_knowledge_ids`, `skill_origin`, and `promoted_at` from
 * SKILL.md YAML frontmatter CONTENT. Pure (no I/O) so it is directly testable.
 * Returns `{}` if frontmatter is absent or unparseable.
 */
export function parsePromotedExternalFrontmatter(content: string): {
	origin?: string;
	sourceKnowledgeIds?: string[];
	promotedAt?: string;
} {
	const match = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!match) return {};
	const fm = match[1];
	const originMatch = /^skill_origin:\s*(\S+)/m.exec(fm);
	const promotedAtMatch = /^promoted_at:\s*(\S+)/m.exec(fm);
	const origin = originMatch?.[1];
	const promotedAt = promotedAtMatch?.[1];

	// Parse source_knowledge_ids supporting BOTH YAML forms (F5 fix):
	//   inline:  source_knowledge_ids: ["a", "b"]
	//   block:   source_knowledge_ids:
	//              - "a"
	//              - "b"
	let sourceKnowledgeIds: string[] | undefined;
	const inlineMatch = /^source_knowledge_ids:\s*\[([^\]]*)\]/m.exec(fm);
	if (inlineMatch) {
		sourceKnowledgeIds = inlineMatch[1]
			.split(',')
			.map((s) => s.trim().replace(/^["']|["']$/g, ''))
			.filter(Boolean);
	} else {
		const blockMatch = /^source_knowledge_ids:\s*$/m.exec(fm);
		if (blockMatch && blockMatch.index !== undefined) {
			const afterKey = fm.slice(blockMatch.index + blockMatch[0].length);
			const blockItems: string[] = [];
			for (const line of afterKey.split('\n')) {
				if (line.trim() === '') continue;
				if (!/^\s+-\s+/.test(line)) break; // block list ended
				const val = line
					.replace(/^\s+-\s+/, '')
					.trim()
					.replace(/^["']|["']$/g, '');
				if (val) blockItems.push(val);
			}
			if (blockItems.length > 0) sourceKnowledgeIds = blockItems;
		}
	}

	return { origin, sourceKnowledgeIds, promotedAt };
}

/**
 * Frontmatter helper: read a SKILL.md from disk and parse its frontmatter.
 * Returns `{}` if absent or unparseable.
 */
export function readPromotedExternalFrontmatter(skillPath: string): {
	origin?: string;
	sourceKnowledgeIds?: string[];
	promotedAt?: string;
} {
	if (!existsSync(skillPath)) return {};
	const content = readFileSync(skillPath, 'utf8');
	return parsePromotedExternalFrontmatter(content);
}

/**
 * Evaluate staleness for a promoted-external skill.
 *
 * Rules (in priority order):
 *   1. If source knowledge IDs are present but no longer exist in the knowledge
 *      store → `retire` (the source has been deleted; keeping a dangling skill
 *      is worse than retiring).
 *   2. If the skill has been ignored/violated far more than applied AND has
 *      passed the minimum age floor → `retire` (real negative usage signal).
 *   3. If source knowledge IDs are present and still exist but their content
 *      hash changed since promotion (caller passes `sourceChanged: true`) →
 *      `regenerate`.
 *   4. Otherwise → `current`.
 *
 * `ageDays < retirementMinAgeDays` blocks retirement (minimum-age safeguard).
 * Retirement is REVERSIBLE: `retireSkill` records a `retired.marker` and the
 * skill can be restored (the curator's existing restore path).
 */
export function evaluatePromotedExternalStaleness(
	input: PromotedExternalStalenessInput,
): PromotedExternalStalenessDecision {
	// Minimum-age safeguard: never retire a skill younger than the floor.
	const meetsAgeFloor = input.ageDays >= input.retirementMinAgeDays;

	// Source-changed → regenerate (F5 fix: the caller signals that source
	// knowledge has changed; we return 'regenerate' so the curator can route
	// to regenerateSkill). This takes priority over retirement — a changed
	// source may fix the negative-usage signal.
	if (
		input.sourceChanged &&
		input.sourceKnowledgeIds &&
		input.sourceKnowledgeIds.length > 0
	) {
		return {
			action: 'regenerate',
			reason: `source knowledge changed for ${input.sourceKnowledgeIds.length} entr(y|ies)`,
			sourceKnowledgeIds: input.sourceKnowledgeIds,
		};
	}

	// Negative-usage retirement (real usage signal, #1770). Only when the skill
	// is old enough AND the negative signal is decisive.
	const totalNegative = input.usage.ignoredCount + input.usage.violatedCount;
	const applied = input.usage.appliedExplicitCount;
	if (meetsAgeFloor && applied === 0 && totalNegative >= 3) {
		return {
			action: 'retire',
			reason: `never applied, ${totalNegative} negative signals over ${input.ageDays}d (wall-clock retirement)`,
		};
	}
	if (meetsAgeFloor && applied > 0 && totalNegative / applied >= 4) {
		return {
			action: 'retire',
			reason: `negative-to-applied ratio ${totalNegative}/${applied} over ${input.ageDays}d (wall-clock retirement)`,
		};
	}

	return {
		action: 'current',
		reason: `no staleness trigger (age ${input.ageDays}d, applied ${applied}, negative ${totalNegative})`,
	};
}

/**
 * Convenience: build the input for the curator from a skill's frontmatter + the
 * skill-usage log. The curator already has the usage signal; this just reads
 * the frontmatter pieces.
 */
export function buildPromotedExternalInputFromSkill(
	directory: string,
	skillSlug: string,
	usage: PromotedExternalStalenessInput['usage'],
	ageDays: number,
	retirementMinAgeDays: number,
): PromotedExternalStalenessInput | null {
	const skillPath = path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		skillSlug,
		'SKILL.md',
	);
	if (!existsSync(skillPath)) return null;
	const fm = readPromotedExternalFrontmatter(skillPath);
	if (fm.origin !== 'promoted_external') return null;
	return {
		directory,
		skillSlug,
		origin: fm.origin,
		sourceKnowledgeIds: fm.sourceKnowledgeIds ?? [],
		usage,
		ageDays,
		retirementMinAgeDays,
	};
}
