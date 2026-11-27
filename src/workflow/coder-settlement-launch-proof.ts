/**
 * Durable launch-finished proof for one exact coder dispatch, read from the
 * shared coder-settlement WAL (the 2026-11-27 task 2.18 stale
 * background-coder-reservation wedge).
 *
 * Wild failure (consumer-project, 2026-11-27): a background repair
 * coder finished its work and the architect durably settled its coder
 * settlement — `.swarm/coder-settlements/2.18.json` at `state: 'COMMITTED'`,
 * `accepted: true`, `transitionId: 'coder:<callID>'` — but the delegation
 * store's owner record never observed the child terminal (it stayed
 * `pending` with no terminalResult; the store's `lastTerminalAt` predated the
 * dispatch). The reservation logic that guards per-task capacity consults
 * ONLY that delegation record: the maintenance sweep kept renewing the
 * reservation lease ("exact owner record still active") and every redispatch
 * of the task was refused as `duplicate_task` — the wedge extended itself,
 * with no lease-based escape (task-keyed reservation ids are minted per
 * parent+task, so a fresh call id resolves to the SAME reservation).
 *
 * This module is the bridge: the same durable receipt the #2828
 * settlement-wedge recovery reads (`latestCommittedAcceptedSettlementMs`) is
 * a launch-finished proof for reservation release. Kept in its own module to
 * avoid the pending-delegations ↔ coder-settlement import cycle
 * (coder-settlement.ts already imports from pending-delegations.ts); it
 * depends only on the shared WAL file reader and schema parser.
 */

import { validateSwarmPath } from '../hooks/utils.js';
import { readWorkflowWalFile } from './workflow-wal-file.js';

function launchSettlementWalPath(directory: string, taskId: string): string {
	return validateSwarmPath(directory, `coder-settlements/${taskId}.json`);
}

/**
 * True iff the coder-settlement WAL for `taskId` durably proves the launch
 * identified by `transitionId` is finished and accepted:
 *
 * - the WAL exists and parses (a missing/corrupt WAL proves nothing);
 * - `state === 'COMMITTED'` (the architect settled the dispatch);
 * - `accepted === true` (the settlement attributed acceptance — the same bar
 *   as `latestCommittedAcceptedSettlementMs` and the #2828 recovery);
 * - `transitionId` matches EXACTLY, so a settlement for any other dispatch
 *   of the task (a newer launch's PREPARED/DISPATCHED WAL, an older call's
 *   COMMITTED) never proves THIS launch idle.
 *
 * Fail-closed by construction: every other shape returns false and the
 * caller keeps the reservation.
 */
export async function isCommittedAcceptedSettlementForLaunch(
	directory: string,
	taskId: string,
	transitionId: string,
): Promise<boolean> {
	if (!taskId || !transitionId) return false;
	try {
		const wal = await readWorkflowWalFile(
			'coder-settlement',
			launchSettlementWalPath(directory, taskId),
			taskId,
		);
		if (wal === null) return false;
		return (
			wal.state === 'COMMITTED' &&
			wal.accepted === true &&
			wal.transitionId === transitionId
		);
	} catch {
		// Unreadable/oversized/mismatched WAL: not a proof. The reservation
		// stays; the WAL's own remediation surfaces elsewhere.
		return false;
	}
}
