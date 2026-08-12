/**
 * Tool to configure a QA gate profile for the current or future plan.
 *
 * Architect-only: invoked during PLAN's QA GATE SELECTION phase. The initial
 * profile reflects explicit true/false choices; later writes are ratchet-tighter
 * and cannot disable enabled gates. Rejects all writes once locked.
 *
 * Creates the profile atomically from defaults plus the initial selection if
 * missing, then applies the ordinary ratchet semantics.
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	computeProfileHash,
	getProfileLookupForIdentity,
	QaGateProfileIdentityUnboundError,
	type QaGates,
	setGatesForIdentity,
} from '../db/qa-gate-profile.js';
import { loadPlanJsonOnly } from '../plan/manager';
import { formatLegacyQaBindingOnlyCall } from '../qa-gate/recovery.js';
import { createSwarmTool } from './create-tool';
import {
	type QaGatePlanIdentityArgs,
	resolveQaGatePlanIdentity,
} from './qa-gate-plan-identity.js';

export interface SetQaGatesArgs extends QaGatePlanIdentityArgs {
	reviewer?: boolean;
	test_engineer?: boolean;
	council_mode?: boolean;
	sme_enabled?: boolean;
	critic_pre_plan?: boolean;
	hallucination_guard?: boolean;
	sast_enabled?: boolean;
	mutation_test?: boolean;
	phase_council?: boolean;
	drift_check?: boolean;
	final_council?: boolean;
	project_type?: string;
	adopt_legacy_binding_only?: boolean;
}

interface SetQaGatesResult {
	success: boolean;
	reason?: string;
	message?: string;
	plan_id?: string;
	profile?: {
		plan_id: string;
		gates: Record<string, boolean>;
		locked_at: string | null;
		locked_by_snapshot_seq: number | null;
		profile_hash: string;
	};
}

export async function executeSetQaGates(
	args: SetQaGatesArgs,
	directory: string,
): Promise<SetQaGatesResult> {
	const plan = await loadPlanJsonOnly(directory);
	const identity = resolveQaGatePlanIdentity(plan, args);
	if (!identity.success) {
		return {
			success: false,
			reason: identity.reason,
			message: identity.message,
		};
	}
	const planId = identity.planId;
	const currentPlanMatchesIdentity =
		plan?.swarm === identity.identity.swarm &&
		plan?.title === identity.identity.title;

	const partial: Partial<QaGates> = {};
	const gateKeys = [
		'reviewer',
		'test_engineer',
		'council_mode',
		'sme_enabled',
		'critic_pre_plan',
		'hallucination_guard',
		'sast_enabled',
		'mutation_test',
		'phase_council',
		'drift_check',
		'final_council',
	] as Array<keyof QaGates>;
	for (const key of gateKeys) {
		if (args[key] !== undefined) partial[key] = args[key] as boolean;
	}
	const bindingOnlyRequested = args.adopt_legacy_binding_only === true;
	const hasGatePatch = Object.keys(partial).length > 0;

	if (
		bindingOnlyRequested &&
		(hasGatePatch || args.project_type !== undefined)
	) {
		return {
			success: false,
			reason: 'binding_only_patch_conflict',
			message:
				'adopt_legacy_binding_only performs exact-binding recovery only. Omit all gate booleans and project_type when using it.',
		};
	}

	if (bindingOnlyRequested && !currentPlanMatchesIdentity) {
		return {
			success: false,
			reason: 'adopt_legacy_requires_current_plan',
			message:
				'adopt_legacy_binding_only may only target the exact current persisted plan identity. Re-run it from the active plan without replacing swarm_id or plan_title.',
		};
	}

	if (bindingOnlyRequested) {
		const lookup = getProfileLookupForIdentity(directory, identity.identity);
		if (lookup.kind === 'missing') {
			return {
				success: false,
				reason: 'no_profile',
				plan_id: planId,
				message:
					'No legacy QA gate profile row exists for this exact current plan identity, so there is nothing to adopt.',
			};
		}
		if (lookup.kind === 'bound') {
			return {
				success: true,
				plan_id: planId,
				message: `QA gate profile is already exact-bound for plan_id=${planId}; no gates or lock state changed.`,
				profile: {
					plan_id: lookup.profile.plan_id,
					gates: { ...lookup.profile.gates },
					locked_at: lookup.profile.locked_at,
					locked_by_snapshot_seq: lookup.profile.locked_by_snapshot_seq,
					profile_hash: computeProfileHash(lookup.profile),
				},
			};
		}
	}

	try {
		const updated = setGatesForIdentity(directory, identity.identity, partial, {
			projectType: args.project_type,
			allowLegacyAdoption: currentPlanMatchesIdentity,
			allowLegacyCollisionCreate: !currentPlanMatchesIdentity,
			legacyAdoptionIdentity: plan
				? { swarm: plan.swarm, title: plan.title }
				: undefined,
		});
		return {
			success: true,
			plan_id: planId,
			message: bindingOnlyRequested
				? `Legacy QA gate profile exact-bound for plan_id=${planId} without changing gates or lock state.`
				: `QA gates updated for plan_id=${planId}`,
			profile: {
				plan_id: updated.plan_id,
				gates: { ...updated.gates },
				locked_at: updated.locked_at,
				locked_by_snapshot_seq: updated.locked_by_snapshot_seq,
				profile_hash: computeProfileHash(updated),
			},
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const lower = msg.toLowerCase();
		let reason = 'set_gates_failed';
		if (err instanceof QaGateProfileIdentityUnboundError) {
			reason = 'plan_identity_unbound';
		}
		if (lower.includes('locked')) reason = 'profile_locked';
		else if (lower.includes('ratchet')) reason = 'ratchet_violation';
		else if (bindingOnlyRequested) {
			reason = 'binding_only_failed';
		}
		return {
			success: false,
			reason,
			message:
				err instanceof QaGateProfileIdentityUnboundError
					? `${msg} ${formatLegacyQaBindingOnlyCall(identity.identity)} is the only supported adoption path for locked or upgraded legacy rows.`
					: msg,
			plan_id: planId,
		};
	}
}

export const set_qa_gates: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Configure the QA gate profile for the current or exact future plan. Architect-only. ' +
		'The initial selection accepts explicit true and false values; later calls can ' +
		'enable additional gates but cannot disable enabled gates. Rejects writes once ' +
		'locked (after critic approval). Creates the initial profile atomically ' +
		'from defaults plus the explicit selection. Uses plan.json identity by ' +
		'default, or exact swarm_id + plan_title before a plan exists.',
	args: {
		swarm_id: z
			.string()
			.refine((value) => value.trim().length > 0, 'Must not be blank')
			.optional()
			.describe(
				'Exact swarm identity for pre-plan QA selection. Must be provided with plan_title.',
			),
		plan_title: z
			.string()
			.refine((value) => value.trim().length > 0, 'Must not be blank')
			.optional()
			.describe(
				'Exact future plan title for pre-plan QA selection. Must be provided with swarm_id.',
			),
		confirm_identity_change: z
			.boolean()
			.optional()
			.describe(
				'Confirm that an explicit swarm_id/plan_title pair intentionally replaces the current plan identity.',
			),
		reviewer: z
			.boolean()
			.optional()
			.describe(
				'Select the reviewer gate; later calls cannot turn it off once enabled.',
			),
		test_engineer: z
			.boolean()
			.optional()
			.describe(
				'Enable the test_engineer gate (true) — cannot be disabled once on.',
			),
		council_mode: z
			.boolean()
			.optional()
			.describe(
				'Enable council mode — replaces per-task Stage B (reviewer + test_engineer) with the full 5-member council (critic, reviewer, sme, test_engineer, explorer) per task.',
			),
		sme_enabled: z.boolean().optional().describe('Enable SME consultation.'),
		critic_pre_plan: z
			.boolean()
			.optional()
			.describe('Enable critic_pre_plan review before plan approval.'),
		hallucination_guard: z
			.boolean()
			.optional()
			.describe(
				'Enable hallucination_guard checks on plan and implementation claims.',
			),
		sast_enabled: z
			.boolean()
			.optional()
			.describe('Enable SAST scanning as a required QA gate.'),
		mutation_test: z
			.boolean()
			.optional()
			.describe(
				'Enable the mutation-testing gate (default: off). Requires mutation ' +
					'tests to achieve a passing kill rate before phase completion; ' +
					'WARN verdict allows advancement, FAIL blocks.',
			),
		phase_council: z
			.boolean()
			.optional()
			.describe(
				'Enable the phase_council gate (default: off). When on, a full ' +
					'5-member council (critic, reviewer, sme, test_engineer, explorer) ' +
					'reviews all work completed in a phase holistically at phase_complete ' +
					'time. Requires council.enabled: true in config.',
			),
		drift_check: z
			.boolean()
			.optional()
			.describe(
				'Enable drift verification gate (default: on). Blocks phase_complete ' +
					'until drift-verifier.json has an approved verdict. When disabled, ' +
					'drift verification is skipped entirely.',
			),
		final_council: z
			.boolean()
			.optional()
			.describe(
				'Enable the final_council gate (default: off). When on, ' +
					'after all phases complete the architect dispatches critic, reviewer, ' +
					'sme, test_engineer, and explorer with project-scoped context, ' +
					'collects their CouncilMemberVerdict objects, and calls ' +
					'write_final_council_evidence. This is not General Council mode ' +
					'and does not require council.general.enabled.',
			),
		project_type: z
			.string()
			.optional()
			.describe(
				'Project type label (e.g. "ts", "python"). Only applied when the profile is being created for the first time.',
			),
		adopt_legacy_binding_only: z
			.boolean()
			.optional()
			.describe(
				'Operational recovery for upgraded legacy rows. When true, exact-binds the existing current-plan QA profile without changing any gates or its lock. Omit all gate booleans and project_type when using this action.',
			),
	},
	execute: async (args: unknown, directory: string) => {
		const typedArgs = (args ?? {}) as SetQaGatesArgs;
		return JSON.stringify(
			await executeSetQaGates(typedArgs, directory),
			null,
			2,
		);
	},
});
