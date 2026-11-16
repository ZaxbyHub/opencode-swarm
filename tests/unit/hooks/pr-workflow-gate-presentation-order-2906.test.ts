// Issue #2906 — gate-side presentation-order assignment: derive→record
// round-trip (pre-append counting basis), schema additivity on the coherence
// record, the authoritative order-agreement reader, and the audit-only critic
// stamp.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	derivePrReviewOrderUnstableItems,
	derivePrReviewPresentationOrder,
	readAuthoritativePrReviewOrderAgreement,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
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

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const reviewedRow = (
	id: string,
	classification: string,
	severity: string,
): string =>
	`[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `;

async function reviewerBatch(
	batchId: string,
	items: ReadonlyArray<{
		id: string;
		classification: string;
		severity: string;
	}>,
	expected?: 'A' | 'B',
): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${batchId}-lane`,
				workflowLane: `${batchId}-lane`,
				reviewItemIds: items.map((item) => item.id),
			},
		],
		{
			batchId,
			prHeadSha: HEAD_SHA,
			...(expected ? { expectedPresentationOrder: expected } : {}),
		},
	);
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId: `${batchId}-lane`, workflowLane: `${batchId}-lane` }],
		{
			textOverride: items
				.map((item) => reviewedRow(item.id, item.classification, item.severity))
				.join('\n'),
			subagentSessionId: `${batchId}-lane`,
		},
	);
}

describe('presentation-order assignment (issue #2906)', () => {
	test('derive→record round-trip: derived ordinal accepted, mismatch BLOCKED', async () => {
		await establishReviewPrerequisites();
		expect(await derivePrReviewPresentationOrder(tempDir, SESSION_ID)).toBe(
			'A',
		);
		await reviewerBatch(
			'po-a',
			[
				{ id: 'C-1', classification: 'CONFIRMED', severity: 'HIGH' },
				{ id: 'C-2', classification: 'CONFIRMED', severity: 'MEDIUM' },
			],
			'A',
		);
		expect(await derivePrReviewPresentationOrder(tempDir, SESSION_ID)).toBe(
			'B',
		);
		await expect(
			reviewerBatch(
				'po-b-bad',
				[{ id: 'C-1', classification: 'CONFIRMED', severity: 'HIGH' }],
				'A',
			),
		).rejects.toThrow(/presentation order derives as "B"/);
		await reviewerBatch(
			'po-b',
			[
				{ id: 'C-1', classification: 'CONFIRMED', severity: 'HIGH' },
				{ id: 'C-2', classification: 'DISPROVED', severity: 'NONE' },
			],
			'B',
		);
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(state?.prReviewBatchCoherence?.['po-a']?.presentationOrder).toBe(
			'A',
		);
		expect(state?.prReviewBatchCoherence?.['po-b']?.presentationOrder).toBe(
			'B',
		);
	});

	test('coherence presentationOrder is additive-optional and enum-validated', () => {
		const baseState = {
			schemaVersion: 1,
			sessionID: 'po-schema-2906',
			mode: 'PR_REVIEW',
			activatedAt: '2026-10-12T00:00:00.000Z',
			updatedAt: '2026-10-12T00:00:00.000Z',
		};
		const parsed = _test_exports.parseGateState({
			...baseState,
			prReviewBatchCoherence: { legacy: { validatedInventory: ['C-1'] } },
		});
		expect(parsed.success).toBe(true);
		const withA = _test_exports.parseGateState({
			...baseState,
			prReviewBatchCoherence: {
				b: { validatedInventory: ['C-1'], presentationOrder: 'A' },
			},
		});
		expect(withA.success).toBe(true);
		const withX = _test_exports.parseGateState({
			...baseState,
			prReviewBatchCoherence: {
				x: { validatedInventory: ['C-1'], presentationOrder: 'X' },
			},
		});
		expect(withX.success).toBe(false);
	});

	test('authoritative order-agreement reader + critic audit stamp', async () => {
		await establishReviewPrerequisites();
		// The critic batch below requires (a) the reviewer phase settled over
		// the full fixture inventory (C-0..C-5), so both passes cover every
		// item, and (b) the flipped item to stay critic-routable — so C-2
		// flips severity only (CONFIRMED/MEDIUM -> CONFIRMED/HIGH).
		const settled = (classification: string, severity: string) =>
			['C-0', 'C-1', 'C-3', 'C-4', 'C-5'].map((id) => ({
				id,
				classification,
				severity,
			}));
		await reviewerBatch('po-a2', [
			{ id: 'C-2', classification: 'CONFIRMED', severity: 'MEDIUM' },
			...settled('CONFIRMED', 'HIGH'),
		]);
		await reviewerBatch('po-b2', [
			{ id: 'C-2', classification: 'CONFIRMED', severity: 'HIGH' },
			...settled('CONFIRMED', 'HIGH'),
		]);
		const agreements = await readAuthoritativePrReviewOrderAgreement(
			tempDir,
			SESSION_ID,
		);
		expect(agreements.get('C-0')).toBe('agree');
		expect(agreements.get('C-2')).toBe('disagree');
		expect(await derivePrReviewOrderUnstableItems(tempDir, SESSION_ID)).toEqual(
			['C-2'],
		);
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'po-critic',
					agent: 'critic',
					workflowLane: 'po-critic',
					reviewItemIds: ['C-2'],
				},
			],
			{ batchId: 'po-c', prHeadSha: HEAD_SHA },
		);
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(
			state?.prReviewBatchCoherence?.['po-c']?.orderUnstableItemIds,
		).toEqual(['C-2']);
	});
});
