/**
 * One promotion policy evaluator used by automatic promotion AND the manual
 * `/swarm promote` command (issue #1847 §4).
 *
 * Previously, automatic promotion went through `isHiveEligible` (3 routes:
 * hive_eligible+3 phases / hive-fast-track tag / age) while manual promotion
 * (`promoteToHive` / `promoteFromSwarm`) bypassed policy entirely — an exact
 * entry id was effectively authorization to skip the gate, with no durable
 * override record. This module is the single policy function both paths share.
 *
 * Manual promotion that fails the policy MUST either be blocked, or proceed
 * only with an explicit `--force` override that records a durable, audited
 * override (actor, reason, source revision, failed gates). An exact entry id
 * alone is NEVER authorization to bypass policy.
 *
 * Conservative application evidence (#1847 §2, AC5/AC6): the
 * `validated_terminal_applications` gate counts ONLY validated terminal receipts
 * tied to a real retrieval trace + result membership. Legacy records carry no
 * evidence and receive NO synthetic credit. Until #1849 produces real receipts,
 * the configured thresholds default to 0, so the gate is satisfied by absence
 * (it neither credits nor blocks) and current behavior is preserved. Operators
 * raise the thresholds to activate application-evidence gating.
 *
 * Actionability floor (#1821 A3): the `actionability_floor` gate refuses to
 * promote a plain-prose lesson — a promotion candidate must carry at least one
 * machine-checkable predicate AND at least one scope tag. It is ON by default
 * (`knowledge.promotion_require_actionable`, schema default `true`); the
 * hand-written `KnowledgeConfig` interface declares the field OPTIONAL, so this
 * module reads it as `?? true`.
 *
 * This module performs NO I/O and holds NO module-level mutable state
 * (invariant 8). It is NOT imported on the plugin-init path (invariant 1).
 * `validateActionability` is imported from the LEAF module
 * `./actionability-predicate.js` rather than from `./knowledge-validator.js`,
 * which imports `node:fs/promises` + `proper-lockfile` — importing the
 * validator here would have made the no-I/O statement above false.
 */

import { validateActionability } from './actionability-predicate.js';
import type {
	KnowledgeConfig,
	PromotionEvidenceRecord,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { isActiveStatus } from './knowledge-types.js';

/** A single named policy gate and whether it passed. */
export interface PromotionPolicyGate {
	name: string;
	passed: boolean;
	detail: string;
}

export interface PromotionPolicyInput {
	entry: SwarmKnowledgeEntry;
	config: KnowledgeConfig;
	/**
	 * Validated terminal-application evidence for this entry's lesson
	 * (near-duplicate-clustered). Empty for legacy/no-evidence records. The
	 * promoter loads this OUTSIDE the hive transaction and passes it in.
	 */
	evidence: PromotionEvidenceRecord[];
}

export interface PromotionPolicyDecision {
	eligible: boolean;
	/** Every gate and whether it passed — surfaced in diagnostics + override audit. */
	gates: PromotionPolicyGate[];
	/** Human-readable summary of the deciding gate. */
	reason: string;
}

/**
 * Evaluate the one promotion policy. Used by auto promotion and manual promote.
 * Returns the full gates list so diagnostics can explain each failed condition
 * (AC: "Promotion diagnostics explain eligibility failures and lineage").
 */
export function evaluatePromotionPolicy(
	input: PromotionPolicyInput,
): PromotionPolicyDecision {
	const { entry, config, evidence } = input;
	const gates: PromotionPolicyGate[] = [];

	// Gate: active status. Routes through the canonical helper so the inactive
	// set has a single source of truth (G4 / #1716).
	const active = isActiveStatus(entry.status);
	gates.push({
		name: 'active_status',
		passed: active,
		detail: active
			? `status='${entry.status}' is retrieval-active`
			: `status='${entry.status}' is inactive (archived/quarantined/quarantined_unactionable)`,
	});

	// Gate: the three historical eligibility routes (preserved verbatim from the
	// pre-#1847 isHiveEligible so behavior does not regress). Exactly one route
	// passing satisfies this gate.
	const routeDetail = describeEligibilityRoute(entry, config.auto_promote_days);
	gates.push({
		name: 'eligibility_route',
		passed: routeDetail.passed,
		detail: routeDetail.detail,
	});

	// Gate: validated terminal applications (NEW, conservative). Counts ONLY
	// validated PromotionEvidenceRecords across the configured minimum number of
	// DISTINCT canonical cohort ids. Defaults to 0 → satisfied by absence (no
	// synthetic credit, no new blocking) until #1849 produces real receipts.
	const minApps = config.promotion_min_terminal_applications ?? 0;
	const minCohorts = config.promotion_min_distinct_cohorts ?? 0;
	const distinctCohorts = new Set(
		evidence.map((e) => e.cohort_id).filter((c): c is string => !!c),
	);
	const appsOk = evidence.length >= minApps;
	const cohortsOk = distinctCohorts.size >= minCohorts;
	gates.push({
		name: 'validated_terminal_applications',
		passed: appsOk && cohortsOk,
		detail:
			minApps === 0 && minCohorts === 0
				? 'threshold 0 — no application-evidence gate active (until #1849)'
				: `${evidence.length} receipt(s) across ${distinctCohorts.size} cohort(s) (need ≥${minApps} app / ≥${minCohorts} cohort)`,
	});

	// Gate: not currently confidence-floor-demoted (a floor-clamped entry should
	// not be promoted until it recovers).
	const notFloorDemoted = entry.confidence_floor_demoted !== true;
	gates.push({
		name: 'confidence_floor',
		passed: notFloorDemoted,
		detail: notFloorDemoted
			? 'entry not confidence-floor-demoted'
			: 'entry is confidence-floor-demoted; recover above the floor before promoting',
	});

	// Gate: actionability floor (#1821 A3). A promotion candidate must carry at
	// least one machine-checkable predicate (required/forbidden actions,
	// verification checks, or a verification predicate) AND at least one scope
	// tag (applies_to_tools / applies_to_agents). Plain-prose observations stay
	// in the swarm tier instead of becoming cross-project knowledge.
	//
	// Default ON. `promotion_require_actionable` is `.default(true)` on the Zod
	// schema but OPTIONAL on the hand-written `KnowledgeConfig` interface that
	// the hooks layer imports, so it is read as `?? true` — an operator who has
	// never heard of the flag still gets the floor.
	const requireActionable = config.promotion_require_actionable ?? true;
	const actionability = validateActionability(entry);
	gates.push({
		name: 'actionability_floor',
		passed: !requireActionable || actionability.actionable,
		detail: !requireActionable
			? 'promotion_require_actionable=false — actionability floor not enforced'
			: actionability.actionable
				? 'entry carries a machine-checkable predicate and a scope tag'
				: `not actionable (${actionability.reason}): a promotion candidate needs a predicate ` +
					`(required_actions / forbidden_actions / verification_checks / verification_predicate) ` +
					`AND a scope (applies_to_tools / applies_to_agents)`,
	});

	const eligible = gates.every((g) => g.passed);
	const failed = gates.filter((g) => !g.passed);
	const reason = eligible
		? 'all policy gates passed'
		: `failed gate(s): ${failed.map((g) => g.name).join(', ')}`;

	return { eligible, gates, reason };
}

/**
 * The three historical eligibility routes, preserved verbatim from the
 * pre-#1847 `isHiveEligible`. Exposed so `isHiveEligible` can delegate to it
 * (M1 fix — keeps the public export + its test consumers working) and so the
 * policy gate above can report which route satisfied it.
 */
export function describeEligibilityRoute(
	entry: SwarmKnowledgeEntry,
	autoPromoteDays: number,
): { passed: boolean; detail: string } {
	if (!isActiveStatus(entry.status)) {
		return {
			passed: false,
			detail: 'inactive status (route precondition failed)',
		};
	}

	// Route 1: hive_eligible flag + 3+ distinct phases.
	const phaseNumbers = new Set<number>();
	for (const record of entry.confirmed_by ?? []) {
		if (record && typeof record.phase_number === 'number') {
			phaseNumbers.add(record.phase_number);
		}
	}
	if (entry.hive_eligible === true && phaseNumbers.size >= 3) {
		return {
			passed: true,
			detail: `route 1: hive_eligible + ${phaseNumbers.size} distinct phase(s)`,
		};
	}

	// Route 2: fast-track tag (privileged — only set by authorized tooling).
	if ((entry.tags ?? []).includes('hive-fast-track')) {
		return { passed: true, detail: 'route 2: hive-fast-track tag' };
	}

	// Route 3: age-based.
	const createdMs = Date.parse(entry.created_at);
	const ageMs = Number.isFinite(createdMs) ? Date.now() - createdMs : 0;
	const ageThresholdMs = autoPromoteDays * 86_400_000;
	if (ageMs >= ageThresholdMs) {
		return {
			passed: true,
			detail: `route 3: age ${Math.round(ageMs / 86_400_000)}d ≥ ${autoPromoteDays}d`,
		};
	}

	return {
		passed: false,
		detail:
			`no eligibility route: hive_eligible=${entry.hive_eligible === true} (${phaseNumbers.size} phases), ` +
			`fast-track=${(entry.tags ?? []).includes('hive-fast-track')}, ` +
			`age=${Math.round(ageMs / 86_400_000)}d < ${autoPromoteDays}d`,
	};
}

/** Names of override-audit fields the promoter fills when a manual --force fires. */
export interface OverrideAuditDetail {
	actor: 'manual-override';
	reason: string;
	failedGates: PromotionPolicyGate[];
	entryId: string;
	lesson: string;
}

/**
 * Build the failed-gates summary for a manual override, given a decision that
 * was NOT eligible. Used by the promoter to populate `lineage.override_failed_gates`.
 */
export function failedGateNames(decision: PromotionPolicyDecision): string[] {
	return decision.gates.filter((g) => !g.passed).map((g) => g.name);
}

/** Count distinct canonical cohorts among promotion evidence (for diagnostics). */
export function countDistinctEvidenceCohorts(
	evidence: PromotionEvidenceRecord[],
): number {
	return new Set(
		evidence.map((e) => e.cohort_id).filter((c): c is string => !!c),
	).size;
}
