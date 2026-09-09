import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
} from '../../../src/background/pending-delegations.js';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	type ArtifactRecord,
	artifactRecord,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
// #2585 frozen check C5 (AC3/R05), PRESERVING: substantive critic lane via registered
// mode swarm-pr-review:critic — UPHELD/DOWNGRADED/DISPROVED settle (DOWNGRADED below
// reviewer severity; DISPROVED NONE + suppress_with_reason); NME never settles;
// post_critic handoff_required only for CONFIRMED + handoff_to_feedback.
const SESSION_ID = 'r05-critic-projection';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r05-critic-run';
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
/** Execute one registered tool and parse its JSON payload. */
async function toolCall(
	name: string,
	args: unknown,
	sessionID = SESSION_ID,
): Promise<ReturnType<typeof parsed>> {
	return parsed(
		String(await plugin.tool[name].execute(args, { directory, sessionID })),
	);
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
	if (!value) throw new Error(`missing ${name} in rendered prompt`);
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
		ownedLanes: readonly string[];
	},
): Promise<void> {
	const prompt = deliveredPrompts.get(record.subagentSessionId);
	if (!prompt) throw new Error('missing rendered child prompt');
	const findings = options.findings ?? [];
	if (
		record.mode === 'swarm-pr-review:base' ||
		record.mode === 'swarm-pr-review:micro'
	) {
		expect(
			await toolCall(
				'submit_pr_review_result',
				{
					schemaVersion: 1,
					batchId: promptField(prompt, 'batch_id'),
					laneId: promptField(prompt, 'lane_id'),
					revisionDigest: promptField(prompt, 'revision_digest'),
					result: {
						schemaVersion: 1,
						outcome: options.outcome,
						creditedLanes: options.ownedLanes,
						findings,
						cleanAttestations: options.ownedLanes
							.filter((lane) => !findings.some((f) => f.workflowLane === lane))
							.map((lane) => ({
								coverageScope: `Complete ${lane} surface on the bound diff.`,
								evidence: 'Registered child found no actionable defect.',
								workflowLane: lane,
							})),
						unresolved: [],
					},
				},
				record.subagentSessionId,
			),
		).toMatchObject({ success: true, status: 'recorded' });
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
		eventId: `r05-${record.correlationId}`,
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
async function dispatchDiscovery(
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
	expect(
		await toolCall('dispatch_lanes_async', {
			batch_id: batchId,
			mode,
			pr_head_sha: HEAD_SHA,
			base_sha: BASE_SHA,
			base_ref: 'origin/main',
			max_concurrent: lanes.length,
			...(triggerEvaluation ? { trigger_evaluation: triggerEvaluation } : {}),
			lanes,
		}),
	).toMatchObject({ success: true, pending: lanes.length });
}
/** Dispatch + settle one registered reviewer/critic validation lane. */
async function dispatchValidationLane(
	batchId: string,
	phase: 'reviewer' | 'critic',
	itemIds: readonly string[],
	text: string,
): Promise<void> {
	const laneId = `${batchId}-lane`;
	const dispatched = await toolCall('dispatch_lanes_async', {
		batch_id: batchId,
		mode: `swarm-pr-review:${phase}`,
		pr_head_sha: HEAD_SHA,
		base_sha: BASE_SHA,
		base_ref: 'origin/main',
		max_concurrent: 1,
		lanes: [
			{
				id: laneId,
				agent: phase,
				prompt: `Adjudicate the assigned ${phase} items.`,
				workflow_lane: laneId,
				review_item_ids: [...itemIds],
			},
		],
	});
	expect(dispatched.success).toBe(true);
	await settleLane(findByBatchId(directory, batchId, SESSION_ID)[0]!, {
		text,
		outcome: 'CLEAN',
		ownedLanes: [laneId],
	});
}
async function writeFindings(
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
	records: readonly ArtifactRecord[],
): Promise<ReturnType<typeof parsed> & { handoff_required: boolean }> {
	return (await toolCall('write_pr_review_artifact', {
		kind: 'findings',
		run_id: RUN_ID,
		pr_head_sha: HEAD_SHA,
		boundary,
		records: [...records],
	})) as ReturnType<typeof parsed> & { handoff_required: boolean };
}
/**
 * Drive base discovery (three tier-M lanes partitioning all six dimensions,
 * [CANDIDATE] rows for the requested candidates), the micro wave, the trigger
 * ledger, and the post_explorer checkpoint.
 */
async function driveDiscovery(
	candidates: ReadonlyArray<{ id: string; dimension: string }>,
): Promise<string[]> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	await dispatchDiscovery('r05-base', 'swarm-pr-review:base', [
		PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
		PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
		PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
	]);
	for (const record of findByBatchId(directory, 'r05-base', SESSION_ID)) {
		const owned = record.ownedWorkflowLanes ?? [record.workflowLane!];
		const laneCandidates = candidates.filter((candidate) =>
			owned.includes(candidate.dimension),
		);
		const findings = laneCandidates.map((candidate) =>
			findingFor(candidate.id, candidate.dimension),
		);
		const rows = owned.map((dimension) => {
			const candidate = laneCandidates.find(
				(entry) => entry.dimension === dimension,
			);
			return candidate
				? candidateRow(candidate.id, dimension)
				: `[CLEAN] | ${dimension} | exact bound diff | no actionable defect survived`;
		});
		await settleLane(record, {
			text: `${CANDIDATE_HEADERS.base_explorer}\n${rows.join('\n')}`,
			outcome: findings.length > 0 ? 'FINDINGS' : 'CLEAN',
			findings,
			ownedLanes: owned,
		});
	}
	// Two micro batches (8-lane cap) cover the eleven families; the first freezes the ledger.
	const inlineTriggers: PrReviewInlineTriggerRow[] =
		PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
			trigger_id: triggerId,
			result: 'MATCHED',
			evidence: `The bound diff requires focused review for ${triggerId}.`,
		}));
	const triggerRows: Array<Record<string, string>> = [];
	for (const [index, chunk] of [
		PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(0, 8),
		PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(8),
	].entries()) {
		const batchId = `r05-micro-${index}`;
		await dispatchDiscovery(
			batchId,
			'swarm-pr-review:micro',
			chunk,
			index === 0 ? inlineTriggers : undefined,
		);
		for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
			await settleLane(record, {
				text: `${CANDIDATE_HEADERS.micro_lane}\n[CLEAN] | ${record.workflowLane} | focused surface | no finding survived`,
				outcome: 'CLEAN',
				ownedLanes: [record.workflowLane!],
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
	const triggerEval = await toolCall('write_pr_review_trigger_eval', {
		run_id: RUN_ID,
		pr_head_sha: HEAD_SHA,
		base_ref: 'origin/main',
		base_sha: BASE_SHA,
		rows: triggerRows,
	});
	expect(triggerEval.success).toBe(true);
	expect(
		(
			await writeFindings(
				'post_explorer',
				candidates.map((candidate) =>
					artifactRecord(candidate.id, 'PENDING', 'route_to_reviewer', 'HIGH'),
				),
			)
		).success,
	).toBe(true);
	return candidates.map((candidate) => candidate.id);
}
/** Seam overrides shared by both tests (registered-host pattern). */
const GATE_SEAMS = {
	resolveCurrentGitHead: () => HEAD_SHA,
	resolveCurrentGitHeadAsync: async () => HEAD_SHA,
	resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
	resolvePrWorkflowRevisionDigestDetailed: () => ({
		ok: true,
		digest: REVISION_DIGEST,
	}),
	resolveIsWorkingTreeClean: () => true,
	resolveIsWorkingTreeCleanAsync: async () => true,
	resolvePrReviewDiffStats: () => ({
		changedLines: 400,
		changedFiles: 12,
		hasSubmoduleChange: false,
	}),
};
const DISPATCH_SEAMS = {
	resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
	resolveExactMergeBaseAsync: async () => BASE_SHA,
	loadPluginConfig: () => ({
		pr_review_resilience: {
			...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
			enabled: false,
		},
	}),
	getGeneratedAgentNames: () => ['explorer', 'reviewer', 'critic'],
};
const TRIGGER_SEAMS = {
	resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
	resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
	resolveMergeBase: () => BASE_SHA,
	resolveMergeBaseAsync: async () => BASE_SHA,
};
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r05-critic-');
	await initializeGitRepository(directory);
	nextChild = 0;
	deliveredPrompts = new Map();
	gateInternals.resetTrackedStateCache();
	Object.assign(gateInternals, GATE_SEAMS);
	gateInternals.resolvePrReviewDiffStatsAsync = (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	Object.assign(dispatchInternals, DISPATCH_SEAMS);
	Object.assign(triggerInternals, TRIGGER_SEAMS);
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r05-child-${++nextChild}`,
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

describe('r05 critic projection registered (issue 2585, C5/AC3/R05)', () => {
	test('UPHELD, DOWNGRADED and DISPROVED settle; downgraded severity is preserved; handoff only for CONFIRMED + handoff_to_feedback', async () => {
		const ids = await driveDiscovery([
			{ id: 'C-0', dimension: PR_REVIEW_BASE_DIMENSION_IDS[0]! },
			{ id: 'C-1', dimension: PR_REVIEW_BASE_DIMENSION_IDS[1]! },
			{ id: 'C-2', dimension: PR_REVIEW_BASE_DIMENSION_IDS[2]! },
		]);
		await dispatchValidationLane(
			'r05-reviewer',
			'reviewer',
			ids,
			ids.map((id) => reviewedRow(id, 'CONFIRMED', 'HIGH')).join('\n'),
		);
		const postReviewer = await writeFindings(
			'post_reviewer',
			ids.map((id) =>
				artifactRecord(id, 'CONFIRMED', 'route_to_critic', 'HIGH'),
			),
		);
		expect(postReviewer.success).toBe(true);
		// No CONFIRMED + handoff_to_feedback yet: no handoff claim.
		expect(postReviewer.handoff_required).toBe(false);
		await dispatchValidationLane(
			'r05-critic',
			'critic',
			ids,
			[
				'[CRITIC] | C-0 | UPHELD | HIGH | independently verified on the bound diff | no change required',
				'[CRITIC] | C-1 | DOWNGRADED | MEDIUM | claim holds only at reduced severity | narrow the fix scope',
				'[CRITIC] | C-2 | DISPROVED | NONE | the claim is not reproducible here | drop the finding',
			].join('\n'),
		);
		const postCritic = await writeFindings('post_critic', [
			artifactRecord('C-0', 'CONFIRMED', 'handoff_to_feedback', 'HIGH'),
			artifactRecord('C-1', 'CONFIRMED', 'handoff_to_feedback', 'MEDIUM'),
			artifactRecord('C-2', 'DISPROVED', 'suppress_with_reason', 'NONE'),
		]);
		expect(postCritic.success).toBe(true);
		// handoff_required fires because CONFIRMED rows carry handoff_to_feedback.
		expect(postCritic.handoff_required).toBe(true);
		// The DOWNGRADED projection persists the critic severity (MEDIUM),
		const jsonl = await fs.readFile(
			`${directory}/.swarm/pr-review/${RUN_ID}/findings.jsonl`,
			'utf-8',
		);
		const rowFor = (id: string, boundary: string) =>
			JSON.parse(
				jsonl
					.trim()
					.split('\n')
					.find(
						(line) =>
							line.includes(`"finding_id":"${id}"`) &&
							line.includes(`"boundary":"${boundary}"`),
					)!,
			) as Record<string, string>;
		expect(rowFor('C-1', 'post_reviewer').severity).toBe('HIGH');
		expect(rowFor('C-1', 'post_critic').severity).toBe('MEDIUM');
		expect(rowFor('C-2', 'post_critic')).toMatchObject({
			status: 'DISPROVED',
			severity: 'NONE',
			next_action: 'suppress_with_reason',
		});
	});

	test('a NEEDS_MORE_EVIDENCE critic row never settles its obligation', async () => {
		const ids = await driveDiscovery([
			{ id: 'C-0', dimension: PR_REVIEW_BASE_DIMENSION_IDS[0]! },
		]);
		await dispatchValidationLane(
			'r05-reviewer',
			'reviewer',
			ids,
			reviewedRow('C-0', 'CONFIRMED', 'HIGH'),
		);
		const postReviewer = await writeFindings('post_reviewer', [
			artifactRecord('C-0', 'CONFIRMED', 'route_to_critic', 'HIGH'),
		]);
		expect(postReviewer.success).toBe(true);
		// NME is nonterminal at the transport boundary: no settled receipt, so critic coverage stays unfulfilled.
		await dispatchValidationLane(
			'r05-critic',
			'critic',
			ids,
			'[CRITIC] | C-0 | NEEDS_MORE_EVIDENCE | MEDIUM | evidence was inconclusive | gather a reproducer first',
		);
		const postCritic = await writeFindings('post_critic', [
			artifactRecord('C-0', 'CONFIRMED', 'report', 'HIGH'),
		]);
		expect(postCritic.success).toBe(false);
		expect(String(postCritic.message)).toContain(
			'critic items lack an authenticated verdict',
		);
		expect(String(postCritic.message)).toContain('C-0');
		const completion = await toolCall('complete_pr_workflow', {
			mode: 'PR_REVIEW',
			pr_head_sha: HEAD_SHA,
			report_verdict: 'REQUEST_CHANGES',
		});
		// Completion is refused by the same typed critic-coverage gate: the NME row never settles on any path.
		expect(completion.success).toBe(false);
		expect(String(completion.message)).toContain(
			'critic items lack an authenticated verdict',
		);
		expect(String(completion.message)).toContain('C-0');
	});
});
