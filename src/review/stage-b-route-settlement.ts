import {
	readTaskGateRequirementsReceiptsSync,
	routeEvidenceFromTaskGateRequirements,
} from '../evidence/task-gate-requirements.js';
import {
	type AgentSessionState,
	stageBRouteEvidenceForSettlement,
} from '../state.js';
import {
	enforcePersistedReviewRouteReceipt,
	type ReviewRouteEvidence,
} from './routing-enforcement.js';

/**
 * Evaluate Stage-B route completeness against the durable siblings visible
 * while the task evidence lock is held. The current completion replaces an
 * older same-identity durable row; pending live reservations never count.
 * Unreadable durable evidence fails closed.
 */
export function isStageBRouteCompleteAtSettlement(input: {
	directory: string;
	session: AgentSessionState;
	sessionId: string;
	taskId: string;
	current: ReviewRouteEvidence;
	legacyUnrouted: boolean;
	testEngineerExempt: boolean;
}): boolean {
	let durable: ReviewRouteEvidence[];
	try {
		durable = routeEvidenceFromTaskGateRequirements(
			readTaskGateRequirementsReceiptsSync(input.directory, input.taskId),
		);
	} catch {
		return false;
	}
	const receipts = stageBRouteEvidenceForSettlement(
		input.session,
		input.taskId,
		durable,
		input.current,
	);
	return enforcePersistedReviewRouteReceipt({
		projectRoot: input.directory,
		sessionId: input.sessionId,
		taskId: input.taskId,
		receipts,
		enforcementEnabled: true,
		legacyUnrouted: input.legacyUnrouted,
		requireEvidenceBindings: true,
		requireCompleteEvidence: true,
		testEngineerExempt: input.testEngineerExempt,
	}).canAdvance;
}
