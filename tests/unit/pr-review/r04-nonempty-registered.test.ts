import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
	findByCorrelationId,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
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
 * #2585 frozen acceptance check C4 (AC2/R04), PRESERVING. A findings-bearing
 * registered run: base lanes emit [CANDIDATE] rows; matched candidates enter
 * the authoritative findings inventory via write_pr_review_artifact records;
 * the reviewer lane is dispatched with review_item_ids covering every
 * candidate; final verdict REQUEST_CHANGES with no CLEAN claim.
 */

const SESSION_ID = 'r04-nonempty-registered';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r04-nonempty-run';
const CANDIDATE_IDS = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'] as const;
const CONFIRMED_IDS = ['C-0', 'C-1', 'C-2'] as const;
const DISPROVED_IDS = ['C-3', 'C-4', 'C-5'] as const;
// Shallow seam snapshots; afterEach restores every key so overrides cannot leak.
const originalGate = { ...gateInternals };
const originalDispatch = { ...dispatchInternals };
const originalTrigger = { ...triggerInternals };
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
function candidateRow(id: string, workflowLane: string): string {
	return `${id} | ${workflowLane} | HIGH | correctness | src/fixture.ts:1 | claim-${id} | evidence-${id} | impact-${id} | HIGH | UNKNOWN | `;
}
function findingFor(id: string, workflowLane: string) {
	return {
		id,
		workflowLane,
		severity: 'HIGH' as const,
		riskImpact: 'ORDINARY' as const,
		riskTags: [] as string[],
		title: `Registered finding ${id}`,
		body: `The bound diff introduces a reviewable defect for ${id}.`,
		evidence: `Structured receipt evidence for ${id}.`,
		location: { kind: 'local' as const, file: 'src/fixture.ts', line: 1 },
	};
}
async function settleLane(
	record: ReturnType<typeof findByBatchId>[number],
	options: {
		text: string;
		outcome: 'CLEAN' | 'FINDINGS';
		findings?: ReturnType<typeof findingFor>[];
		ownedLanes?: readonly string[];
	},
): Promise<void> {
	const prompt = deliveredPrompts.get(record.subagentSessionId);
	if (!prompt) throw new Error('missing rendered child prompt');
	const owned = options.ownedLanes ?? [promptField(prompt, 'workflow_lane')];
	if (
		record.mode === 'swarm-pr-review:base' ||
		record.mode === 'swarm-pr-review:micro'
	) {
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
							outcome: options.outcome,
							creditedLanes: owned,
							findings: options.findings ?? [],
							cleanAttestations:
								options.outcome === 'CLEAN'
									? owned.map((workflowLane) => ({
											coverageScope: `Complete ${workflowLane} surface on the bound diff.`,
											evidence: 'Registered child found no actionable defect.',
											workflowLane,
										}))
									: [],
							unresolved: [],
						},
					},
					{ directory, sessionID: record.subagentSessionId },
				),
			),
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
	}
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
		text: options.text,
	});
	const terminal = await claimTerminalResult(directory, record.correlationId, {
		eventId: `r04-${record.correlationId}`,
		status: 'completed',
		recordedAt: 1,
		result: {
			text: options.text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});
	expect(terminal?.disposition).toBe('claimed');
}
/** Dispatch + settle one registered reviewer/critic validation lane. */
async function writeFindings(
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
	records: readonly ReturnType<typeof artifactRecord>[],
): Promise<ReturnType<typeof parsed>> {
	return parsed(
		String(
			await plugin.tool.write_pr_review_artifact.execute(
				{
					kind: 'findings',
					run_id: RUN_ID,
					pr_head_sha: HEAD_SHA,
					boundary,
					records: [...records],
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
}
async function dispatchValidationLane(
	batchId: string,
	phase: 'reviewer' | 'critic',
	itemIds: readonly string[],
	text: string,
): Promise<void> {
	const result = parsed(
		String(
			await plugin.tool.dispatch_lanes_async.execute(
				{
					batch_id: batchId,
					mode: `swarm-pr-review:${phase}`,
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: 'origin/main',
					max_concurrent: 1,
					lanes: [
						{
							id: `${batchId}-lane`,
							agent: phase,
							prompt: `Classify the assigned ${phase} items.`,
							workflow_lane: `${batchId}-lane`,
							review_item_ids: [...itemIds],
						},
					],
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(result.success).toBe(true);
	await settleLane(findByBatchId(directory, batchId, SESSION_ID)[0]!, {
		text,
		outcome: 'CLEAN',
	});
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
	directory = canonicalMkdtemp('pr-review-r04-nonempty-');
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
	dispatchInternals.getGeneratedAgentNames = () => [
		'explorer',
		'reviewer',
		'critic',
	];
	triggerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	triggerInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	triggerInternals.resolveMergeBase = () => BASE_SHA;
	triggerInternals.resolveMergeBaseAsync = async () => BASE_SHA;
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r04-child-${++nextChild}`,
			onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
		}),
	);
});
afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	Object.assign(gateInternals, originalGate);
	Object.assign(dispatchInternals, originalDispatch);
	Object.assign(triggerInternals, originalTrigger);
	await removeTempDir();
});

describe('r04 findings-bearing registered run (issue 2585, C4/AC2/R04)', () => {
	test('candidates reach the authoritative inventory, reviewer covers every candidate, verdict REQUEST_CHANGES', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// Three base lanes × two dimensions, each emitting two [CANDIDATE] rows.
		await dispatch('r04-base', 'swarm-pr-review:base', [
			PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
		]);
		const baseRecords = findByBatchId(directory, 'r04-base', SESSION_ID);
		expect(baseRecords).toHaveLength(3);
		for (const [laneIndex, record] of baseRecords.entries()) {
			const owned = record.ownedWorkflowLanes ?? [record.workflowLane!];
			const rows = owned.map((lane, i) =>
				candidateRow(CANDIDATE_IDS[laneIndex * 2 + i]!, lane),
			);
			await settleLane(record, {
				text: `${CANDIDATE_HEADERS.base_explorer}\n${rows.join('\n')}`,
				outcome: 'FINDINGS',
				findings: owned.map((lane, i) =>
					findingFor(CANDIDATE_IDS[laneIndex * 2 + i]!, lane),
				),
				ownedLanes: owned,
			});
		}
		// Micro wave + trigger ledger.
		const inlineTriggers: PrReviewInlineTriggerRow[] =
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
				trigger_id: triggerId,
				result: 'MATCHED',
				evidence: `The bound diff requires focused review for ${triggerId}.`,
			}));
		const triggerRows: Array<Record<string, string>> = [];
		for (const [offset, lane] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
			const batchId = `r04-micro-${offset}`;
			await dispatch(
				batchId,
				'swarm-pr-review:micro',
				[lane],
				offset === 0 ? inlineTriggers : undefined,
			);
			for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
				const prompt = deliveredPrompts.get(record.subagentSessionId)!;
				await settleLane(record, {
					text: `${CANDIDATE_HEADERS.micro_lane}\n[CLEAN] | ${record.workflowLane} | focused invariant surface | no finding survived focused review`,
					outcome: 'CLEAN',
					ownedLanes: [promptField(prompt, 'workflow_lane')],
				});
				triggerRows.push({
					trigger_id: record.workflowLane!,
					result: 'MATCHED',
					evidence: `Registered micro receipt covers ${record.workflowLane}.`,
					source_batch_id: batchId,
					source_lane_id: record.laneId!,
				});
			}
		}
		const triggerEval = parsed(
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
		expect(triggerEval).toMatchObject({ success: true });

		// The matched candidates enter the authoritative findings inventory.
		const explorer = await writeFindings(
			'post_explorer',
			CANDIDATE_IDS.map((id) =>
				artifactRecord(id, 'PENDING', 'route_to_reviewer', 'HIGH'),
			),
		);
		expect(explorer).toMatchObject({ success: true, appended: 6 });
		const findingsOnDisk = await fs.readFile(
			path.join(directory, '.swarm', 'pr-review', RUN_ID, 'findings.jsonl'),
			'utf-8',
		);
		for (const id of CANDIDATE_IDS) {
			expect(findingsOnDisk).toContain(`"finding_id":"${id}"`);
		}

		// Reviewer dispatched with review_item_ids covering EVERY candidate.
		await dispatchValidationLane(
			'r04-reviewer',
			'reviewer',
			CANDIDATE_IDS,
			[
				...CONFIRMED_IDS.map((id) => reviewedRow(id, 'CONFIRMED', 'HIGH')),
				...DISPROVED_IDS.map((id) => reviewedRow(id, 'DISPROVED', 'NONE')),
			].join('\n'),
		);
		const reviewerState = (await readPrWorkflowGateState(
			directory,
			SESSION_ID,
		))!;
		const reviewerBatch = reviewerState.prReviewValidationBatches?.find(
			(batch) => batch.batchId === 'r04-reviewer',
		)!;
		expect(reviewerBatch.phase).toBe('reviewer');
		expect(new Set(reviewerBatch.lanes[0]!.reviewItemIds ?? [])).toEqual(
			new Set(CANDIDATE_IDS),
		);
		const postReviewer = await writeFindings('post_reviewer', [
			...CONFIRMED_IDS.map((id) =>
				artifactRecord(id, 'CONFIRMED', 'route_to_critic', 'HIGH'),
			),
			...DISPROVED_IDS.map((id) =>
				artifactRecord(id, 'DISPROVED', 'suppress_with_reason', 'NONE'),
			),
		]);
		expect(postReviewer.success).toBe(true);

		// Substantive critic lane over the critic-routed CONFIRMED HIGH items.
		await dispatchValidationLane(
			'r04-critic',
			'critic',
			CONFIRMED_IDS,
			CONFIRMED_IDS.map(
				(id) =>
					`[CRITIC] | ${id} | UPHELD | HIGH | independently verified | no change required`,
			).join('\n'),
		);
		const postCritic = await writeFindings('post_critic', [
			...CONFIRMED_IDS.map((id) =>
				artifactRecord(id, 'CONFIRMED', 'report', 'HIGH'),
			),
			...DISPROVED_IDS.map((id) =>
				artifactRecord(id, 'DISPROVED', 'suppress_with_reason', 'NONE'),
			),
		]);
		expect(postCritic.success).toBe(true);

		const completion = parsed(
			String(
				await plugin.tool.complete_pr_workflow.execute(
					{
						mode: 'PR_REVIEW',
						pr_head_sha: HEAD_SHA,
						report_verdict: 'REQUEST_CHANGES',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		) as ReturnType<typeof parsed> & {
			terminal_report: {
				kind: string;
				report_verdict: string;
				covered_dimensions: string[];
			};
		};
		expect(completion).toMatchObject({
			success: true,
			gate_cleared: true,
			terminal_report: { kind: 'COMPLETE', report_verdict: 'REQUEST_CHANGES' },
		});
		expect(new Set(completion.terminal_report.covered_dimensions)).toEqual(
			new Set(PR_REVIEW_BASE_DIMENSION_IDS),
		);
		// No CLEAN claim anywhere in the terminal report.
		expect(Object.values(completion.terminal_report).includes('CLEAN')).toBe(
			false,
		);
		expect(JSON.stringify(completion.terminal_report)).not.toContain('"CLEAN"');
	}, 60_000);
});
