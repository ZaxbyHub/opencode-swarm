/**
 * The pure actionability predicate (knowledge Layer 5), extracted as a LEAF
 * module (issue #1821 Workstream A3).
 *
 * Why this file exists separately from `knowledge-validator.ts`: the predicate
 * itself has always been pure, but its host module imports `node:fs/promises`
 * and `proper-lockfile` at the top level. `hive-policy.ts` documents that it
 * "performs NO I/O and holds NO module-level mutable state" (invariant 8), so
 * importing the predicate from the validator would have quietly made that
 * comment false. Extracting the predicate keeps the documented purity TRUE
 * rather than weakening the comment.
 *
 * CONTRACT FOR THIS MODULE: no I/O imports, no module-level mutable state, no
 * plugin-init-path import. It may only import types. `knowledge-validator.ts`
 * re-exports everything here, so every existing consumer is unaffected.
 */

import type { KnowledgeEntryBase } from './knowledge-types.js';

export interface ActionabilityResult {
	actionable: boolean;
	/** Present only when not actionable. */
	reason?:
		| 'missing_predicate'
		| 'missing_scope'
		| 'missing_predicate_and_scope';
}

/** The exact field subset the predicate reads. */
export type ActionabilityInput = Pick<
	KnowledgeEntryBase,
	| 'forbidden_actions'
	| 'required_actions'
	| 'verification_checks'
	| 'verification_predicate'
	| 'applies_to_tools'
	| 'applies_to_agents'
>;

function hasNonEmptyList(v: unknown): boolean {
	return Array.isArray(v) && v.length > 0;
}

/**
 * Layer 5: an entry is actionable only when it carries at least one
 * machine-checkable predicate AND at least one scope tag.
 *
 *   predicate := forbidden_actions | required_actions | verification_checks
 *                | verification_predicate
 *   scope     := applies_to_tools | applies_to_agents
 *
 * Plain-prose lessons (no predicate, no scope) are NOT actionable and must be
 * quarantined rather than activated.
 */
export function validateActionability(
	entry: ActionabilityInput,
): ActionabilityResult {
	const hasPredicate =
		hasNonEmptyList(entry.forbidden_actions) ||
		hasNonEmptyList(entry.required_actions) ||
		hasNonEmptyList(entry.verification_checks) ||
		(typeof entry.verification_predicate === 'string' &&
			entry.verification_predicate.trim().length > 0);
	const hasScope =
		hasNonEmptyList(entry.applies_to_tools) ||
		hasNonEmptyList(entry.applies_to_agents);

	if (hasPredicate && hasScope) return { actionable: true };
	const reason: ActionabilityResult['reason'] =
		!hasPredicate && !hasScope
			? 'missing_predicate_and_scope'
			: !hasPredicate
				? 'missing_predicate'
				: 'missing_scope';
	return { actionable: false, reason };
}
