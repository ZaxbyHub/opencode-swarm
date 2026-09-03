/**
 * Canonical council review identity (issue #2102 contract A).
 *
 * ONE shared implementation used by the task/phase/final council producers,
 * the #2085 authoritative round store (as the scope/generation key), the
 * evidence writers, and the completion gates. Writers and gates compute the
 * identity from the same plan + config through this module, so the digests
 * match byte-for-byte by construction.
 *
 * Identity components:
 * - `planId` / `planIdentityHash` — collision-resistant raw plan identity
 *   (swarm/title), delegated to `plan/utils`.
 * - `reviewHash` — a purpose-built, status-stable hash of every
 *   review-relevant plan field. Pure execution progress (statuses, the
 *   current-phase pointer, transient blocked reasons, timestamps) is
 *   excluded, so normal progress never invalidates a completed review.
 * - `policyDigest` — canonical digest of the council policy that shaped the
 *   review (quorum/veto/concerns/maxRounds/freshness). Any policy change
 *   opens a new generation and invalidates prior evidence.
 * - `identityDigest` — sha256 over the canonical identity object; this is
 *   the round-store scope/generation key and the evidence binding.
 *
 * `computePlanLedgerHash` (ledger integrity) and `computePlanStructureHash`
 * (plan-critic execution gate) are intentionally NOT reused or modified:
 * the first is status-sensitive by design, and the second still hashes
 * progress-like fields (`blocked_reason`, `current_phase`) while dropping
 * the review-relevant `fr_refs`. See `src/plan/ledger.ts` doc comments.
 */

import { createHash } from 'node:crypto';
import type { RuntimePlan } from '../config/plan-schema';
import { getCanonicalAgentRole } from '../config/schema';
import { normalizeExecutionProfileForHash } from '../plan/planning-profile';
import { derivePlanId, derivePlanIdentityHash } from '../plan/utils';
import type { CouncilAgent, CouncilConfig } from './types';
import { COUNCIL_MEMBER_ROLES } from './types';

/** Schema/cutover version of the council review identity itself. */
export const COUNCIL_REVIEW_IDENTITY_VERSION = 2 as const;

export type CouncilLevel = 'task' | 'phase' | 'final';

export type CouncilReviewScope =
	| { kind: 'task'; taskId: string }
	| { kind: 'phase'; phaseNumber: number }
	| { kind: 'final'; final: true };

/** Normalized final-council completion policy (issue #2102 contract C). */
export type FinalCompletionPolicy =
	| { mode: 'all_required' }
	| { mode: 'quorum'; minimumMembers: number };

export interface CouncilReviewIdentity {
	version: number;
	level: CouncilLevel;
	scope: CouncilReviewScope;
	planId: string | null;
	planIdentityHash: string | null;
	reviewHash: string | null;
	policyDigest: string;
	identityDigest: string;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function isIdentityDigest(value: unknown): value is string {
	return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

/**
 * Resolve a submitted council member name to its canonical role (issue
 * #2102 contract C). Accepts the exact canonical role (`critic`) and
 * multi-swarm prefixed names (`local_critic`) via suffix resolution.
 * Returns null for unknown names — they never count toward quorum.
 *
 * Swarm-membership itself cannot be verified for architect-submitted JSON
 * verdicts (there is no per-agent authentication at the tool boundary), so
 * the enforceable cross-swarm defense is canonical-role deduplication: two
 * prefixed names that resolve to the same canonical role (`local_critic` +
 * `mega_critic`) count as ONE member. Writers, gates, and tests must all
 * use this shared resolver so the role policy never drifts.
 */
export function resolveCouncilMemberRole(
	agentName: string,
): CouncilAgent | null {
	const resolved = getCanonicalAgentRole(agentName);
	return COUNCIL_MEMBER_ROLES.includes(resolved as CouncilAgent)
		? (resolved as CouncilAgent)
		: null;
}

/**
 * Status-stable hash of every review-relevant plan field.
 *
 * INCLUDED (the council judges these): schema_version, title, swarm,
 * execution_profile (execution requirements), migration_status (durable plan
 * property), phase id/name/type/required_agents, task id/phase/size/
 * description/depends/acceptance/files_touched/evidence_path/fr_refs
 * (FR/spec references, #1687).
 *
 * EXCLUDED (pure execution progress — the issue's explicit list):
 * phase.status, task.status, current_phase (progress pointer), blocked_reason
 * (transient), specMtime/specHash (timestamps + spec content, tracked
 * separately by the ledger's spec_updated path per ledger.ts's established
 * rationale).
 */
export function computeCouncilReviewHash(plan: RuntimePlan): string {
	const normalized = {
		schema_version: plan.schema_version,
		title: plan.title,
		swarm: plan.swarm,
		migration_status: plan.migration_status,
		execution_profile: normalizeExecutionProfileForHash(plan.execution_profile),
		phases: plan.phases.map((phase) => ({
			id: phase.id,
			name: phase.name,
			type: phase.type,
			required_agents: phase.required_agents
				? [...phase.required_agents].sort()
				: undefined,
			tasks: phase.tasks.map((task) => ({
				id: task.id,
				phase: task.phase,
				size: task.size,
				description: task.description,
				depends: [...task.depends].sort(),
				acceptance: task.acceptance,
				files_touched: [...task.files_touched].sort(),
				evidence_path: task.evidence_path,
				fr_refs: task.fr_refs ? [...task.fr_refs].sort() : undefined,
			})),
		})),
	};
	return createHash('sha256')
		.update(JSON.stringify(normalized), 'utf8')
		.digest('hex');
}

/**
 * Canonical per-level council policy digest.
 *
 * Every field that shapes what the council required at this level is hashed,
 * so changing the mode, a minimum, the role/quorum knobs, veto/concerns
 * behavior, max rounds, or the freshness window opens a new generation.
 * Inert fields (`parallelTimeoutMs`, `escalateOnMaxRounds`) deliberately do
 * NOT contribute — changing them must not invalidate evidence.
 */
export function computeCouncilPolicyDigest(
	level: CouncilLevel,
	config?: CouncilConfig,
): string {
	const base = {
		maxRounds: config?.maxRounds ?? 3,
		vetoPriority: config?.vetoPriority ?? true,
		freshnessMaxAgeHours: config?.freshnessMaxAgeHours ?? 24,
	};
	let normalized: Record<string, unknown>;
	if (level === 'final') {
		normalized = {
			...base,
			finalCompletionPolicy: resolveFinalCompletionPolicy(config),
		};
	} else if (level === 'phase') {
		normalized = {
			...base,
			requireAllMembers: config?.requireAllMembers ?? false,
			minimumMembers: config?.minimumMembers ?? 3,
			phaseConcernsAllowComplete: config?.phaseConcernsAllowComplete ?? true,
		};
	} else {
		normalized = {
			...base,
			requireAllMembers: config?.requireAllMembers ?? false,
			minimumMembers: config?.minimumMembers ?? 3,
		};
	}
	return createHash('sha256')
		.update(JSON.stringify(normalized), 'utf8')
		.digest('hex');
}

/**
 * Resolve the final-council completion policy from config.
 *
 * Missing/absent config, a missing `finalCompletionPolicy`, or an invalid
 * quorum declaration all fail closed to the strict legacy `all_required`
 * requirement (all five canonical roles, zero absentees). Explicit
 * `quorum` requires a bounded `minimumMembers` of 3..5; only distinct
 * members of the canonical five-role set ever count toward it.
 */
export function resolveFinalCompletionPolicy(
	config?: CouncilConfig,
): FinalCompletionPolicy {
	const policy = config?.finalCompletionPolicy;
	if (!policy || policy.mode !== 'quorum') {
		return { mode: 'all_required' };
	}
	const minimum = policy.minimumMembers;
	if (
		typeof minimum === 'number' &&
		Number.isInteger(minimum) &&
		minimum >= 3 &&
		minimum <= 5
	) {
		return { mode: 'quorum', minimumMembers: minimum };
	}
	// Invalid quorum declaration: stricter-wins → exact legacy requirement.
	return { mode: 'all_required' };
}

/**
 * Compute the canonical council review identity. `plan` may be null (no plan
 * on disk): the identity then carries null plan fields, and any consumer
 * holding a plan will fail closed against it — evidence without plan binding
 * can never satisfy a gate that has a plan.
 */
export function computeCouncilReviewIdentity(input: {
	level: CouncilLevel;
	scope: CouncilReviewScope;
	plan: RuntimePlan | null;
	config?: CouncilConfig;
}): CouncilReviewIdentity {
	const identity: Omit<CouncilReviewIdentity, 'identityDigest'> = {
		version: COUNCIL_REVIEW_IDENTITY_VERSION,
		level: input.level,
		scope: input.scope,
		planId: input.plan ? derivePlanId(input.plan) : null,
		planIdentityHash: input.plan ? derivePlanIdentityHash(input.plan) : null,
		reviewHash: input.plan ? computeCouncilReviewHash(input.plan) : null,
		policyDigest: computeCouncilPolicyDigest(input.level, input.config),
	};
	return {
		...identity,
		identityDigest: createHash('sha256')
			.update(JSON.stringify(identity), 'utf8')
			.digest('hex'),
	};
}

/**
 * The evidence-entry projection of an identity. Writers embed these fields in
 * council evidence; gates recompute the identity and compare byte-for-byte.
 */
export function councilIdentityEvidenceFields(
	identity: CouncilReviewIdentity,
): {
	identity_version: number;
	review_hash: string | null;
	policy_digest: string;
	identity_digest: string;
} {
	return {
		identity_version: identity.version,
		review_hash: identity.reviewHash,
		policy_digest: identity.policyDigest,
		identity_digest: identity.identityDigest,
	};
}
