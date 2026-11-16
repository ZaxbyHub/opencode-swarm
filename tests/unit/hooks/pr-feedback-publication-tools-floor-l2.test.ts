/**
 * Issue #3315 acceptance check AC6 (trace 3315-prescribed-tools-reachable) —
 * publication-shaped names WITHOUT trusted-observe metadata keep being
 * rejected while a PR_FEEDBACK gate is bound and unarmed.
 *
 * Preserving floor check: GREEN at base and head. Guards the D2 exemption
 * from over-reach: only `prWorkflow { capability: 'observe' }` metadata may
 * exempt a tool from the publication heuristic, so publication-shaped names
 * without that metadata stay blocked no matter how the exemption is wired.
 *
 * Deviation note (documented, not silent): the task sketch asked for
 * `/publication is not armed/`, but at the current base these names never
 * reach that branch — the earlier unclassified-plugin/MCP check fires first
 * for any name lacking trusted-observe metadata and a read-only name
 * classification, and they reject with "BLOCKED: PR_FEEDBACK rejects
 * unclassified plugin/MCP tools" (verified against the base tree). The
 * assertion therefore pins the AC6 contract itself — rejection by the
 * PR_FEEDBACK gate (`/BLOCKED: PR_FEEDBACK/`) — which holds under either
 * branch order, before and after the fix.
 *
 * `github_create_issue_comment` and `git_push` are not registered
 * `TOOL_NAMES` at authoring time; they are used as plain admission strings
 * because admission classifies by name. `pr_review_submission` IS a real
 * registered publication-shaped tool (GitHub-submitting, `pr`-prefixed name,
 * no `prWorkflow` observe block) outside every controller set — see
 * `PR_WORKFLOW_SHARED_CONTROLLER_TOOLS` / `PR_REVIEW_CONTROLLER_TOOLS` /
 * `PR_FEEDBACK_CONTROLLER_TOOLS` in `src/hooks/pr-workflow-gate.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { TOOL_NAMES } from '../../../src/tools/tool-metadata.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

describe('issue #3315 AC6 — publication-shaped names without observe metadata stay rejected', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('rejects unregistered publication-shaped admission strings', async () => {
		const sessionId = `${SESSION_ID}-3315-ac6`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			enforcePrWorkflowToolBefore(
				tempDir,
				sessionId,
				'github_create_issue_comment',
				{ body: 'x', owner: 'o', repo: 'r', issue_number: 1 },
			),
		).rejects.toThrow(/BLOCKED: PR_FEEDBACK/);
		await expect(
			enforcePrWorkflowToolBefore(tempDir, sessionId, 'git_push', {}),
		).rejects.toThrow(/BLOCKED: PR_FEEDBACK/);
	});

	test('rejects the real registered publication-shaped tool without observe metadata', async () => {
		expect(TOOL_NAMES).toContain('pr_review_submission');
		const sessionId = `${SESSION_ID}-3315-ac6-registered`;
		await activatePrWorkflow(tempDir, sessionId, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		await expect(
			enforcePrWorkflowToolBefore(tempDir, sessionId, 'pr_review_submission', {
				pr_head_sha: HEAD_SHA,
			}),
		).rejects.toThrow(/BLOCKED: PR_FEEDBACK/);
	});
});
