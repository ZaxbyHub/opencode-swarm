import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
	findByCorrelationId,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import {
	PR_REVIEW_REQUIRED_TRIGGER_IDS,
	type PrReviewInlineTriggerRow,
} from '../../../src/background/pr-review-trigger-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type { PrReviewWorkflowState } from '../../../src/pr-review/types.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	artifactRecord,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * #2585 frozen acceptance check C3 (AC2/R03), PRESERVING.
 *
 * A clean registered run: all six base dimensions covered by structured CLEAN
 * receipts with per-lane clean attestations; the trigger ledger evaluates all
 * eleven families; the findings boundary covers the full candidate inventory
 * (the zero-candidate sentinel); terminal report COMPLETE. Negative leg: an
 * INCOMPLETE envelope never yields CLEAN credit — the reducer leaves the lane
 * unresolved (no settle effect, reducer.ts ~:226-228).
 */

const SESSION_ID = 'r03-clean-registered';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r03-clean-run';
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
let deliveredPrompts = new Map<string, string>();

function parsed(value: string): Record<string, unknown> & { success: boolean } {
	return JSON.parse(value) as Record<string, unknown> & { success: boolean };
}
async function removeTempDir(): Promise<void> {
	closeAllProjectDbs();
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}
function promptField(prompt: string, name: string): string {
	const value = prompt.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim();
	if (!value) throw new Error(`missing ${name} in rendered child prompt`);
	return value;
}
async function finishLane(record: ReturnType<typeof findByBatchId>[number]) {
	const header =
		record.mode === 'swarm-pr-review:micro'
			? CANDIDATE_HEADERS.micro_lane
			: record.mode === 'swarm-pr-review:base'
				? CANDIDATE_HEADERS.base_explorer
				: null;
	const text = header
		? `${header}\n[CLEAN] | ${record.workflowLane} | exact bound diff | registered child found no actionable defect`
		: reviewedRow('CLEAN-REVIEW', 'DISPROVED', 'NONE');
	const stored = storeLaneOutput(directory, {
		batchId: record.batchId!,
		laneId: record.laneId!,
		agent: record.swarmPrefixedAgent,
		role: record.normalizedAgent,
		sessionId: record.subagentSessionId,
		parentSessionId: SESSION_ID,
		mode: record.mode,
		workflowLane: record.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: record.workspace?.scope ?? undefined,
		source: 'collect_lane_results',
		text,
	});
	const terminal = await claimTerminalResult(directory, record.correlationId, {
		eventId: `r03-${record.correlationId}`,
		status: 'completed',
		recordedAt: 1,
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});
	expect(terminal?.disposition).toBe('claimed');
}
async function submitAndFinish(batchId: string): Promise<void> {
	for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
		const prompt = deliveredPrompts.get(record.subagentSessionId);
		if (!prompt) throw new Error('missing rendered child prompt');
		const owned =
			prompt
				.match(/^owned_workflow_lanes: (.+?) —/m)?.[1]
				?.split(',')
				.map((lane) => lane.trim()) ?? undefined;
		const envelopeLanes = owned ?? [promptField(prompt, 'workflow_lane')];
		const result = parsed(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						batchId: promptField(prompt, 'batch_id'),
						laneId: promptField(prompt, 'lane_id'),
						revisionDigest: promptField(prompt, 'revision_digest'),
						result: {
							schemaVersion: 1,
							outcome: 'CLEAN',
							creditedLanes: envelopeLanes,
							findings: [],
							cleanAttestations: envelopeLanes.map((workflowLane) => ({
								coverageScope: `Complete ${workflowLane} surface on the bound diff.`,
								evidence: 'Registered child found no actionable defect.',
								workflowLane,
							})),
							unresolved: [],
						},
					},
					{ directory, sessionID: record.subagentSessionId },
				),
			),
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
		await finishLane(record);
	}
}
async function dispatch(
	batchId: string,
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro',
	workflowLanes: readonly (string | readonly string[])[],
	triggerEvaluation?: PrReviewInlineTriggerRow[],
): Promise<void> {
	const lanes = workflowLanes.map((entry, index) => {
		const owned = typeof entry === 'string' ? [entry] : [...entry];
		return {
			id: `${mode.endsWith(':base') ? 'base' : 'micro'}-${index}`,
			agent: 'explorer',
			prompt: `Review ${owned.join(', ')} on the exact bound diff.`,
			workflow_lane: owned[0]!,
			...(owned.length > 1 ? { owned_workflow_lanes: owned } : {}),
		};
	});
	const result = parsed(
		String(
			await plugin.tool.dispatch_lanes_async.execute(
				{
					batch_id: batchId,
					mode,
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: 'origin/main',
					max_concurrent: lanes.length,
					...(triggerEvaluation
						? { trigger_evaluation: triggerEvaluation }
						: {}),
					lanes,
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(result).toMatchObject({ success: true, pending: lanes.length });
}
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r03-clean-');
	await initializeGitRepository(directory);
	nextChild = 0;
	deliveredPrompts = new Map();
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
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
	gateInternals.resolvePrReviewDiffStatsAsync = (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
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
	triggerInternals.resolveMergeBase = () => BASE_SHA;
	triggerInternals.resolveMergeBaseAsync = async () => BASE_SHA;
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r03-child-${++nextChild}`,
			onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
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

describe('r03 clean registered run (issue 2585, C3/AC2/R03)', () => {
	test('six dimensions CLEAN, eleven trigger families evaluated, terminal COMPLETE', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await dispatch('r03-base', 'swarm-pr-review:base', [
			PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
		]);
		await submitAndFinish('r03-base');
		// Per-lane CLEAN attestations: every base lane's structured receipt
		// attests exactly its owned dimensions.
		for (const record of findByBatchId(directory, 'r03-base', SESSION_ID)) {
			const envelope = findByCorrelationId(directory, record.subagentSessionId)
				?.result?.prReviewResultReceipt?.envelope;
			const owned = record.ownedWorkflowLanes ?? [record.workflowLane!];
			expect(envelope.outcome).toBe('CLEAN');
			expect(envelope.creditedLanes).toEqual(owned);
			expect(
				envelope.cleanAttestations.map(
					(entry: { workflowLane: string }) => entry.workflowLane,
				),
			).toEqual(owned);
		}

		// Trigger ledger: all eleven families evaluated MATCHED with provenance.
		expect(PR_REVIEW_REQUIRED_TRIGGER_IDS).toHaveLength(11);
		const inlineTriggers: PrReviewInlineTriggerRow[] =
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
				trigger_id: triggerId,
				result: 'MATCHED',
				evidence: `The bound diff requires focused review for ${triggerId}.`,
			}));
		const triggerRows: Array<Record<string, string>> = [];
		for (const [offset, lane] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
			const batchId = `r03-micro-${offset}`;
			await dispatch(
				batchId,
				'swarm-pr-review:micro',
				[lane],
				offset === 0 ? inlineTriggers : undefined,
			);
			await submitAndFinish(batchId);
			for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
				triggerRows.push({
					trigger_id: record.workflowLane!,
					result: 'MATCHED',
					evidence: `Registered micro receipt covers ${record.workflowLane}.`,
					source_batch_id: batchId,
					source_lane_id: record.laneId!,
				});
			}
		}
		expect(new Set(triggerRows.map((row) => row.trigger_id))).toEqual(
			new Set(PR_REVIEW_REQUIRED_TRIGGER_IDS),
		);
		const trigger = parsed(
			String(
				await plugin.tool.write_pr_review_trigger_eval.execute(
					{
						run_id: RUN_ID,
						pr_head_sha: HEAD_SHA,
						base_ref: 'origin/main',
						base_sha: BASE_SHA,
						rows: triggerRows,
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(trigger).toMatchObject({ success: true, matched_count: 11 });

		// Full candidate coverage: the zero-candidate sentinel inventory must be
		// covered exactly by the post_explorer records (the boundary gate
		// enforces exact coverage; a mismatch refuses the write).
		const explorer = parsed(
			String(
				await plugin.tool.write_pr_review_artifact.execute(
					{
						kind: 'findings',
						run_id: RUN_ID,
						pr_head_sha: HEAD_SHA,
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
		expect(explorer.success).toBe(true);
		const reviewer = parsed(
			String(
				await plugin.tool.dispatch_lanes_async.execute(
					{
						batch_id: 'r03-reviewer',
						mode: 'swarm-pr-review:reviewer',
						pr_head_sha: HEAD_SHA,
						base_sha: BASE_SHA,
						base_ref: 'origin/main',
						max_concurrent: 1,
						lanes: [
							{
								id: 'r03-reviewer-lane',
								agent: 'reviewer',
								prompt: 'Classify the clean-review sentinel.',
								workflow_lane: 'r03-reviewer-lane',
								review_item_ids: ['CLEAN-REVIEW'],
							},
						],
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(reviewer.success).toBe(true);
		await finishLane(findByBatchId(directory, 'r03-reviewer', SESSION_ID)[0]!);
		for (const boundary of ['post_reviewer', 'post_critic'] as const) {
			const write = parsed(
				String(
					await plugin.tool.write_pr_review_artifact.execute(
						{
							kind: 'findings',
							run_id: RUN_ID,
							pr_head_sha: HEAD_SHA,
							boundary,
							records: [
								artifactRecord(
									'CLEAN-REVIEW',
									'DISPROVED',
									'suppress_with_reason',
									'NONE',
								),
							],
						},
						{ directory, sessionID: SESSION_ID },
					),
				),
			);
			expect(write.success).toBe(true);
		}
		const completion = parsed(
			String(
				await plugin.tool.complete_pr_workflow.execute(
					{
						mode: 'PR_REVIEW',
						pr_head_sha: HEAD_SHA,
						report_verdict: 'APPROVE',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as ReturnType<typeof parsed> & {
			terminal_report: {
				kind: string;
				covered_dimensions: string[];
				unresolved_dimensions: unknown[];
				live_dimensions: string[];
				allowed_verdicts: string[];
			};
		};
		expect(completion).toMatchObject({
			success: true,
			status: 'completed',
			gate_cleared: true,
			terminal_report: {
				kind: 'COMPLETE',
				unresolved_dimensions: [],
				live_dimensions: [],
			},
		});
		expect(new Set(completion.terminal_report.covered_dimensions)).toEqual(
			new Set(PR_REVIEW_BASE_DIMENSION_IDS),
		);
		expect(completion.terminal_report.allowed_verdicts).toContain('APPROVE');
	}, 60_000);

	test('negative: an INCOMPLETE envelope never yields CLEAN credit — the lane stays unresolved', () => {
		const base: PrReviewWorkflowState = {
			sessionID: SESSION_ID,
			workflowInstanceId: 'r03-reducer-instance',
			revision: 4,
			prHeadSha: HEAD_SHA,
		};
		const event = (outcome: 'CLEAN' | 'INCOMPLETE') => ({
			type: 'lane_structured_result_submitted' as const,
			batchId: 'r03-base',
			laneId: 'base-0',
			generation: 4,
			semanticEnvelopeDigest: 'f'.repeat(64),
			outcome,
		});
		// CLEAN settles the lane completed (a settle_delegation effect rides
		// the ordinary completion event).
		const clean = reducePrReviewEvent(base, event('CLEAN'));
		expect(clean.status).toBe('applied');
		expect(clean.status === 'applied' && clean.effects).toEqual([
			{
				kind: 'settle_delegation',
				batchId: 'r03-base',
				laneId: 'base-0',
				status: 'completed',
			},
		]);
		// INCOMPLETE publishes the receipt but emits NO settle effect: the
		// lane is deliberately left unresolved, so it can never be credited as
		// covered by an incomplete discovery (issue #2384 / reducer.ts:226-228).
		const incomplete = reducePrReviewEvent(base, event('INCOMPLETE'));
		expect(incomplete.status).toBe('applied');
		expect(incomplete.status === 'applied' && incomplete.effects).toEqual([]);
	});
});
