import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import { claimTerminalResult, findByBatchId } from '../../../src/background/pending-delegations.js';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

// #2585 C15/AC10/R18: handoff membership = final CONFIRMED + handoff_to_feedback
// projection (DOWNGRADED in, DISPROVED out); completion starts nothing unsolicited.
const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r18-handoff';
const C_UPHELD = 'C-HANDOFF';
const C_DOWNGRADED = 'C-DOWNGRADE';
const C_DISPROVED = 'C-DISPROVED';
const INVENTORY = [C_UPHELD, C_DOWNGRADED, C_DISPROVED];
let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let nextChild = 0;
let deliveredPrompts = new Map<string, string>();
const laneCandidates = new Map<string, string>();
const gateHost = gateInternals as unknown as Record<string, unknown>;
const dispatchHost = dispatchInternals as unknown as Record<string, unknown>;
const triggerHost = triggerInternals as unknown as Record<string, unknown>;
const seamRestores: Array<() => void> = [];
function pinSeams(
	host: Record<string, unknown>,
	stubs: Record<string, unknown>,
): () => void {
	const saved = new Map(Object.keys(stubs).map((key) => [key, host[key]]));
	Object.assign(host, stubs);
	return () => saved.forEach((value, key) => (host[key] = value));
}
async function removeTempDir(): Promise<void> {
	closeAllProjectDbs();
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 4 || (error as NodeJS.ErrnoException).code !== 'EBUSY')
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}
type Parsed = Record<string, unknown> & { success: boolean };
const run = async (promise: Promise<unknown>): Promise<Parsed> =>
	JSON.parse(String(await promise)) as Parsed;
const stats = () =>
	({ changedLines: 400, changedFiles: 12, hasSubmoduleChange: false });
const envelopeBase = (workflowLane: string) => ({
	schemaVersion: 1 as const,
	creditedLanes: [workflowLane],
	unresolved: [] as never[],
});
function envelope(workflowLane: string, candidate: string | undefined) {
	if (candidate) {
		return {
			...envelopeBase(workflowLane),
			outcome: 'FINDINGS',
			findings: [
				{
					id: candidate,
					workflowLane,
					severity: 'HIGH',
					riskImpact: 'ORDINARY',
					riskTags: [],
					title: `Actionable defect ${candidate}`,
					body: 'Registered child reports a substantive defect on the bound diff.',
					evidence: 'Registered candidate row evidence on the bound diff.',
					location: { kind: 'local', file: 'src/index.ts', line: 1 },
				},
			],
			cleanAttestations: [],
		};
	}
	return {
		...envelopeBase(workflowLane),
		outcome: 'CLEAN',
		findings: [],
		cleanAttestations: [
			{
				coverageScope: `Complete ${workflowLane} surface on the bound diff.`,
				evidence: 'Registered child found no defect on this surface.',
				workflowLane,
			},
		],
	};
}
async function finishRecord(
	record: ReturnType<typeof findByBatchId>[number],
	text: string,
): Promise<void> {
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
		eventId: `${RUN_ID}-${record.correlationId}`,
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
		if (!record.workflowLane || !record.laneId) throw new Error('missing lane');
		const prompt = deliveredPrompts.get(record.subagentSessionId);
		if (!prompt) throw new Error('missing rendered child prompt');
		const promptField = (name: string) =>
			prompt.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim() ?? '';
		const result = await run(
			plugin.tool.submit_pr_review_result.execute(
				{
					schemaVersion: 1,
					batchId: promptField('batch_id'),
					laneId: promptField('lane_id'),
					revisionDigest: promptField('revision_digest'),
					result: envelope(
						record.workflowLane,
						laneCandidates.get(record.workflowLane),
					),
				},
				{ directory, sessionID: record.subagentSessionId },
			),
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
		const header =
			CANDIDATE_HEADERS[
				record.mode === 'swarm-pr-review:micro' ? 'micro_lane' : 'base_explorer'
			];
		const candidate = laneCandidates.get(record.workflowLane);
		const row = candidate
			? `${candidate} | ${record.workflowLane} | HIGH | correctness | src/index.ts:1 | registered claim | registered evidence | impact | HIGH | UNKNOWN | `
			: `[CLEAN] | ${record.workflowLane} | exact reviewed diff | no actionable finding survived`;
		await finishRecord(record, `${header}\n${row}`);
	}
}
async function dispatch(
	batchId: string,
	mode: string,
	lanes: ReadonlyArray<Record<string, unknown>>,
	triggerEvaluation?: PrReviewInlineTriggerRow[],
): Promise<void> {
	const result = await run(
		plugin.tool.dispatch_lanes_async.execute(
			{
				batch_id: batchId,
				mode,
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				max_concurrent: lanes.length,
				...(triggerEvaluation ? { trigger_evaluation: triggerEvaluation } : {}),
				lanes,
			},
			{ directory, sessionID: SESSION_ID },
		),
	);
	expect(result).toMatchObject({ success: true, pending: lanes.length });
}
function lane(
	workflowLane: string,
	agent: string,
	prompt: string,
	reviewItemIds?: readonly string[],
): Record<string, unknown> {
	return {
		id: workflowLane,
		agent,
		prompt,
		workflow_lane: workflowLane,
		...(reviewItemIds ? { review_item_ids: [...reviewItemIds] } : {}),
	};
}
function record(
	id: string,
	status: 'PENDING' | 'CONFIRMED' | 'DISPROVED',
	nextAction: string,
	severity: string,
) {
	return {
		finding_id: id,
		status,
		file_line: 'src/index.ts:1',
		evidence: 'registered artifact record',
		next_action: nextAction,
		severity,
		...(status === 'CONFIRMED'
			? { risk_impact: 'ORDINARY', risk_tags: [] }
			: {}),
	};
}
async function writeBoundary(
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
	records: ReadonlyArray<ReturnType<typeof record>>,
): Promise<void> {
	const result = await run(
		plugin.tool.write_pr_review_artifact.execute(
			{
				kind: 'findings',
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				boundary,
				records,
			},
			{ directory, sessionID: SESSION_ID },
		),
	);
	expect(result.success).toBe(true);
}
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r18-handoff-');
	await initializeGitRepository(directory);
	nextChild = 0;
	deliveredPrompts = new Map();
	laneCandidates.clear();
	gateInternals.resetTrackedStateCache();
	seamRestores.push(
		pinSeams(gateHost, {
			resolveCurrentGitHead: () => HEAD_SHA,
			resolveCurrentGitHeadAsync: async () => HEAD_SHA,
			resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
			resolvePrWorkflowRevisionDigestDetailed: () => ({
				ok: true,
				digest: REVISION_DIGEST,
			}),
			resolveIsWorkingTreeClean: () => true,
			resolveIsWorkingTreeCleanAsync: async () => true,
			resolvePrReviewDiffStats: () => stats(),
			resolvePrReviewDiffStatsAsync: async () => stats(),
		}),
	);
	seamRestores.push(
		pinSeams(dispatchHost, {
			resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
			resolveExactMergeBaseAsync: async () => BASE_SHA,
			loadPluginConfig: () => ({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: false,
				},
			}),
			getGeneratedAgentNames: () => ['explorer', 'reviewer', 'critic'],
		}),
	);
	seamRestores.push(
		pinSeams(triggerHost, {
			resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
			resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
			resolveMergeBase: () => BASE_SHA,
			resolveMergeBaseAsync: async () => BASE_SHA,
		}),
	);
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r18-child-${++nextChild}`,
			onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
		}),
	);
});
afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	for (const restore of seamRestores.splice(0)) restore();
	await removeTempDir();
});
describe('R18 actionable handoff membership and completion side effects (#2585 C15/AC10)', () => {
	test('handoff covers exactly the final CONFIRMED actionable set; completion starts nothing unsolicited', async () => {
		PR_REVIEW_BASE_DIMENSION_IDS.slice(0, INVENTORY.length).forEach(
			(dimension, index) => laneCandidates.set(dimension, INVENTORY[index]!),
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await dispatch('r18-base', 'swarm-pr-review:base', [
			...PR_REVIEW_BASE_DIMENSION_IDS.map((dimension) =>
				lane(
					dimension,
					'explorer',
					`Review ${dimension} on the exact bound diff.`,
				),
			),
		]);
		await submitAndFinish('r18-base');
		const inlineTriggers: PrReviewInlineTriggerRow[] =
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
				trigger_id: triggerId,
				result: 'MATCHED',
				evidence: `The bound diff requires focused review for ${triggerId}.`,
			}));
		const triggerRows: Array<Record<string, string>> = [];
		for (
			let offset = 0;
			offset < PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length;
			offset += 6
		) {
			const batchId = `r18-micro-${offset / 6}`;
			await dispatch(
				batchId,
				'swarm-pr-review:micro',
				PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(offset, offset + 6).map(
					(triggerId) =>
						lane(
							triggerId,
							'explorer',
							`Review ${triggerId} on the exact bound diff.`,
						),
				),
				offset === 0 ? inlineTriggers : undefined,
			);
			await submitAndFinish(batchId);
			for (const laneRecord of findByBatchId(directory, batchId, SESSION_ID)) {
				triggerRows.push({
					trigger_id: laneRecord.workflowLane!,
					result: 'MATCHED',
					evidence: `Registered micro receipt covers ${laneRecord.workflowLane}.`,
					source_batch_id: batchId,
					source_lane_id: laneRecord.laneId!,
				});
			}
		}
		await run(
			plugin.tool.write_pr_review_trigger_eval.execute(
				{
					run_id: RUN_ID,
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: BASE_SHA,
					rows: triggerRows,
				},
				{ directory, sessionID: SESSION_ID },
			),
		);
		await writeBoundary(
			'post_explorer',
			INVENTORY.map((id) => record(id, 'PENDING', 'route_to_reviewer', 'HIGH')),
		);
		await dispatch('r18-reviewer', 'swarm-pr-review:reviewer', [
			lane(
				'r18-reviewer-lane',
				'reviewer',
				'Classify the three registered candidates.',
				INVENTORY,
			),
		]);
		await finishRecord(
			findByBatchId(directory, 'r18-reviewer', SESSION_ID)[0]!,
			INVENTORY.map((id) => reviewedRow(id, 'CONFIRMED', 'HIGH')).join('\n'),
		);
		await writeBoundary(
			'post_reviewer',
			INVENTORY.map((id) => record(id, 'CONFIRMED', 'route_to_critic', 'HIGH')),
		);
		await dispatch('r18-critic', 'swarm-pr-review:critic', [
			lane(
				'r18-critic-lane',
				'critic',
				'Challenge the three registered verdicts.',
				INVENTORY,
			),
		]);
		await finishRecord(
			findByBatchId(directory, 'r18-critic', SESSION_ID)[0]!,
			[
				`[CRITIC] | ${C_UPHELD} | UPHELD | HIGH | verified independently | no change required`,
				`[CRITIC] | ${C_DOWNGRADED} | DOWNGRADED | MEDIUM | severity overstated | no change required`,
				`[CRITIC] | ${C_DISPROVED} | DISPROVED | NONE | claim not reproducible | suppress`,
			].join('\n'),
		);
		await writeBoundary('post_critic', [
			record(C_UPHELD, 'CONFIRMED', 'handoff_to_feedback', 'HIGH'),
			record(C_DOWNGRADED, 'CONFIRMED', 'handoff_to_feedback', 'MEDIUM'),
			record(C_DISPROVED, 'DISPROVED', 'suppress_with_reason', 'NONE'),
		]);
		const handoffBase = {
			pr_url: 'https://github.com/example/project/pull/123',
			summary: 'Two actionable findings survive the critic.',
			provenance: ['r18-reviewer', 'r18-critic'],
		};
		const handoffRequest = async (findingIds: readonly string[]) =>
			run(
				plugin.tool.write_pr_review_artifact.execute(
					{
						kind: 'handoff',
						run_id: RUN_ID,
						pr_head_sha: HEAD_SHA,
						handoff: { ...handoffBase, finding_ids: [...findingIds] },
					},
					{ directory, sessionID: SESSION_ID },
				),
			);
		const wrongHandoff = await handoffRequest([
			C_DISPROVED,
			C_DOWNGRADED,
			C_UPHELD,
		]);
		expect(wrongHandoff.success).toBe(false);
		expect(String(wrongHandoff.message)).toContain(
			`field handoff.finding_ids: expected authoritative actionable set [${C_DOWNGRADED}, ${C_UPHELD}], got requested [${C_DISPROVED}, ${C_DOWNGRADED}, ${C_UPHELD}]`,
		);
		const handoff = await handoffRequest([C_DOWNGRADED, C_UPHELD]);
		expect(handoff.success).toBe(true);
		expect(handoff.finding_count).toBe(2);
		expect(handoff.path).toBe(`pr-review/${RUN_ID}/feedback-handoff.json`);
		const handoffPath = path.join(
			directory,
			'.swarm/pr-review',
			RUN_ID,
			'feedback-handoff.json',
		);
		const handoffArtifact = JSON.parse(
			await fs.readFile(handoffPath, 'utf8'),
		) as Record<string, unknown>;
		expect(handoffArtifact).toMatchObject({
			schema_version: 1,
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			finding_ids: [C_DOWNGRADED, C_UPHELD],
			provenance: handoffBase.provenance,
		});
		expect(
			(await readPrWorkflowGateState(directory, SESSION_ID))?.prFeedbackPublication,
		).toBeUndefined();
		const completion = await run(
			plugin.tool.complete_pr_workflow.execute(
				{
					mode: 'PR_REVIEW',
					pr_head_sha: HEAD_SHA,
					report_verdict: 'REQUEST_CHANGES',
				},
				{ directory, sessionID: SESSION_ID },
			),
		);
		expect(completion).toMatchObject({
			success: true,
			status: 'completed',
			gate_cleared: true,
		});
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
		const gateFile = path.join(
			directory,
			'.swarm/pr-workflow-gates',
			`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
		);
		await expect(fs.stat(gateFile)).rejects.toThrow(/ENOENT/);
		const gateFiles = await fs
			.readdir(path.dirname(gateFile))
			.catch(() => [] as string[]);
		expect(gateFiles.filter((entry) => entry.endsWith('.json'))).toEqual([]);
		await expect(
			fs.stat(path.join(directory, '.swarm', 'pr-monitor', 'subscriptions.jsonl')),
		).rejects.toThrow(/ENOENT/);
	}, 60_000);
});
