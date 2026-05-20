/**
 * Tool to retrieve the QA gate profile for the current plan.
 *
 * Read-only: derives plan_id from plan.json, then looks up the profile in the
 * per-project DB. Returns the spec-level profile gates, lock state, and profile
 * hash. Callers layering session overrides should combine with
 * `getEffectiveGates` themselves — this tool intentionally returns the
 * persisted/locked spec-level view.
 */

import type { tool } from '@opencode-ai/plugin';
import { computeProfileHash, getProfile } from '../db/qa-gate-profile.js';
import { loadPlanJsonOnly } from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import { createSwarmTool } from './create-tool';

interface GetQaGateProfileResult {
	success: boolean;
	reason?: string;
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
	_args: Record<string, unknown>,
	directory: string,
): Promise<GetQaGateProfileResult> {
	const plan = await loadPlanJsonOnly(directory);
	if (!plan) {
		return {
			success: false,
			reason: 'plan_json_unavailable',
		};
	}
	const planId = derivePlanId(plan);
	const profile = getProfile(directory, planId);
	if (!profile) {
		return {
			success: false,
			reason: 'no_profile',
			plan_id: planId,
		};
	}
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
		'create a profile if none exists. plan_id is derived automatically from ' +
		'plan.json (swarm + title).',
	args: {},
	execute: async (args: unknown, directory: string) => {
		const typedArgs = (args ?? {}) as Record<string, unknown>;
		return JSON.stringify(
			await executeGetQaGateProfile(typedArgs, directory),
			null,
			2,
		);
	},
});
