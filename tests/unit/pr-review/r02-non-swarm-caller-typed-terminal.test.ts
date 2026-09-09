import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
	findByCorrelationId,
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
	artifactRecord,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * #2585 frozen acceptance check C2 (AC1/R02), PRESERVING. The non-swarm
 * caller on a multi-swarm (prefixed-only) host reaches a typed terminal
 * state, never a hang: (A) a bare canonical agent is refused at dispatch
 * with the agent-not-registered refusal (#2614); (B) an accepted-then-
 * cancelled lane is stamped 'liveness' by cancel_pending and a PARTIAL run
 * completes INCOMPLETE through the typed-terminal admission (#2615); (C)
 * every tool response stays a bounded JSON payload.
 */

const SESSION_ID = 'r02-non-swarm-caller';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r02-typed-terminal-run';
const PREFIXED_NAMES = ['codereview_explorer', 'codereview_reviewer'];
// Shallow seam snapshots; afterEach restores every key so overrides cannot leak.
const originalGate = { ...gateInternals };
const originalDispatch = { ...dispatchInternals };
const originalTrigger = { ...triggerInternals };
let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let nextChild = 0;
let deliveredPrompts = new Map<string, string>();

const LANE_HEADERS = {
	'swarm-pr-review:base': CANDIDATE_HEADERS.base_explorer,
	'swarm-pr-review:micro': CANDIDATE_HEADERS.micro_lane,
} as const;

type Bounded = Record<string, unknown> & { success: boolean };
/** Every registered call must return a bounded JSON payload (leg C). */
function bounded(value: string): Bounded {
	expect(value.length).toBeLessThan(32_768);
	return JSON.parse(value) as Bounded;
}
async function tool(
	name: string,
	args: unknown,
	sessionID = SESSION_ID,
): Promise<Bounded> {
	return bounded(
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
async function finishLane(record: ReturnType<typeof findByBatchId>[number]) {
	const header = record.mode
		? (LANE_HEADERS as Record<string, string | undefined>)[record.mode]
		: undefined;
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
		eventId: `r02-${record.correlationId}`,
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
async function submitOne(
	record: ReturnType<typeof findByBatchId>[number],
): Promise<void> {
	const prompt = deliveredPrompts.get(record.subagentSessionId);
	if (!prompt) throw new Error('missing rendered child prompt');
	const owned =
		prompt
			.match(/^owned_workflow_lanes: (.+?) —/m)?.[1]
			?.split(',')
			.map((lane) => lane.trim()) ?? undefined;
	const envelopeLanes = owned ?? [promptField(prompt, 'workflow_lane')];
	const result = await tool(
		'submit_pr_review_result',
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
		record.subagentSessionId,
	);
	expect(result).toMatchObject({ success: true, status: 'recorded' });
}
async function submitAndFinish(batchId: string): Promise<void> {
	for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
		await submitOne(record);
		await finishLane(record);
	}
}
async function dispatch(
	batchId: string,
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro',
	workflowLanes: readonly (string | readonly string[])[],
	options: {
		agent?: string;
		triggerEvaluation?: PrReviewInlineTriggerRow[];
		expectRejected?: number;
	} = {},
): Promise<Bounded> {
	// Depth-tier M requires the FIRST base batch to partition all six base
	// dimensions across 3-6 lanes; single-dimension lanes are always valid.
	const lanes = workflowLanes.map((entry, index) => {
		const owned = typeof entry === 'string' ? [entry] : [...entry];
		return {
			id: `${mode.endsWith(':base') ? 'base' : 'micro'}-${index}`,
			agent: options.agent ?? 'explorer',
			prompt: `Review ${owned.join(', ')} on the exact bound diff.`,
			workflow_lane: owned[0]!,
			...(owned.length > 1 ? { owned_workflow_lanes: owned } : {}),
		};
	});
	const result = await tool('dispatch_lanes_async', {
		batch_id: batchId,
		mode,
		pr_head_sha: HEAD_SHA,
		base_sha: BASE_SHA,
		base_ref: 'origin/main',
		max_concurrent: lanes.length,
		...(options.triggerEvaluation
			? { trigger_evaluation: options.triggerEvaluation }
			: {}),
		lanes,
	});
	if (options.expectRejected !== undefined) {
		expect(result).toMatchObject({
			success: false,
			rejected: options.expectRejected,
			pending: 0,
		});
	} else {
		expect(result).toMatchObject({ success: true, pending: lanes.length });
	}
	return result;
}
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r02-nonswarm-');
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
	// The collect/cancel path needs a (messages, abort)-capable session ops
	// object, so the base registered client is widened for this fixture.
	const baseClient = createIssue2469HostClient({
		nextChildId: () => `r02-child-${++nextChild}`,
		onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
	});
	plugin = await bootKnowledgeHost(
		directory,
		{},
		{
			...baseClient,
			session: {
				...baseClient.session,
				messages: async () => ({ data: [], error: undefined }),
				abort: async () => ({ data: undefined, error: undefined }),
			},
		},
	);
});
afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	Object.assign(gateInternals, originalGate);
	Object.assign(dispatchInternals, originalDispatch);
	Object.assign(triggerInternals, originalTrigger);
	await removeTempDir();
});

describe('r02 non-swarm caller typed terminal (issue 2585, C2/AC1/R02)', () => {
	test('leg A: prefixed-only host refuses a bare agent at dispatch with the registered-names refusal', async () => {
		dispatchInternals.getGeneratedAgentNames = () => [...PREFIXED_NAMES];
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		// A structurally valid all-six partition (the tier-M gate must pass so
		// the refusal comes from lane-agent validation, not arg validation).
		const result = await dispatch(
			'r02-prefixed-refusal',
			'swarm-pr-review:base',
			[
				PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
				PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
				PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
			],
			{ agent: 'explorer', expectRejected: 3 },
		);
		const lanes = result.lane_results as Array<Record<string, unknown>>;
		expect(lanes).toHaveLength(3);
		for (const lane of lanes) {
			expect(lane.status).toBe('rejected');
			expect(String(lane.error)).toContain(
				'Agent "explorer" is not registered on this host',
			);
			expect(String(lane.error)).toContain(PREFIXED_NAMES.join(', '));
		}
		// No host session was created: the refusal is typed and immediate.
		expect(deliveredPrompts.size).toBe(0);
	});

	test('leg B: accepted-then-cancelled lane settles liveness and PARTIAL completes INCOMPLETE with disclosure', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const deadDimension = PR_REVIEW_BASE_DIMENSION_IDS[5]!;
		// Six single-dimension lanes: five complete; the sixth dies.
		await dispatch(
			'r02-base-ok',
			'swarm-pr-review:base',
			PR_REVIEW_BASE_DIMENSION_IDS,
		);
		const baseRecords = findByBatchId(directory, 'r02-base-ok', SESSION_ID);
		expect(baseRecords).toHaveLength(6);
		const dead = baseRecords.find(
			(record) => record.workflowLane === deadDimension,
		)!;
		expect(deliveredPrompts.has(dead.subagentSessionId)).toBe(true);
		// Submit + finish only the five live children.
		for (const record of baseRecords) {
			if (record.workflowLane === deadDimension) continue;
			await submitOne(record);
			await finishLane(record);
		}
		const cancelled = await tool('collect_lane_results', {
			batch_id: 'r02-base-ok',
			cancel_pending: true,
			timeout_ms: 5_000,
		});
		expect(cancelled).toMatchObject({ success: false, cancelled: 1 });
		const settled = findByBatchId(directory, 'r02-base-ok', SESSION_ID).find(
			(record) => record.workflowLane === deadDimension,
		)!;
		expect(settled.status).toBe('cancelled');
		expect(settled.result?.workflowLaneFailureClass).toBe('liveness');
		expect(
			findByCorrelationId(directory, settled.subagentSessionId)?.result
				?.workflowLaneFailureClass,
		).toBe('liveness');

		// Typed-terminal admission: the disclosure write ADMITS the liveness
		// dimension instead of refusing it as classless (#2615).
		const admission = await tool('write_pr_review_artifact', {
			kind: 'findings',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_explorer',
			records: [
				artifactRecord('CLEAN-REVIEW', 'PENDING', 'route_to_reviewer', 'NONE'),
			],
			partial_base_coverage: { unresolved_dimensions: [deadDimension] },
		});
		expect(admission.success).toBe(true);
		expect(JSON.stringify(admission)).not.toContain(
			'lacks a typed terminal failure',
		);
		const disclosed = (
			admission.partial_base_coverage as {
				unresolved_dimensions: Array<Record<string, string>>;
			}
		).unresolved_dimensions[0]!;
		expect(disclosed).toEqual({
			dimension: deadDimension,
			terminal_state: 'FAILED',
			reason_kind: 'lane_failure',
			failure_class: 'liveness',
		});

		// Micro wave + trigger ledger.
		const inlineTriggers: PrReviewInlineTriggerRow[] =
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
				trigger_id: triggerId,
				result: 'MATCHED',
				evidence: `The bound diff requires focused review for ${triggerId}.`,
			}));
		const triggerRows: Array<Record<string, string>> = [];
		for (const [offset, lane] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
			const batchId = `r02-micro-${offset}`;
			await dispatch(batchId, 'swarm-pr-review:micro', [lane], {
				triggerEvaluation: offset === 0 ? inlineTriggers : undefined,
			});
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
		expect(
			await tool('write_pr_review_trigger_eval', {
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				base_ref: 'origin/main',
				base_sha: BASE_SHA,
				rows: triggerRows,
			}),
		).toMatchObject({ success: true });

		// Reviewer over the sentinel inventory, then the findings ladder.
		await tool('dispatch_lanes_async', {
			batch_id: 'r02-reviewer',
			mode: 'swarm-pr-review:reviewer',
			pr_head_sha: HEAD_SHA,
			base_sha: BASE_SHA,
			base_ref: 'origin/main',
			max_concurrent: 1,
			lanes: [
				{
					id: 'r02-reviewer-lane',
					agent: 'reviewer',
					prompt: 'Classify the clean-review sentinel.',
					workflow_lane: 'r02-reviewer-lane',
					review_item_ids: ['CLEAN-REVIEW'],
				},
			],
		});
		await finishLane(findByBatchId(directory, 'r02-reviewer', SESSION_ID)[0]!);
		for (const boundary of ['post_reviewer', 'post_critic'] as const) {
			const write = await tool('write_pr_review_artifact', {
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
			});
			expect(write.success).toBe(true);
		}

		// Terminal: PARTIAL coverage completes truthfully as INCOMPLETE.
		const completion = (await tool('complete_pr_workflow', {
			mode: 'PR_REVIEW',
			pr_head_sha: HEAD_SHA,
			report_verdict: 'INCOMPLETE',
		})) as ReturnType<typeof tool> & {
			status: string;
			gate_cleared: boolean;
			terminal_report: {
				kind: string;
				covered_dimensions: string[];
				unresolved_dimensions: Array<{
					dimension: string;
					terminal_state: string;
					failure_class?: string;
				}>;
				live_dimensions: string[];
				allowed_verdicts: string[];
				report_verdict: string;
			};
		};
		expect(JSON.stringify(completion)).not.toContain(
			'lacks a typed terminal failure',
		);
		expect(completion).toMatchObject({
			success: true,
			status: 'completed',
			gate_cleared: true,
			terminal_report: {
				kind: 'PARTIAL',
				live_dimensions: [],
				report_verdict: 'INCOMPLETE',
			},
		});
		expect(completion.terminal_report.covered_dimensions).toHaveLength(5);
		expect(completion.terminal_report.unresolved_dimensions).toEqual([
			{
				dimension: deadDimension,
				terminal_state: 'FAILED',
				reason_kind: 'lane_failure',
				failure_class: 'liveness',
			},
		]);
		expect(completion.terminal_report.allowed_verdicts).toContain('INCOMPLETE');
		expect(completion.terminal_report.allowed_verdicts).not.toContain(
			'APPROVE',
		);
		// leg C: every response above flowed through the bounded() gate.
	}, 60_000);
});
