/**
 * Tool to retrieve the last critic-approved immutable plan snapshot.
 *
 * Wraps `loadLastApprovedPlan` from `src/plan/ledger.ts` as a tool callable
 * by the critic `phase_drift_verifier` agent. Enables active baseline drift
 * comparison: the drift verifier can compare the immutable approved snapshot
 * against the current `plan.json` to detect silent plan mutations introduced
 * after approval.
 *
 * The tool internally derives `plan_id` from the current plan for
 * cross-identity safety — the caller does not need to know the format.
 *
 * Read-only: no file writes.
 *
 * @see https://github.com/zaxbysauce/opencode-swarm/issues/449
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { computeProfileHash, getProfile } from '../db/qa-gate-profile.js';
import {
	type ApprovedSnapshotInfo,
	computePlanHash,
	loadLastApprovedPlan,
} from '../plan/ledger';
import { loadPlanJsonOnly } from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import { createSwarmTool } from './create-tool';

// ============ Types ============

interface GetApprovedPlanResult {
	success: boolean;
	reason?: string;
	approved_plan?: ApprovedPlanPayload;
	current_plan?: CurrentPlanPayload | null;
	drift_detected?: boolean | 'unknown';
	current_plan_error?: string;
	/** SHA-256 hex digest over {plan_id, gates} of the current QA gate profile,
	 *  or null when no profile exists for this plan. Used by the critic to
	 *  detect silent gate mutations post-approval. */
	qa_profile_hash?: string | null;
}

interface ApprovedPlanPayload {
	plan: unknown;
	approval_metadata: Record<string, unknown> | undefined;
	snapshot_seq: number;
	snapshot_timestamp: string;
	payload_hash: string;
	/** The execution_profile from the approved snapshot, if any. */
	execution_profile?: {
		parallelization_enabled: boolean;
		max_concurrent_tasks: number;
		council_parallel: boolean;
		locked: boolean;
	} | null;
}

interface CurrentPlanPayload {
	plan: unknown;
	current_hash: string;
}

interface PlanSummary {
	title: string;
	swarm: string;
	current_phase: number;
	phase_count: number;
	phases: Array<{
		id: number;
		name: string;
		status: string;
		task_count: number;
	}>;
}

// ============ Core Logic ============

/**
 * Summarize a plan into structural metadata only (no full task descriptions).
 */
function summarizePlan(plan: {
	title: string;
	swarm: string;
	current_phase?: number;
	phases: Array<{
		id: number;
		name: string;
		status: string;
		tasks: unknown[];
	}>;
}): PlanSummary {
	return {
		title: plan.title,
		swarm: plan.swarm,
		current_phase: plan.current_phase ?? 0,
		phase_count: plan.phases.length,
		phases: plan.phases.map((p) => ({
			id: p.id,
			name: p.name,
			status: p.status,
			task_count: p.tasks.length,
		})),
	};
}

/**
 * Core execution logic — exported for direct testing.
 */
export async function executeGetApprovedPlan(
	args: { summary_only?: boolean },
	directory: string,
): Promise<GetApprovedPlanResult> {
	// Step 1: Load current plan to derive plan_id for cross-identity safety
	const currentPlan = await loadPlanJsonOnly(directory);

	// Step 2: If plan.json is unavailable, fail closed — never do an unscoped
	// snapshot read, as it could return a foreign plan identity's snapshot in
	// mixed-identity ledgers.
	if (!currentPlan) {
		// Attempt unscoped lookup ONLY to distinguish "no snapshots at all"
		// from "snapshots exist but we can't verify identity"
		const anySnapshot = await loadLastApprovedPlan(directory);
		if (anySnapshot) {
			return {
				success: true,
				approved_plan: undefined,
				current_plan: null,
				drift_detected: 'unknown',
				current_plan_error: 'plan.json not found or invalid',
			};
		}
		return {
			success: false,
			reason: 'no_approved_snapshot',
		};
	}

	const expectedPlanId = derivePlanId(currentPlan);

	// Compute QA gate profile hash for drift detection. Null when no profile
	// exists yet (e.g. brand-new plan). Profile hash is independent of plan
	// content — tracked so the critic can detect silent gate mutations.
	const profile = getProfile(directory, expectedPlanId);
	const qaProfileHash = profile ? computeProfileHash(profile) : null;

	// Step 3: Load the most recent critic-approved snapshot (identity-scoped)
	const approved: ApprovedSnapshotInfo | null = await loadLastApprovedPlan(
		directory,
		expectedPlanId,
	);

	// Step 4: If scoped lookup finds nothing, check if unscoped lookup would
	// find a snapshot — that means plan identity (swarm/title) was mutated
	// post-approval, which is itself a form of tampering.
	if (!approved) {
		const unscopedSnapshot = await loadLastApprovedPlan(directory);
		if (unscopedSnapshot) {
			return {
				success: true,
				approved_plan: undefined,
				current_plan: null,
				drift_detected: true,
				current_plan_error:
					'Plan identity (swarm/title) was mutated after approval — ' +
					`expected plan_id '${expectedPlanId}' but approved snapshot has a different identity. ` +
					'This is a form of plan tampering.',
				qa_profile_hash: qaProfileHash,
			};
		}
		return {
			success: false,
			reason: 'no_approved_snapshot',
			qa_profile_hash: qaProfileHash,
		};
	}

	const summaryOnly = args.summary_only === true;

	// Step 5: Build approved plan payload
	const approvedPayload: ApprovedPlanPayload = {
		plan: summaryOnly ? summarizePlan(approved.plan) : approved.plan,
		approval_metadata: approved.approval,
		snapshot_seq: approved.seq,
		snapshot_timestamp: approved.timestamp,
		payload_hash: approved.payloadHash,
		execution_profile: approved.plan.execution_profile ?? null,
	};

	// Step 6: Compare against current plan
	const currentHash = computePlanHash(currentPlan);
	const driftDetected = currentHash !== approved.payloadHash;

	const currentPayload: CurrentPlanPayload = {
		plan: summaryOnly ? summarizePlan(currentPlan) : currentPlan,
		current_hash: currentHash,
	};

	return {
		success: true,
		approved_plan: approvedPayload,
		current_plan: currentPayload,
		drift_detected: driftDetected,
		qa_profile_hash: qaProfileHash,
	};
}

// ============ Tool Definition ============

export const get_approved_plan: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Retrieve the last critic-approved immutable plan snapshot for baseline drift comparison. ' +
		'Returns the approved plan, its approval metadata, and optionally compares against ' +
		'the current plan.json to detect silent mutations. Read-only.',
	args: {
		summary_only: z
			.boolean()
			.optional()
			.describe(
				'When true, returns only structural metadata (title, phases, task counts) ' +
					'instead of full plan objects. Reduces output size for large plans.',
			),
	},
	execute: async (args: unknown, directory: string) => {
		const typedArgs = args as { summary_only?: boolean };
		return JSON.stringify(
			await executeGetApprovedPlan(typedArgs, directory),
			null,
			2,
		);
	},
});
