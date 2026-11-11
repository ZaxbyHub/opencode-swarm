/**
 * Issue #3358 AC4 feedback-round legs (F-003 wedge + receipt-covered variant,
 * FB-009 disclosure widening/ordering), split out of
 * verdict-semantics-cap-independence-3358.test.ts for FR-006 (500-line cap).
 * Same fixtures; the parent suite owns the shared CONFIRMED_NONE_TEXT shape.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	buildVerdictSettlementReceipt,
	persistVerdictSettlementReceipt,
	verdictSettlementRelativePath,
} from '../../../src/pr-review/verdict-settlement.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
const lanes = [
	{ laneId: 'lane-1', workflowLane: 'lane-1', reviewItemIds: ITEM_IDS },
];
const CONFIRMED_NONE_TEXT = ITEM_IDS.map(
	(itemId) =>
		`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
).join('\n');

describe('semantics-mismatch bypass probe + FB-009 disclosure legs (#3358 feedback round)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('the bypass probe keeps a semantics-mismatched phase unsettled (F-003)', async () => {
		// The F-003 wedge is REACHABLE via multi-owner items: one COMPLETED
		// owner lane carries the v1 CONFIRMED+NONE row (completed records pass
		// batch integrity, so the row is visible and disclosed), while two
		// typed-dead sibling retries satisfy admission (completed owners are
		// consumed attempts, not blockers). Without the probe mirror the item
		// probes admissible, the bypass arm is skipped, and the settlement
		// guard re-throws with no INCOMPLETE exit. The mirror is LOAD-BEARING.
		await establishReviewPrerequisites();
		// A live successful batch claims every OTHER item with valid v2 rows,
		// so the only unclaimed item is the semantics-mismatched one.
		const liveLanes = [
			{
				laneId: 'fb003-live-lane',
				workflowLane: 'fb003-live-lane',
				reviewItemIds: ITEM_IDS.slice(1),
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			liveLanes,
			{ batchId: 'fb003-live', prHeadSha: HEAD_SHA },
		);
		await persistBatch('fb003-live', 'swarm-pr-review:reviewer', liveLanes, {
			textOverride: ITEM_IDS.slice(1)
				.map(
					(itemId) =>
						`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
				)
				.join(String.fromCharCode(10)),
		});
		// Owner 1: a COMPLETED lane whose only row for C-0 is v1
		// CONFIRMED+NONE - visible to composition, disclosed as a mismatch,
		// never a claim.
		const visibleLanes = [
			{
				laneId: 'fb003-vis-lane',
				workflowLane: 'fb003-vis-lane',
				reviewItemIds: ['C-0'],
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			visibleLanes,
			{ batchId: 'fb003-vis', prHeadSha: HEAD_SHA },
		);
		await persistBatch('fb003-vis', 'swarm-pr-review:reviewer', visibleLanes, {
			textOverride: `[REVIEWED] | C-0 | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale C-0 | probe C-0 | reviewer | UNKNOWN | `,
		});
		// Owners 2 and 3: typed-dead sibling retries (per-item retry budget is
		// 1 + PR_REVIEW_VERDICT_RETRY_BUDGET = 3 declaring batches).
		const { createHash } = await import('node:crypto');
		const { recordPendingDelegation, appendDelegationTransition } =
			await import('../../../src/background/pending-delegations.js');
		for (let i = 0; i < 2; i += 1) {
			const batchId = `fb003-dead-${i}`;
			const laneId = `${batchId}-lane`;
			const correlationId = `${batchId}-${laneId}-session`;
			const staleReason = `lane ${laneId} presumed stale: idle host session past the stale horizon`;
			await recordPendingDelegation(tempDir, {
				correlationId,
				jobId: null,
				subagentSessionId: correlationId,
				parentSessionId: SESSION_ID,
				callID: `${batchId}-${laneId}-call`,
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'reviewer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId,
				laneId,
				mode: 'swarm-pr-review:reviewer',
				prReviewLegacyTranscriptCompatibility: true,
				workflowLane: laneId,
				workspace: {
					directory: tempDir,
					gitHead: HEAD_SHA,
					dirtyHash: null,
					prHeadSha: HEAD_SHA,
					scope: 'complete PR diff def456...abc123',
				},
			});
			await appendDelegationTransition(tempDir, correlationId, {
				status: 'stale',
				result: {
					error: staleReason,
					chars: staleReason.length,
					truncated: false,
					digest: createHash('sha256').update(staleReason).digest('hex'),
					workflowLaneFailureClass: 'liveness' as const,
				},
			});
			const deadLanes = [
				{ laneId, workflowLane: laneId, reviewItemIds: ['C-0'] },
			];
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				deadLanes,
				{ batchId, prHeadSha: HEAD_SHA },
			);
		}
		_test_exports.resetTrackedStateCache();
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		if (!state) throw new Error('fixture gate state missing');
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.unclaimed).toEqual(['C-0']);
		expect(composed.semanticsMismatchedItemIds).toEqual(['C-0']);
		const { deriveVerdictSettlementAdmission } = await import(
			'../../../src/pr-review/verdict-settlement.js'
		);
		const admission = deriveVerdictSettlementAdmission({
			directory: tempDir,
			prHeadSha: HEAD_SHA,
			phase: 'reviewer',
			window: _test_exports.prReviewPhaseWindow(state, 'reviewer'),
			unclaimed: composed.unclaimed,
			parentSessionId: SESSION_ID,
		});
		// Reachability proof: with the completed row carrier plus the two
		// typed-dead siblings, N-of-M admission ADMITS the item.
		expect(admission.admitted).toBe(true);
		const ctx = { revisionDigest: 'revision-test' } as never;
		const probe = _test_exports.probeIncompleteBypassComposablePhase(
			tempDir,
			state,
			ctx,
			'reviewer',
			_test_exports.prReviewPhaseWindow(state, 'reviewer'),
		);
		expect(probe.settled).toBe(false);
		// The mirror must override that admission: the phase probes NOT
		// admissible, so completion's INCOMPLETE bypass arm fires and discloses
		// the item as skipped instead of wedging on the settlement guard.
		expect(probe.admissible).toBe(false);
		expect(probe.unsettledItemIds).toContain('C-0');
	});

	test('a receipt-covered mismatch still probes unsettled (re-gate Finding 1)', async () => {
		// The F-003 wedge is REACHABLE via multi-owner items: one COMPLETED
		// owner lane carries the v1 CONFIRMED+NONE row (completed records pass
		// batch integrity, so the row is visible and disclosed), while two
		// typed-dead sibling retries satisfy admission (completed owners are
		// consumed attempts, not blockers). Without the probe mirror the item
		// probes admissible, the bypass arm is skipped, and the settlement
		// guard re-throws with no INCOMPLETE exit. The mirror is LOAD-BEARING.
		await establishReviewPrerequisites();
		// A live successful batch claims every OTHER item with valid v2 rows,
		// so the only unclaimed item is the semantics-mismatched one.
		const liveLanes = [
			{
				laneId: 'fb003-live-lane',
				workflowLane: 'fb003-live-lane',
				reviewItemIds: ITEM_IDS.slice(1),
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			liveLanes,
			{ batchId: 'fb003-live', prHeadSha: HEAD_SHA },
		);
		await persistBatch('fb003-live', 'swarm-pr-review:reviewer', liveLanes, {
			textOverride: ITEM_IDS.slice(1)
				.map(
					(itemId) =>
						`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
				)
				.join(String.fromCharCode(10)),
		});
		// Owner 1: a COMPLETED lane whose only row for C-0 is v1
		// CONFIRMED+NONE - visible to composition, disclosed as a mismatch,
		// never a claim.
		const visibleLanes = [
			{
				laneId: 'fb003-vis-lane',
				workflowLane: 'fb003-vis-lane',
				reviewItemIds: ['C-0'],
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			visibleLanes,
			{ batchId: 'fb003-vis', prHeadSha: HEAD_SHA },
		);
		await persistBatch('fb003-vis', 'swarm-pr-review:reviewer', visibleLanes, {
			textOverride: `[REVIEWED] | C-0 | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale C-0 | probe C-0 | reviewer | UNKNOWN | `,
		});
		// Owners 2 and 3: typed-dead sibling retries (per-item retry budget is
		// 1 + PR_REVIEW_VERDICT_RETRY_BUDGET = 3 declaring batches).
		const { createHash } = await import('node:crypto');
		const { recordPendingDelegation, appendDelegationTransition } =
			await import('../../../src/background/pending-delegations.js');
		for (let i = 0; i < 2; i += 1) {
			const batchId = `fb003-dead-${i}`;
			const laneId = `${batchId}-lane`;
			const correlationId = `${batchId}-${laneId}-session`;
			const staleReason = `lane ${laneId} presumed stale: idle host session past the stale horizon`;
			await recordPendingDelegation(tempDir, {
				correlationId,
				jobId: null,
				subagentSessionId: correlationId,
				parentSessionId: SESSION_ID,
				callID: `${batchId}-${laneId}-call`,
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'reviewer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId,
				laneId,
				mode: 'swarm-pr-review:reviewer',
				prReviewLegacyTranscriptCompatibility: true,
				workflowLane: laneId,
				workspace: {
					directory: tempDir,
					gitHead: HEAD_SHA,
					dirtyHash: null,
					prHeadSha: HEAD_SHA,
					scope: 'complete PR diff def456...abc123',
				},
			});
			await appendDelegationTransition(tempDir, correlationId, {
				status: 'stale',
				result: {
					error: staleReason,
					chars: staleReason.length,
					truncated: false,
					digest: createHash('sha256').update(staleReason).digest('hex'),
					workflowLaneFailureClass: 'liveness' as const,
				},
			});
			const deadLanes = [
				{ laneId, workflowLane: laneId, reviewItemIds: ['C-0'] },
			];
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				deadLanes,
				{ batchId, prHeadSha: HEAD_SHA },
			);
		}

		// A durable reviewer settlement receipt covering the mismatched item,
		// anchored on state via prReviewVerdictSettlementDigests. Pre-fix the
		// receipt shortcut ran before the mirror and reported settled:true.
		const receipt = buildVerdictSettlementReceipt({
			runId: 'test-run',
			prHeadSha: HEAD_SHA,
			revisionDigest: 'revision-test',
			phase: 'reviewer',
			items: [
				{
					itemId: 'C-0',
					sourceBatchId: 'fb003-vis',
					sourceLaneId: 'fb003-vis-lane',
					disposition: 'liveness_dead',
					evidenceClass: 'liveness',
					terminalStatus: 'stale',
				},
			],
		});
		await persistVerdictSettlementReceipt(tempDir, receipt);
		const receiptAbs = join(
			tempDir,
			'.swarm',
			verdictSettlementRelativePath('test-run', 'reviewer'),
		);
		const receiptDigest = createHash('sha256')
			.update(await fs.readFile(receiptAbs))
			.digest('hex');
		const prior = await readPrWorkflowGateState(tempDir, SESSION_ID);
		if (!prior) throw new Error('fixture gate state missing');
		await writeAuthoritativePrWorkflowState(tempDir, {
			...(prior as unknown as Record<string, unknown>),
			sessionID: SESSION_ID,
			revision: (prior.revision ?? 0) + 1,
			mode: 'PR_REVIEW',
			prReviewVerdictSettlementDigests: { reviewer: receiptDigest },
		} as never);
		_test_exports.resetTrackedStateCache();
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		if (!state) throw new Error('fixture gate state missing after anchor');
		const ctx = { revisionDigest: 'revision-test' } as never;
		const probe = _test_exports.probeIncompleteBypassComposablePhase(
			tempDir,
			state,
			ctx,
			'reviewer',
			_test_exports.prReviewPhaseWindow(state, 'reviewer'),
		);
		expect(probe.settled).toBe(false);
		expect(probe.admissible).toBe(false);
		expect(probe.unsettledItemIds).toContain('C-0');
	});

	test('FB-009: a multi-row item is disclosed even when a second row exists', async () => {
		// An item carrying an earlier-semantics row PLUS a second row never
		// claims (multi-row) and must still be disclosed: pre-FB-009 only the
		// lone-row shape was disclosed.
		await establishReviewPrerequisites();
		const multiText = ITEM_IDS.filter((id) => id !== 'C-0').map(
			(itemId) =>
				`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
		);
		const multiLanes = [
			{
				laneId: 'fb009-multi-lane',
				workflowLane: 'fb009-multi-lane',
				reviewItemIds: ITEM_IDS,
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			multiLanes,
			{ batchId: 'fb009-multi', prHeadSha: HEAD_SHA },
		);
		await persistBatch('fb009-multi', 'swarm-pr-review:reviewer', multiLanes, {
			textOverride: [
				// Two rows for C-0: the v1 mismatch plus a valid newer claim.
				`[REVIEWED] | C-0 | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale C-0 | probe C-0 | reviewer | UNKNOWN | `,
				`[REVIEWED] | C-0 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale C-0 | probe C-0 | reviewer | UNKNOWN | `,
				...multiText,
			].join(String.fromCharCode(10)),
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.unclaimed).toEqual(['C-0']);
		expect(composed.semanticsMismatchedItemIds).toEqual(['C-0']);
	});

	test('FB-009 ordering: semantics diagnostics flush after abandoned-lane evidence', async () => {
		// With cap headroom, an abandoned declared lane explains WHY settlement
		// blocked and must precede the deferred earlier-semantics convenience
		// diagnostic in the composed array.
		await establishReviewPrerequisites();
		const abandonedLanes = [
			{
				laneId: 'fb009-abandoned-lane',
				workflowLane: 'fb009-abandoned-lane',
				reviewItemIds: ITEM_IDS,
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			abandonedLanes,
			{ batchId: 'fb009-abandoned', prHeadSha: HEAD_SHA },
		);
		// No artifact persisted for the abandoned batch. The v1 batch follows.
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{ batchId: 'fb009-sem', prHeadSha: HEAD_SHA },
		);
		await persistBatch('fb009-sem', 'swarm-pr-review:reviewer', lanes, {
			textOverride: CONFIRMED_NONE_TEXT,
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		const abandonedIndex = composed.diagnostics.findIndex(
			(entry) =>
				entry.includes('fb009-abandoned-lane') &&
				entry.includes('produced no successful exact artifact'),
		);
		const semanticsIndex = composed.diagnostics.findIndex((entry) =>
			entry.includes('earlier verdict semantics'),
		);
		expect(abandonedIndex).toBeGreaterThanOrEqual(0);
		expect(semanticsIndex).toBeGreaterThan(abandonedIndex);
	});
});
