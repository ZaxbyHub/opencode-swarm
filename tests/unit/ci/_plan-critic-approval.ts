/**
 * Plan-critic approval helper for advisory-CI tests (issue #2497).
 *
 * Records a plan-critic approval through the repo's own writers
 * (initLedger + forceRecordPlanCriticApproval) so the satisfying fixture's
 * ledger/DB state is produced by production code paths, not hand-written
 * files.
 */

import {
	forceRecordPlanCriticApproval,
	isPlanCriticApproved,
} from '../../../src/hooks/delegation-gate.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { loadPlanJsonOnly } from '../../../src/plan/manager.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import { ensureAgentSession } from '../../../src/state.js';

export async function forceRecordPlanCriticApprovedForTests(
	dir: string,
): Promise<void> {
	const plan = await loadPlanJsonOnly(dir);
	if (!plan) throw new Error('fixture regression: plan.json unreadable');
	await initLedger(dir, derivePlanId(plan));
	ensureAgentSession('fixture-architect-2497-tests', 'architect');
	await forceRecordPlanCriticApproval(dir, 'fixture-architect-2497-tests', {
		reason: 'ci2497 test fixture pre-approval',
		userConfirmed: true,
	});
	const approved = await isPlanCriticApproved(dir);
	if (!approved) {
		throw new Error('fixture regression: plan-critic approval not recorded');
	}
}
