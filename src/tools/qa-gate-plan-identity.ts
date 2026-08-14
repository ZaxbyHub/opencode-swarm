import { derivePlanId } from '../plan/utils.js';

export interface QaGatePlanIdentityArgs {
	swarm_id?: string;
	plan_title?: string;
	confirm_identity_change?: boolean;
}

interface PlanIdentity {
	swarm: string;
	title: string;
}

export type QaGatePlanIdentityResolution =
	| { success: true; planId: string; identity: PlanIdentity }
	| { success: false; reason: string; message: string };

/**
 * Resolve the QA profile identity before or after plan.json exists.
 *
 * Explicit identity is all-or-nothing. Values are checked for non-whitespace
 * content but are otherwise preserved exactly when deriving the plan id. When
 * a plan already exists, a different exact swarm/title pair requires the same
 * explicit replacement confirmation used by save_plan.
 */
export function resolveQaGatePlanIdentity(
	plan: PlanIdentity | null,
	args: QaGatePlanIdentityArgs,
): QaGatePlanIdentityResolution {
	const hasSwarmId = args.swarm_id !== undefined;
	const hasPlanTitle = args.plan_title !== undefined;

	if (hasSwarmId !== hasPlanTitle) {
		return {
			success: false,
			reason: 'plan_identity_incomplete',
			message:
				'QA gate identity is incomplete: provide both swarm_id and plan_title, or neither when using the current plan.',
		};
	}

	if (!hasSwarmId && !hasPlanTitle) {
		if (!plan) {
			return {
				success: false,
				reason: 'plan_identity_required',
				message:
					'Cannot resolve QA gate identity before plan.json exists. Provide both swarm_id and plan_title.',
			};
		}
		return { success: true, planId: derivePlanId(plan), identity: plan };
	}

	const swarmId = args.swarm_id;
	const planTitle = args.plan_title;
	if (
		typeof swarmId !== 'string' ||
		swarmId.trim().length === 0 ||
		typeof planTitle !== 'string' ||
		planTitle.trim().length === 0
	) {
		return {
			success: false,
			reason: 'plan_identity_invalid',
			message:
				'QA gate identity is invalid: swarm_id and plan_title must both contain non-whitespace text.',
		};
	}

	if (
		plan &&
		(plan.swarm !== swarmId || plan.title !== planTitle) &&
		args.confirm_identity_change !== true
	) {
		return {
			success: false,
			reason: 'plan_identity_mismatch',
			message:
				'The explicit QA gate identity does not exactly match the current plan. Verify swarm_id and plan_title, or set confirm_identity_change: true for an intentional replacement.',
		};
	}

	return {
		success: true,
		planId: derivePlanId({ swarm: swarmId, title: planTitle }),
		identity: { swarm: swarmId, title: planTitle },
	};
}
