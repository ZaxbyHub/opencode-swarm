import { expect, mock } from 'bun:test';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	findByBatchId,
} from '../../../src/background/pending-delegations.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const originalLoadPluginConfig = dispatchInternals.loadPluginConfig;

export function installLegacyPrReviewPolicy(): void {
	dispatchInternals.loadPluginConfig = (directory) => ({
		...originalLoadPluginConfig(directory),
		pr_review_resilience: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
}

export function restorePrReviewPolicy(): void {
	dispatchInternals.loadPluginConfig = originalLoadPluginConfig;
}

export function uniqueSessionOps(): void {
	let sessionIndex = 0;
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `tier-lane-session-${sessionIndex++}` },
		})),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
}

/**
 * Issue #3644 AC2 harness helper: settle every lane of an already-dispatched
 * swarm-pr-review:base batch with one [CANDIDATE] row per dimension so micro
 * admission's assertPrReviewBaseCoverageSettled sees COMPLETE terminal
 * coverage. Mirrors the canonical hooks fixtures' persistBatch settle shape;
 * the dispatch-created records must carry pr_review_legacy_transcript_
 * compatibility (enable it around the seed dispatch) for the transcript rows
 * to credit.
 */
export async function settleDispatchedBaseLanes(
	directory: string,
	batchId: string,
	session: string,
	options: { expectedLaneCount: number; revisionDigest: string; scope: string },
): Promise<void> {
	const records = findByBatchId(directory, batchId, session);
	expect(records.length).toBe(options.expectedLaneCount);
	for (const record of records) {
		const dimension = record.workflowLane ?? '';
		const text = `${CANDIDATE_HEADERS.base_explorer}\nC-${dimension} | ${dimension} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `;
		const stored = storeLaneOutput(directory, {
			batchId,
			laneId: record.laneId ?? '',
			agent: record.swarmPrefixedAgent ?? 'explorer',
			role: record.normalizedAgent ?? 'explorer',
			sessionId: record.subagentSessionId ?? '',
			parentSessionId: session,
			mode: 'swarm-pr-review:base',
			workflowLane: dimension,
			prHeadSha: 'abc123',
			gitHead: 'abc123',
			revisionDigest: options.revisionDigest,
			scope: options.scope,
			source: 'collect_lane_results',
			text,
		});
		await appendDelegationTransition(directory, record.correlationId ?? '', {
			status: 'completed',
			result: {
				text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				...(stored.ref ? { outputRef: stored.ref } : {}),
			},
		});
	}
}
