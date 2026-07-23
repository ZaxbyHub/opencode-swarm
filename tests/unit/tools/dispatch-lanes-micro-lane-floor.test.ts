import { describe, expect, test } from 'bun:test';
import { PR_REVIEW_REQUIRED_MICRO_LANE_IDS } from '../../../src/hooks/pr-workflow-gate.js';
import { _test_exports as dispatchTestExports } from '../../../src/tools/dispatch-lanes.js';

// Issue #1936: per-tier lane-count floor for a FULL micro (risk-family) sweep.
// The floor mirrors the base-dimension floor's tier *semantics* scaled to the
// eleven risk families — S does not bind (floor 1), M requires >= ceil(11/2) = 6
// lanes, L requires one lane per family (11). It binds ONLY on a batch whose
// lanes collectively own all eleven families; partial retry batches (a subset)
// are exempt so re-dispatching a failed family never deadlocks.

const { validatePrReviewMicroDispatch } = dispatchTestExports as unknown as {
	validatePrReviewMicroDispatch: (
		args: {
			trigger_evaluation?: Array<{
				trigger_id: string;
				result: 'MATCHED';
				evidence: string;
			}>;
			lanes: Array<{ workflow_lane: string; owned_workflow_lanes?: string[] }>;
		},
		depthTier: 'S' | 'M' | 'L',
	) => void;
};

const FAMILIES = PR_REVIEW_REQUIRED_MICRO_LANE_IDS;

function fullEvaluation() {
	return FAMILIES.map((id) => ({
		trigger_id: id,
		result: 'MATCHED' as const,
		evidence: `mandatory review focus for ${id}`,
	}));
}

/** A single lane owning every family (the degenerate full-consolidation shape). */
function oneLaneOwningAll() {
	return [{ workflow_lane: FAMILIES[0], owned_workflow_lanes: [...FAMILIES] }];
}

/** Partition the eleven families into `laneCount` full-coverage lanes. */
function fullSweepLanes(laneCount: number) {
	const buckets: string[][] = Array.from({ length: laneCount }, () => []);
	FAMILIES.forEach((id, index) => {
		buckets[index % laneCount].push(id);
	});
	return buckets.map((owned) => ({
		workflow_lane: owned[0],
		owned_workflow_lanes: owned,
	}));
}

/** One singleton lane per family (the canonical tier-L full sweep). */
function elevenSingletonLanes() {
	return FAMILIES.map((id) => ({
		workflow_lane: id,
		owned_workflow_lanes: [id],
	}));
}

describe('validatePrReviewMicroDispatch — per-tier full-sweep floor (issue #1936)', () => {
	test('tier M: a full sweep consolidated into one lane is BLOCKED below the floor', () => {
		expect(() =>
			validatePrReviewMicroDispatch(
				{ trigger_evaluation: fullEvaluation(), lanes: oneLaneOwningAll() },
				'M',
			),
		).toThrow(/at least 6 lanes/);
	});

	test('tier M: a full sweep consolidated into two lanes is BLOCKED below the floor', () => {
		const sweepA = FAMILIES.slice(0, 6);
		const sweepB = FAMILIES.slice(6);
		expect(() =>
			validatePrReviewMicroDispatch(
				{
					trigger_evaluation: fullEvaluation(),
					lanes: [
						{ workflow_lane: sweepA[0], owned_workflow_lanes: [...sweepA] },
						{ workflow_lane: sweepB[0], owned_workflow_lanes: [...sweepB] },
					],
				},
				'M',
			),
		).toThrow(/depth tier M .* at least 6 lanes/);
	});

	test('tier M: a full sweep spread across six lanes is accepted', () => {
		expect(() =>
			validatePrReviewMicroDispatch(
				{ trigger_evaluation: fullEvaluation(), lanes: fullSweepLanes(6) },
				'M',
			),
		).not.toThrow();
	});

	test('tier S: floor does not bind — a one-lane full sweep is accepted', () => {
		expect(() =>
			validatePrReviewMicroDispatch(
				{ trigger_evaluation: fullEvaluation(), lanes: oneLaneOwningAll() },
				'S',
			),
		).not.toThrow();
	});

	test('tier L: the canonical eleven-singleton full sweep is accepted (floor 11)', () => {
		expect(() =>
			validatePrReviewMicroDispatch(
				{ trigger_evaluation: fullEvaluation(), lanes: elevenSingletonLanes() },
				'L',
			),
		).not.toThrow();
	});

	// Regression for the plan-critic round-1 blocker: partial retry batches
	// (covering a subset of the eleven families) must remain exempt from the
	// floor, otherwise re-dispatching a single failed family deadlocks the run.
	test('tier L: a one-family partial retry is exempt from the floor', () => {
		expect(() =>
			validatePrReviewMicroDispatch(
				{
					trigger_evaluation: fullEvaluation(),
					lanes: [
						{ workflow_lane: FAMILIES[0], owned_workflow_lanes: [FAMILIES[0]] },
					],
				},
				'L',
			),
		).not.toThrow();
	});

	test('tier M: a two-family partial retry is exempt from the floor', () => {
		expect(() =>
			validatePrReviewMicroDispatch(
				{
					trigger_evaluation: fullEvaluation(),
					lanes: [
						{
							workflow_lane: FAMILIES[0],
							owned_workflow_lanes: [FAMILIES[0], FAMILIES[1]],
						},
					],
				},
				'M',
			),
		).not.toThrow();
	});

	test('tier L: consolidation still fails the per-family check before the floor', () => {
		// A consolidated lane at tier L is rejected by the pre-existing per-family
		// guard, independent of the new floor.
		expect(() =>
			validatePrReviewMicroDispatch(
				{ trigger_evaluation: fullEvaluation(), lanes: oneLaneOwningAll() },
				'L',
			),
		).toThrow(/one dedicated lane per risk family/);
	});
});
