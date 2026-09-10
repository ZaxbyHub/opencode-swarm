import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	bindPrWorkflowHead,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	artifactRecord,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * #2585 check C12 (AC7/R15): the bound PR head never silently rebinds. While a
 * PR_REVIEW workflow is bound to H1, every H2-claiming surface refuses and the
 * refusal names both heads; the sanctioned path (abort -> reactivate -> bind)
 * is proven to succeed.
 */
const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_H1 = PR_ARTIFACT_HEAD_SHA;
const HEAD_H2 = 'f'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r15-freshness-rebind';
const originals = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	revisionDetailed: gateInternals.resolvePrWorkflowRevisionDigestDetailed,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	diffStats: gateInternals.resolvePrReviewDiffStats,
	diffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
	agents: dispatchInternals.getGeneratedAgentNames,
	dispatchRevision: dispatchInternals.resolvePrWorkflowRevisionDigestAsync,
	dispatchBase: dispatchInternals.resolveExactMergeBaseAsync,
	dispatchConfig: dispatchInternals.loadPluginConfig,
	triggerRevision: triggerInternals.resolvePrWorkflowRevisionDigest,
	triggerRevisionAsync: triggerInternals.resolvePrWorkflowRevisionDigestAsync,
	triggerBase: triggerInternals.resolveMergeBase,
	triggerBaseAsync: triggerInternals.resolveMergeBaseAsync,
};
let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let nextChild = 0;
/** The head the checkout claims; moved to H2 to simulate the remote moving. */
let currentHead = HEAD_H1;

function parsed(value: string): Record<string, unknown> & { success: boolean } {
	return JSON.parse(value) as Record<string, unknown> & { success: boolean };
}
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r15-freshness-');
	await initializeGitRepository(directory);
	nextChild = 0;
	currentHead = HEAD_H1;
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => currentHead;
	gateInternals.resolveCurrentGitHeadAsync = async () => currentHead;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolvePrWorkflowRevisionDigestDetailed = () => ({
		ok: true,
		digest: REVISION_DIGEST,
	});
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 400,
		changedFiles: 12,
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => 'b'.repeat(40);
	dispatchInternals.loadPluginConfig = () => ({
		pr_review_resilience: {
			...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
			enabled: false,
		},
	});
	dispatchInternals.getGeneratedAgentNames = () => ['explorer', 'reviewer'];
	triggerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	triggerInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	triggerInternals.resolveMergeBase = () => 'b'.repeat(40);
	triggerInternals.resolveMergeBaseAsync = async () => 'b'.repeat(40);
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r15-child-${++nextChild}`,
			onPrompt: () => undefined,
		}),
	);
});
afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.head;
	gateInternals.resolveCurrentGitHeadAsync = originals.headAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originals.revision;
	gateInternals.resolvePrWorkflowRevisionDigestDetailed =
		originals.revisionDetailed;
	gateInternals.resolveIsWorkingTreeClean = originals.clean;
	gateInternals.resolveIsWorkingTreeCleanAsync = originals.cleanAsync;
	gateInternals.resolvePrReviewDiffStats = originals.diffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originals.diffStatsAsync;
	dispatchInternals.getGeneratedAgentNames = originals.agents;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originals.dispatchRevision;
	dispatchInternals.resolveExactMergeBaseAsync = originals.dispatchBase;
	dispatchInternals.loadPluginConfig = originals.dispatchConfig;
	triggerInternals.resolvePrWorkflowRevisionDigest = originals.triggerRevision;
	triggerInternals.resolvePrWorkflowRevisionDigestAsync =
		originals.triggerRevisionAsync;
	triggerInternals.resolveMergeBase = originals.triggerBase;
	triggerInternals.resolveMergeBaseAsync = originals.triggerBaseAsync;
	await removeTempDir();
});
/** Windows teardown: release held handles, then bounded EBUSY-tolerant rm. */
async function removeTempDir(): Promise<void> {
	closeAllProjectDbs();
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}
describe('R15 freshness: head rebinding is refused, never silent (#2585 C12/AC7)', () => {
	test('every H2-claiming surface refuses naming both heads while bound to H1', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_H1,
		});
		// The remote moved: the checkout now sits at H2 while the workflow stays
		// bound to H1.
		currentHead = HEAD_H2;
		const bothShasMessage = `BLOCKED: active PR_REVIEW workflow is bound to PR head "${HEAD_H1}"; received "${HEAD_H2}"`;
		await expect(
			bindPrWorkflowHead(directory, SESSION_ID, HEAD_H2),
		).rejects.toThrow(bothShasMessage);
		await expect(
			activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
				prHeadSha: HEAD_H2,
			}),
		).rejects.toThrow(bothShasMessage);

		const artifact = parsed(
			String(
				await plugin.tool.write_pr_review_artifact.execute(
					{
						kind: 'findings',
						run_id: RUN_ID,
						pr_head_sha: HEAD_H2,
						boundary: 'post_explorer',
						records: [
							artifactRecord(
								'CLEAN-REVIEW',
								'PENDING',
								'route_to_reviewer',
								'NONE',
							),
						],
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(artifact.success).toBe(false);
		expect(String(artifact.message)).toContain(
			`field pr_head_sha: expected "${HEAD_H1}"`,
		);
		expect(String(artifact.message)).toContain(HEAD_H2);

		// Completion claiming a non-bound head: the checkout sits at the recorded
		// H1 (the workflow never moved it); only the claimed pr_head_sha is H2.
		currentHead = HEAD_H1;
		const completion = parsed(
			String(
				await plugin.tool.complete_pr_workflow.execute(
					{
						mode: 'PR_REVIEW',
						pr_head_sha: HEAD_H2,
						report_verdict: 'APPROVE',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(completion.success).toBe(false);
		expect(String(completion.message)).toContain(
			`BLOCKED: cannot complete PR_REVIEW at PR head "${HEAD_H2}"; workflow is bound to "${HEAD_H1}"`,
		);

		// Nothing above silently rebound the workflow.
		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(state?.prHeadSha).toBe(HEAD_H1);
	});

	test('sanctioned path: abort -> reactivate -> bind the new head succeeds', async () => {
		const bound = await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_H1,
		});
		const firstInstanceId = bound.workflowInstanceId;
		const aborted = parsed(
			String(
				await plugin.tool.abort_pr_workflow.execute(
					{
						mode: 'PR_REVIEW',
						kind: 'recovery',
						reason:
							'authoritative remote head moved; rebinding via a fresh run',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(aborted).toMatchObject({ success: true, gate_cleared: true });
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();

		currentHead = HEAD_H2;
		const rebound = await activatePrWorkflow(
			directory,
			SESSION_ID,
			'PR_REVIEW',
			{
				prHeadSha: HEAD_H2,
			},
		);
		expect(rebound.prHeadSha).toBe(HEAD_H2);
		expect(rebound.workflowInstanceId).not.toBe(firstInstanceId);
		expect(
			(await readPrWorkflowGateState(directory, SESSION_ID))?.prHeadSha,
		).toBe(HEAD_H2);
	});
});
