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
import {
	PR_REVIEW_REQUIRED_TRIGGER_IDS,
	PR_REVIEW_TRIGGER_DEFINITIONS,
} from '../../../src/background/pr-review-trigger-contract.js';
import { handlePrReviewCommand } from '../../../src/commands/pr-review.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * #2585 frozen acceptance check C1 (AC1/R01), PRESERVING.
 *
 * Entry + binding on the registered host: the /swarm pr-review command module
 * names MODE: PR_REVIEW in its usage and dispatch signal; MODE activation plus
 * the first structured base dispatch bind the exact root/session/run/head/base
 * (gate fields sessionID / prHeadSha / prReviewBaseSha / prReviewReservedRunId
 * / workflowInstanceId); structured children ride the host client's
 * session.create + promptAsync and the rendered child prompt carries
 * batch_id / lane_id / workflow_lane / revision_digest / owned_workflow_lanes
 * (registered-host pattern from registered-complete-workflow.test.ts).
 */

const SESSION_ID = 'r01-entry-binding';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r01-entry-binding-run';
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
let createdChildren: string[] = [];
let deliveredPrompts = new Map<string, string>();

/**
 * Windows: the booted plugin host's post-init background tasks can hold the
 * temp directory for a few ms after the test body ends (transient EBUSY).
 * Bounded ENOENT-tolerant retry per the writing-tests skill.
 */
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

function parsed(value: string): Record<string, unknown> & { success: boolean } {
	return JSON.parse(value) as Record<string, unknown> & { success: boolean };
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
			: CANDIDATE_HEADERS.base_explorer;
	const text = `${header}\n[CLEAN] | ${record.workflowLane} | exact bound diff | registered child found no actionable defect`;
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
		eventId: `r01-${record.correlationId}`,
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
		expect(promptField(prompt, 'batch_id')).toBe(batchId);
		await finishLane(record);
	}
}
async function dispatch(
	batchId: string,
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro',
	workflowLanes: readonly (string | readonly string[])[],
	triggerEvaluation?: PrReviewInlineTriggerRow[],
): Promise<void> {
	const lanes = workflowLanes.map((entry) => {
		const owned = typeof entry === 'string' ? [entry] : [...entry];
		return {
			id: `${mode.endsWith(':base') ? 'base' : 'micro'}-${owned.join('-')}`,
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
	directory = canonicalMkdtemp('pr-review-r01-entry-');
	await initializeGitRepository(directory);
	createdChildren = [];
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
			nextChildId: () => {
				const id = `r01-child-${createdChildren.length + 1}`;
				createdChildren.push(id);
				return id;
			},
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

describe('r01 entry + binding (issue 2585, C1/AC1/R01)', () => {
	test('the /swarm pr-review command usage and dispatch plan name PR_REVIEW mode', () => {
		const usage = handlePrReviewCommand(directory, []);
		expect(usage).toContain('Usage: /swarm pr-review');
		expect(usage).toContain('Run a full swarm PR review');
		// The dispatch signal is the guidance contract the architect consumes.
		const signal = handlePrReviewCommand(directory, [
			'https://github.com/owner/repo/pull/42',
		]);
		expect(signal).toContain(
			'[MODE: PR_REVIEW pr="https://github.com/owner/repo/pull/42" council=false]',
		);
		const withInstructions = handlePrReviewCommand(directory, [
			'owner/repo#42',
			'focus',
			'on',
			'auth',
		]);
		expect(withInstructions).toContain('[MODE: PR_REVIEW ');
		expect(withInstructions).toContain('focus on auth');
		expect(
			handlePrReviewCommand(directory, [
				'https://github.com/owner/repo/pull/42',
				'--council',
			]),
		).toContain('council=true');
		expect(
			handlePrReviewCommand(directory, [
				'https://github.com/owner/repo/pull/42',
				'--not-a-flag',
			]),
		).toContain('Error: Unknown flag "--not-a-flag"');
	});

	test('registered activation + structured dispatch bind exact root/session/run/head/base and child prompts', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const activated = (await readPrWorkflowGateState(directory, SESSION_ID))!;
		// Root/session/head/instance bound at activation; base binds only at the
		// first structured base dispatch, and the run id at the first artifact.
		expect(activated.mode).toBe('PR_REVIEW');
		expect(activated.sessionID).toBe(SESSION_ID);
		expect(activated.prHeadSha).toBe(HEAD_SHA);
		expect(activated.workflowInstanceId).toBeTruthy();
		expect(activated.prReviewBaseSha).toBeUndefined();

		await dispatch('r01-base', 'swarm-pr-review:base', [
			PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
		]);
		const bound = (await readPrWorkflowGateState(directory, SESSION_ID))!;
		expect(bound.prReviewBaseSha).toBe(BASE_SHA);
		expect(bound.prReviewBaseRef).toBe('origin/main');
		expect(bound.prHeadSha).toBe(HEAD_SHA);
		expect(bound.prReviewBaseDispatches?.[0]?.batchId).toBe('r01-base');

		// Structured children ride host session.create/promptAsync: every base
		// lane got its own child session and a rendered prompt.
		expect(createdChildren).toHaveLength(3);
		for (const record of findByBatchId(directory, 'r01-base', SESSION_ID)) {
			const prompt = deliveredPrompts.get(record.subagentSessionId);
			expect(prompt).toBeTruthy();
			expect(promptField(prompt!, 'batch_id')).toBe('r01-base');
			expect(promptField(prompt!, 'lane_id')).toBe(record.laneId);
			expect(promptField(prompt!, 'workflow_lane')).toBe(record.workflowLane);
			expect(promptField(prompt!, 'revision_digest')).toBe(REVISION_DIGEST);
			const owned = prompt!
				.match(/^owned_workflow_lanes: (.+?) —/m)?.[1]
				?.split(',')
				.map((lane) => lane.trim());
			expect(owned).toEqual(record.ownedWorkflowLanes);
			expect(owned).toHaveLength(2);
		}
		await submitAndFinish('r01-base');

		// Micro wave freezes the trigger ledger over all eleven families.
		const inlineTriggers: PrReviewInlineTriggerRow[] =
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
				trigger_id: triggerId,
				result: 'MATCHED',
				evidence: `The bound diff requires focused review for ${triggerId}.`,
			}));
		const triggerRows: Array<Record<string, string>> = [];
		for (const [offset, lane] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
			const batchId = `r01-micro-${offset}`;
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
		expect(trigger.success).toBe(true);
		// The run id is now durably reserved on the gate state.
		const reserved = (await readPrWorkflowGateState(directory, SESSION_ID))!;
		expect(reserved.prReviewReservedRunId).toBe(RUN_ID);
		expect(reserved.prReviewTriggerEvalRunId).toBe(RUN_ID);
		// Every structured child settled with a structured receipt on the exact
		// bound identity.
		for (const record of findByBatchId(directory, 'r01-base', SESSION_ID)) {
			const receipt = findByCorrelationId(directory, record.subagentSessionId)
				?.result?.prReviewResultReceipt;
			expect(receipt?.workflowInstanceId).toBe(
				activated.workflowInstanceId ?? reserved.workflowInstanceId,
			);
			expect(receipt?.headSha).toBe(HEAD_SHA);
			expect(receipt?.baseSha).toBe(BASE_SHA);
		}
		expect(PR_REVIEW_REQUIRED_TRIGGER_IDS).toHaveLength(
			PR_REVIEW_TRIGGER_DEFINITIONS.length,
		);
	});
});
