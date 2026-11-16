/**
 * Issue #3315 acceptance check AC5 (trace 3315-prescribed-tools-reachable) —
 * trusted-observe tools are reachable in a bound, unarmed PR_FEEDBACK gate.
 *
 * Discriminating check: RED at base, GREEN after the fix. At the unfixed base
 * the remote-mutation name heuristic classifies `pr_workflow_status`,
 * `git_blame`, and `gitingest` as publication tools and rejects them with
 * "publication is not armed" — even though each carries `prWorkflow` observe
 * capability metadata for both modes — so the `resolves.toBeUndefined()`
 * assertions below fail there. Once the D2 exemption (trusted-observe
 * capability beats the name heuristic) lands, this check turns GREEN.
 *
 * The negative control (publication-shaped names WITHOUT observe metadata
 * keep rejecting) is pinned separately in
 * `pr-feedback-publication-tools-floor-l2.test.ts` (AC6) and is deliberately
 * not duplicated here.
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

describe('issue #3315 AC5 — observe tools reachable in bound unarmed PR_FEEDBACK', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('admits every trusted-observe tool the gate texts prescribe', async () => {
		const sessionId = `${SESSION_ID}-3315-ac5`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		for (const [toolName, args] of [
			['pr_workflow_status', {}],
			['git_blame', { file: 'src/foo.ts' }],
			['gitingest', { repo: 'owner/repo' }],
		] as const) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, toolName, args),
			).resolves.toBeUndefined();
		}
	});
});
