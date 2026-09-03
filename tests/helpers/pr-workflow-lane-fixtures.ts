/**
 * Shared fixtures for the PR-workflow lane settlement suites (issue #2251).
 *
 * Extracted from `tests/unit/hooks/pr-workflow-gate-stale-lane-settlement.test.ts`,
 * where they were module-local. The liveness-probe suites need the identical
 * three primitives, and that file already sits at ~90% of the FR-006 500-line
 * cap, so copying ~80 lines into each new file would have crowded them against
 * it for no benefit.
 *
 * `backdatePrWorkflowLane` reads `Date.now()` on purpose: every caller freezes
 * the clock with `freezeClock()` first, so the age margin it produces is exact.
 * (This file is not a `*.test.ts`, so it is outside `check-test-clock.sh`'s
 * scan; the obligation to freeze belongs to the suites that call in.)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	type BackgroundDelegationRecord,
	DEFAULT_STALE_DELEGATION_TIMEOUT_MS,
	readDelegations,
	recordPendingDelegation,
} from '../../src/background/pending-delegations.js';
import {
	_test_exports as gateInternals,
	type PrWorkflowGateState,
} from '../../src/hooks/pr-workflow-gate.js';

/** A lane age comfortably past the settlement horizon. */
export const STALE_LANE_AGE_MS = DEFAULT_STALE_DELEGATION_TIMEOUT_MS + 60_000;

/** Write a raw gate-state record straight to disk (mirrors the abort suite). */
export async function writeRawPrWorkflowGateState(
	directory: string,
	sessionID: string,
	partial: Partial<PrWorkflowGateState>,
): Promise<void> {
	const relative = gateInternals.workflowGateStateRelativePath(sessionID);
	const absolute = path.join(directory, '.swarm', relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const base: PrWorkflowGateState = {
		schemaVersion: 1,
		revision: 0,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
	};
	await fs.writeFile(
		absolute,
		JSON.stringify({ ...base, ...partial }, null, 2),
		'utf-8',
	);
}

/**
 * Record one open `swarm-pr-review:base` lane for `parentSessionId`.
 *
 * PR-review delegation records use the correlation id as the authenticated
 * child session id. The liveness helper below remains a named fixture seam
 * so callers use the same identity when building host-status maps.
 */
export async function recordOpenPrWorkflowLane(
	directory: string,
	parentSessionId: string,
	laneId: string,
	correlationId: string,
): Promise<void> {
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId,
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'b1',
		laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: laneId,
		workspace: {
			directory,
			gitHead: 'abc123',
			dirtyHash: null,
			prHeadSha: 'abc123',
			scope: null,
		},
	});
}

/** The subagent session id {@link recordOpenPrWorkflowLane} assigns. */
export function laneSubagentSessionId(correlationId: string): string {
	return correlationId;
}

/**
 * Backdate a lane's `updatedAt` past the staleness horizon by appending a
 * replacement snapshot — the store folds last-write-wins per correlationId, so
 * this is the same shape a real record takes when its process stops updating.
 */
export async function backdatePrWorkflowLane(
	directory: string,
	correlationId: string,
	ageMs: number,
	status?: BackgroundDelegationRecord['status'],
): Promise<void> {
	const record = readDelegations(directory).find(
		(candidate) => candidate.correlationId === correlationId,
	) as BackgroundDelegationRecord;
	await appendDelegationTransition(directory, correlationId, {
		status: status ?? record.status,
		updatedAt: Date.now() - ageMs,
	});
}

/** The durable status of one lane record, or `undefined` if absent. */
export function laneStatusOnDisk(
	directory: string,
	correlationId: string,
): BackgroundDelegationRecord['status'] | undefined {
	return readDelegations(directory).find(
		(record) => record.correlationId === correlationId,
	)?.status;
}
