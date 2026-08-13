/**
 * Tool to retrieve a QA gate profile for the current or future plan.
 *
 * Read-only: uses plan.json identity when available or an explicit exact
 * swarm/title pair before plan creation, then looks up the profile in the
 * per-project DB. Returns the spec-level profile gates, lock state, and profile
 * hash. Callers layering session overrides should combine with
 * `getEffectiveGates` themselves — this tool intentionally returns the
 * persisted/locked spec-level view.
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	computeProfileHash,
	getProfileLookupForIdentity,
} from '../db/qa-gate-profile.js';
import { loadPlanJsonOnly } from '../plan/manager';
import { formatLegacyQaBindingRecovery } from '../qa-gate/recovery.js';
import { createSwarmTool } from './create-tool';
import {
	type QaGatePlanIdentityArgs,
	resolveQaGatePlanIdentity,
} from './qa-gate-plan-identity.js';

export type GetQaGateProfileArgs = QaGatePlanIdentityArgs;

interface GetQaGateProfileResult {
	success: boolean;
	reason?: string;
	message?: string;
	plan_id?: string;
	profile?: {
		plan_id: string;
		project_type: string | null;
		gates: Record<string, boolean>;
		locked_at: string | null;
		locked_by_snapshot_seq: number | null;
		created_at: string;
		profile_hash: string;
	};
}

export async function executeGetQaGateProfile(
	args: GetQaGateProfileArgs,
	directory: string,
): Promise<GetQaGateProfileResult> {
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
	const lookup = getProfileLookupForIdentity(directory, identity.identity);
	if (lookup.kind === 'missing') {
		return {
			success: false,
			reason: 'no_profile',
			plan_id: planId,
		};
	}
	if (lookup.kind === 'unbound_legacy') {
		return {
			success: false,
			reason: 'plan_identity_unbound',
			plan_id: planId,
			message: `The current plan has a legacy QA gate profile row that is not exact-bound. ${formatLegacyQaBindingRecovery(identity.identity, 'retry this read-only QA profile lookup')}`,
		};
	}
	const profile = lookup.profile;
	return {
		success: true,
		plan_id: planId,
		profile: {
			plan_id: profile.plan_id,
			project_type: profile.project_type,
			gates: { ...profile.gates },
			locked_at: profile.locked_at,
			locked_by_snapshot_seq: profile.locked_by_snapshot_seq,
			created_at: profile.created_at,
			profile_hash: computeProfileHash(profile),
		},
	};
}

export const get_qa_gate_profile: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Retrieve the QA gate profile for the current plan. Returns the spec-level ' +
		'gates, lock state, and a SHA-256 profile hash. Read-only — does not ' +
		'create a profile if none exists. Uses the current plan identity by default, ' +
		'or an exact swarm_id + plan_title pair before plan.json exists.',
	args: {
		swarm_id: z
			.string()
			.refine((value) => value.trim().length > 0, 'Must not be blank')
			.optional()
			.describe(
				'Exact swarm identity for a pre-plan profile lookup. Must be provided with plan_title.',
			),
		plan_title: z
			.string()
			.refine((value) => value.trim().length > 0, 'Must not be blank')
			.optional()
			.describe(
				'Exact future plan title for a pre-plan profile lookup. Must be provided with swarm_id.',
			),
		confirm_identity_change: z
			.boolean()
			.optional()
			.describe(
				'Confirm that an explicit swarm_id/plan_title pair intentionally replaces the current plan identity.',
			),
	},
	execute: async (args: unknown, directory: string) => {
		const typedArgs = (args ?? {}) as GetQaGateProfileArgs;
		return JSON.stringify(
			await executeGetQaGateProfile(typedArgs, directory),
			null,
			2,
		);
	},
});
