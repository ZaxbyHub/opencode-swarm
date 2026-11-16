/**
 * Issue #3315 acceptance check AC4 (trace 3315-prescribed-tools-reachable) —
 * shell head-movers stay blocked in a bound PR_FEEDBACK gate.
 *
 * Preserving floor check: GREEN at base and head. The D1 remedy (admitting
 * `rebind_pr_feedback_head` with a controller-owned fast-forward) must never
 * widen the shell classifier: every merge, rebase, pull, reset, detach,
 * checkout, and `gh pr checkout` form keeps rejecting with a BLOCKED
 * PR_FEEDBACK gate message in both the buggy base and the fixed tree.
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

describe('issue #3315 AC4 — shell head-movers stay blocked in bound PR_FEEDBACK', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('rejects every head-moving shell command after exact PR head binding', async () => {
		const sessionId = `${SESSION_ID}-3315-ac4`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		for (const command of [
			'git merge origin/main',
			'git rebase origin/main',
			'git merge --ff-only origin/pr-head',
			'git pull --ff-only',
			'git reset --hard origin/pr-head',
			`git switch --detach ${REAL_40HEX}`,
			`git checkout ${REAL_40HEX}`,
			'gh pr checkout 12 --branch pr-head',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, sessionId, 'shell', {
					command,
				}),
			).rejects.toThrow(/BLOCKED: PR_FEEDBACK/);
		}
	});
});
