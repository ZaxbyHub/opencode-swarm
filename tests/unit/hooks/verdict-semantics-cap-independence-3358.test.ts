/**
 * Issue #3358 AC4 cap-independence riders (approved plan R4, added at the
 * Phase 4.5 implementation-review round): the semantics disclosure must
 * survive a SATURATED composition-diagnostic budget, the message must bound
 * at 16 ids with "and N more", and the structured composition field must
 * carry the complete set. The settlement guard must also leave no
 * verdict-settlement receipt behind when it throws.
 *
 * Feedback PRR-02: the 16-id bound and its "and N more" overflow suffix are
 * pinned directly against the extracted formatter
 * (renderPrReviewSemanticsMismatchGuardMessage) with a 20-id inventory —
 * the six-dimension gate fixtures cannot overflow the bound on their own.
 *
 * RED against the guard regression (M2) and against a cap-only disclosure;
 * GREEN at the shipped head.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	assertPrReviewValidationSettled,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
	renderPrReviewSemanticsMismatchGuardMessage,
} from '../../../src/hooks/pr-workflow-gate.js';
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

/** A full-coverage reviewer artifact whose every row is a v1-era mismatch. */
const CONFIRMED_NONE_TEXT = ITEM_IDS.map(
	(itemId) =>
		`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
).join('\n');

/**
 * Saturate the shared composition-diagnostic budget (16 entries) with
 * unrelated noise: each newer batch carries one DISTINCT unassigned verdict
 * row, and every such lane contributes its own "contains an unassigned
 * verdict row" diagnostic. Eighteen lanes exceed the cap, evicting the
 * per-lane semantics convenience diagnostic from the capped channel.
 */
async function saturateDiagnostics(): Promise<void> {
	for (let i = 0; i < 18; i += 1) {
		const batchId = `noise-${i}`;
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{ batchId, prHeadSha: HEAD_SHA },
		);
		await persistBatch(batchId, 'swarm-pr-review:reviewer', lanes, {
			textOverride: `[REVIEWED] | noise-${i} | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale noise ${i} | probe noise ${i} | reviewer | UNKNOWN | `,
		});
	}
}

function settlementReceipts(): string[] {
	const root = join(tempDir, '.swarm', 'pr-review');
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((runId) =>
			existsSync(join(root, runId, 'verdict-settlement.reviewer.json')),
		)
		.map((runId) => join(runId, 'verdict-settlement.reviewer.json'));
}

describe('semantics-mismatch disclosure cap independence (#3358 AC4, plan R4)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('a saturated diagnostic budget still yields the dedicated clause and no receipt', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{ batchId: 'legacy-full', prHeadSha: HEAD_SHA },
		);
		await persistBatch('legacy-full', 'swarm-pr-review:reviewer', lanes, {
			textOverride: CONFIRMED_NONE_TEXT,
		});
		await saturateDiagnostics();
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// The shared 16-entry diagnostic budget is saturated (18 distinct
		// unassigned-row lanes) and the per-lane semantics CONVENIENCE
		// diagnostic has been evicted by that pressure...
		expect(composed.diagnostics.length).toBe(16);
		expect(
			composed.diagnostics.some((entry) =>
				/earlier verdict semantics/.test(entry),
			),
		).toBe(false);
		// ...yet the structured field still carries the complete mismatch set.
		expect(composed.semanticsMismatchedItemIds).toEqual(ITEM_IDS);
		let message = '(settlement unexpectedly admitted)';
		try {
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('N-of-M settlement is not attempted');
		expect(message).toMatch(/earlier verdict semantics/i);
		// PRR-02: the ids must appear in the DEDICATED mismatch clause, not
		// only in the generic unclaimed list that names them first. Assert
		// each id in the mismatch-id segment between '; items ' and the
		// dedicated marker (a deleted guard clause loses this segment and the
		// ids survive only in the generic list).
		const dedicatedSegment = message.slice(
			message.indexOf('; items ') + '; items '.length,
			message.indexOf(
				' carry verdict rows written under earlier verdict semantics',
			),
		);
		for (const itemId of ITEM_IDS) {
			expect(dedicatedSegment).toContain(itemId);
		}
		// The dedicated clause fires BEFORE N-of-M admission, so no receipt.
		expect(settlementReceipts()).toEqual([]);
	});

	test('the guard message bounds mismatch ids at 16 with an overflow suffix (PRR-02)', () => {
		const mismatched = Array.from({ length: 20 }, (_v, i) => `M-${i}`);
		const unclaimed = mismatched.slice(0, 4);
		const message = renderPrReviewSemanticsMismatchGuardMessage({
			requiredPhase: 'reviewer',
			unclaimed,
			blockingSemanticsMismatches: mismatched,
			diagnostics: ['diag-1'],
		});
		// 16 ids named, the remaining 4 degrade to the overflow suffix.
		const namedSegment = message.slice(
			message.indexOf('; items '),
			message.indexOf(' carry verdict rows'),
		);
		for (const itemId of mismatched.slice(0, 16)) {
			expect(namedSegment).toContain(itemId);
		}
		expect(message).toContain(' and 4 more carry verdict rows');
		for (const itemId of mismatched.slice(16)) {
			expect(namedSegment.includes(itemId)).toBe(false);
		}
		expect(message).toContain('v2; CONFIRMED requires a non-NONE severity');
		expect(message).toContain('diagnostics: diag-1');
	});

	test('the message names every mismatched id with the dedicated clause (6-id inventory: no overflow)', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{ batchId: 'legacy-overflow', prHeadSha: HEAD_SHA },
		);
		await persistBatch('legacy-overflow', 'swarm-pr-review:reviewer', lanes, {
			textOverride: CONFIRMED_NONE_TEXT,
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.semanticsMismatchedItemIds).toEqual(ITEM_IDS);
		let message = '(settlement unexpectedly admitted)';
		try {
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// The required inventory here is the six fixed base dimensions, so the
		// 16-id display bound cannot overflow in this fixture; what this leg
		// pins is that the DEDICATED clause (not the generic path) names every
		// mismatched id — the guard-specific marker that the M2 mutant loses.
		expect(message).toContain('N-of-M settlement is not attempted');
		for (const itemId of ITEM_IDS) {
			expect(message).toContain(itemId);
		}
		expect(message.match(/and \d+ more/)).toBeNull();
		// Unmet-by-fixture plan case, disclosed: the "and N more" overflow
		// suffix needs a >16-item required inventory; the gate's reviewer
		// inventory is exactly the six base dimensions in these fixtures.
	});

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
