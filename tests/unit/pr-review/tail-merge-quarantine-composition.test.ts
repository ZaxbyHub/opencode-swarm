/**
 * PRR-012 (swarm-pr-review pr3483-20261027): the tail-merge quarantine arm
 * (#3357) is exercised through the PRODUCTION composition path
 * (composePrReviewPhaseVerdicts), not only the pure analyzer functions —
 * the composition diagnostic must name the raw arrival arity and the bounded
 * id for a tail-merged stray, and the valid sibling row must still claim its
 * item. A regression that dropped the tail-merge arm from the composition
 * path would otherwise stay green (the analyzer-only suites would never
 * notice).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
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
} from '../hooks/pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('tail-merge quarantine through the production composition path (#3357 / PRR-012)', () => {
	test('composition renders the raw-arity quarantine diagnostic and the valid sibling still claims its item', async () => {
		await establishReviewPrerequisites();
		const lanes = [
			{
				laneId: 'lane-tail-merge',
				workflowLane: 'lane-tail-merge',
				reviewItemIds: ['C-0'],
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'batch-tail-merge',
				prHeadSha: HEAD_SHA,
			},
		);
		await persistBatch('batch-tail-merge', 'swarm-pr-review:reviewer', lanes, {
			textOverride:
				'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale text | probe text | notes | UNKNOWN |\n' +
				'[REVIEWED] | task-unknown | REJECTED | summary | with | pipes | a | b | c | d | e | f | g | h',
		});

		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);

		const quarantineDiagnostic = composed.diagnostics.find((line: string) =>
			line.includes('quarantined'),
		);
		expect(
			quarantineDiagnostic,
			`composition diagnostics must include the quarantine entry for the tail-merged stray; got: ${JSON.stringify(composed.diagnostics)}`,
		).toBeDefined();
		expect(quarantineDiagnostic).toContain('14');
		expect(quarantineDiagnostic).toContain('task-unknown');
		// The valid sibling still claims its item — the stray must not void
		// the lane through the exact-set check.
		expect(
			composed.unclaimed,
			`C-0 must be claimed; unclaimed: ${JSON.stringify(composed.unclaimed)}`,
		).not.toContain('C-0');
	}, 120000);
});
