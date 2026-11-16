/**
 * Issue #3315 acceptance check AC1 (trace 3315-prescribed-tools-reachable) —
 * `rebind_pr_feedback_head` is reachable in a bound, unarmed PR_FEEDBACK gate.
 *
 * Discriminating check: RED at base, GREEN after the fix. At the unfixed base
 * the gate rejects the rebind controller with "rejects unclassified
 * plugin/MCP tools" (the tool is registered but sits outside
 * `PR_FEEDBACK_CONTROLLER_TOOLS` and carries no `prWorkflow` metadata), so the
 * `resolves.toBeUndefined()` assertion below fails there. Once the fix admits
 * the controller, this check turns GREEN.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const REAL_40HEX = '0123456789abcdef0123456789abcdef01234567';

describe('issue #3315 AC1 — rebind_pr_feedback_head reachable in bound unarmed PR_FEEDBACK', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('admits the rebind controller with a valid 40-hex head', async () => {
		const sessionId = `${SESSION_ID}-3315-ac1`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			enforcePrWorkflowToolBefore(
				tempDir,
				sessionId,
				'rebind_pr_feedback_head',
				{
					pr_head_sha: REAL_40HEX,
				},
			),
		).resolves.toBeUndefined();
	});
});
