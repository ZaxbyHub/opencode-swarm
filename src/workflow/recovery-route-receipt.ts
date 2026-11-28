import {
	isTestEngineerDurablyExempt,
	readTaskEvidenceRaw,
} from '../gate-evidence.js';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
	readReviewRouteReceiptSync,
} from '../review/routing-enforcement.js';

/**
 * 2026-11-25 swarm_communication_debug (task 2.26): the recover_* openings
 * (recover_rework_task / the stage-a-repair settlement arm) admit a fresh
 * Stage-B cycle, but the v1 review route receipt is only ever written by the
 * DISPATCH-time allocator. A recovered task whose Stage-B dispatches bind
 * through the legacy-unrouted admission (or whose receipt later becomes
 * unreadable) then wedges at tests_run with every gate bound: the completion
 * gate fails closed on "has not satisfied its exact v1 review route receipt"
 * while no agent-legal path can re-materialize the artifact — /swarm recover
 * is itself blocked by the completion guard at tests_run.
 *
 * The recovery opening now materializes a BASELINE receipt itself: the
 * single-complexity slot floor (one reviewer identity, one test-engineer
 * identity unless the durable evidence proves the exemption) — the same
 * shape the dispatch allocator produces for a standard change and exactly
 * what the live recovered task carried. It is written ONLY when no readable
 * receipt exists: an existing valid receipt is never overwritten (the
 * dispatch-time allocator owns real routing counts), and an unreadable one
 * is replaced precisely because it is the wedge. A later Stage-B dispatch
 * overwrites the baseline with its routed counts as usual.
 */
export async function ensureRecoveryRouteReceipt(input: {
	directory: string;
	taskId: string;
	sessionId: string;
}): Promise<boolean> {
	const { directory, taskId, sessionId } = input;
	if (!directory || !taskId || !sessionId) return false;
	try {
		const existing = readReviewRouteReceiptSync({
			projectRoot: directory,
			sessionId,
			taskId,
		});
		if (existing !== null) return true;
	} catch {
		// An unreadable/corrupt receipt (bad MAC, invalid JSON, redirected
		// path) is exactly the wedge this recovery repairs — fall through and
		// replace it with a fresh baseline receipt.
	}
	let testEngineerExempt = false;
	try {
		testEngineerExempt = isTestEngineerDurablyExempt(
			readTaskEvidenceRaw(directory, taskId),
		);
	} catch {
		// Unreadable evidence keeps the non-exempt floor (fail-closed: the
		// TE slot stays required until durable proof says otherwise).
	}
	const receipt = buildReviewRouteReceipt({
		sessionId,
		taskId,
		complexity: 'single',
		semanticRisk:
			'Recovery baseline route receipt (dispatch-time routing overwrites with routed counts)',
		requiredReviewers: [`${taskId}:reviewer:1`],
		requiredTestEngineers: testEngineerExempt
			? []
			: [`${taskId}:test_engineer:1`],
	});
	try {
		await persistReviewRouteReceipt({ projectRoot: directory, receipt });
	} catch {
		// Best-effort by contract: a failed write keeps the pre-recovery
		// behavior (completion fails closed on the missing receipt) instead
		// of failing the recovery transition itself.
		return false;
	}
	return true;
}
