/**
 * Tool to configure the QA gate profile for the current plan.
 *
 * Architect-only: invoked during the QA GATE SELECTION phase of brainstorm
 * mode (or equivalent). Ratchet-tighter only — cannot disable gates that are
 * already enabled. Rejects all writes once the profile is locked.
 *
 * Creates the profile with defaults if missing, then applies the requested
 * partial update.
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
	computeProfileHash,
	getOrCreateProfile,
	type QaGates,
	setGates,
} from '../db/qa-gate-profile.js';
import { loadPlanJsonOnly } from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import { createSwarmTool } from './create-tool';

export interface SetQaGatesArgs {
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
	if (!plan) {
		return {
			success: false,
			reason: 'plan_json_unavailable',
			message:
				'Cannot configure QA gates: plan.json is missing or invalid. ' +
				'Create a plan first (e.g. via /swarm specify or save_plan).',
		};
	}
	const planId = derivePlanId(plan);

	// Ensure the profile exists with defaults before applying changes.
	getOrCreateProfile(directory, planId, args.project_type);

	const partial: Partial<QaGates> = {};
	for (const key of [
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
	] as Array<keyof QaGates>) {
		if (args[key] !== undefined) partial[key] = args[key] as boolean;
	}

	try {
		const updated = setGates(directory, planId, partial);
		return {
			success: true,
			plan_id: planId,
			message: `QA gates updated for plan_id=${planId}`,
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
		if (lower.includes('locked')) reason = 'profile_locked';
		else if (lower.includes('ratchet')) reason = 'ratchet_violation';
		return {
			success: false,
			reason,
			message: msg,
			plan_id: planId,
		};
	}
}

export const set_qa_gates: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Configure the QA gate profile for the current plan. Architect-only. ' +
		'Ratchet-tighter: can enable additional gates but cannot disable gates ' +
		'that are already enabled. Rejects all writes once the profile is ' +
		'locked (after critic approval). Creates the profile with defaults if ' +
		'none exists. plan_id is derived automatically from plan.json.',
	args: {
		reviewer: z
			.boolean()
			.optional()
			.describe('Enable the reviewer gate (true) — cannot be disabled.'),
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
