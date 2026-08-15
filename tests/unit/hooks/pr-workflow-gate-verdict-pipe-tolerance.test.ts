import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewValidationSettled,
	_test_exports as gateInternals,
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

// Verdict-row pipe tolerance (PR-review deadlock fix). The strict verdict
// parsers count pipe fields exactly ([REVIEWED]: 10, [CRITIC]: 6), so prose in
// the trailing free-text fields that contains literal pipes — regex text,
// `,;|`, shell snippets — previously made the whole verdict unparseable and
// dead-ended the reviewer/critic phases exactly like the discovery phase.
// pipeFieldsCapped tail-merges extra separators into the trailing field.

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('verdict row pipe tolerance', () => {
	test('pipeFieldsCapped preserves all fields exactly when the pipe is trailing', () => {
		// Fidelity-safe shape: extra pipes in the LAST (free-text) field merge
		// back into it; every earlier field is byte-identical.
		const row =
			'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale text | probe | reviewer notes mentioning `,;|` and a | b';
		const capped = gateInternals.pipeFieldsCapped(row, 10);
		expect(capped).toHaveLength(10);
		expect(capped.slice(0, 9)).toEqual(
			row
				.split('|')
				.map((f) => f.trim())
				.slice(0, 9),
		);
		// Fields are pipe-split and trimmed before rejoining, so surrounding
		// whitespace around an embedded pipe is normalized away — the pipe
		// character and field content themselves are preserved.
		expect(capped[9]).toBe('reviewer notes mentioning `,;|` and a|b');
	});

	test('pipeFieldsCapped preserves machine fields when the pipe is mid-row', () => {
		// Documented boundary: a pipe in a NON-trailing prose field re-arranges
		// the trailing prose fields, but the enumerated machine positions
		// (id, classification, severity, file:line) are untouched.
		const row =
			'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale mentioning `,;|` inline | probe | reviewer';
		const capped = gateInternals.pipeFieldsCapped(row, 10);
		expect(capped).toHaveLength(10);
		expect(capped[1]).toBe('C-0');
		expect(capped[2]).toBe('CONFIRMED');
		expect(capped[4]).toBe('HIGH');
		expect(capped[6]).toBe('file.ts:1');
	});

	test('a [REVIEWED] row with pipes in the rationale still authenticates', async () => {
		await establishReviewPrerequisites();
		const itemIds = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-pipes',
					workflowLane: 'review-pipes',
					reviewItemIds: itemIds,
				},
			],
			{ batchId: 'review-pipes', prHeadSha: HEAD_SHA },
		);
		// The pipe sits in a MID-row prose field (rationale). The tail-merge
		// preserves every machine-checked position (classification, severity,
		// file:line) so authentication succeeds, but trailing prose fields may be
		// re-arranged — the documented fidelity boundary. The trailing-field case
		// below pins the fidelity-safe shape.
		const reviewerRows = itemIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | regex text mentioning the class \`,;|\` inline | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-pipes',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-pipes', workflowLane: 'review-pipes' }],
			{ textOverride: reviewerRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});

	test('a [CRITIC] row with pipes in its rationale still authenticates', async () => {
		await establishReviewPrerequisites();
		const itemIds = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-clean',
					workflowLane: 'review-clean',
					reviewItemIds: itemIds,
				},
			],
			{ batchId: 'review-clean', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'review-clean',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-clean', workflowLane: 'review-clean' }],
			{
				textOverride: itemIds
					.map(
						(id) =>
							`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
					)
					.join('\n'),
			},
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-pipes',
					workflowLane: 'critic-pipes',
					reviewItemIds: itemIds,
				},
			],
			{ batchId: 'critic-pipes', prHeadSha: HEAD_SHA },
		);
		const criticRows = itemIds
			.map(
				(id) =>
					`[CRITIC] | ${id} | UPHELD | HIGH | the gate rejects \`,;|\` injection chars | required change spelled out`,
			)
			.join('\n');
		await persistBatch(
			'critic-pipes',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-pipes', workflowLane: 'critic-pipes' }],
			{ textOverride: criticRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});
});
