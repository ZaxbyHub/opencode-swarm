import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
	bindPrWorkflowHead,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	prWorkflowSessionFileStem,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import {
	_internals as checkoutInternals,
	executePreparePrWorkflowCheckout,
} from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	artifactRecord,
	PR_ARTIFACT_SESSION_ID,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * #2585 checks C13+C21 (AC8+AC14/R16): registered workflow preserves dirty
 * tracked + untracked user changes and restores branch/head with retained workflow stash.
 */
const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r16-user-checkout';
const CONFIG_PATH = 'config.json';
const UNTRACKED_PATH = 'user-notes.txt';
const originalRunGit = checkoutInternals.runGit;
let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let nextChild = 0;
let deliveredPrompts = new Map<string, string>();
let headSha = '';
let baseBranch = '';
let baseHead = '';
let restoreGateSeams: () => void = () => undefined;
let restoreDispatchSeams: () => void = () => undefined;
let restoreTriggerSeams: () => void = () => undefined;
function pinSeams(
	host: Record<string, unknown>,
	stubs: Record<string, unknown>,
): () => void {
	const saved = new Map(
		Object.keys(stubs).map((key) => [key, host[key]] as const),
	);
	for (const [key, value] of Object.entries(stubs)) host[key] = value;
	return () => {
		for (const [key, value] of saved) host[key] = value;
	};
}
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
const parsed = (
	value: string,
): Record<string, unknown> & { success: boolean } =>
	JSON.parse(value) as Record<string, unknown> & { success: boolean };
function stats() {
	return { changedLines: 400, changedFiles: 12, hasSubmoduleChange: false };
}
async function git(args: readonly string[]): Promise<string> {
	const result = await originalRunGit(directory, [...args], {
		captureStdout: true,
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0]} failed (exit ${result.exitCode})`);
	}
	return result.stdout.trim();
}
function cleanEnvelope(workflowLanes: readonly string[]) {
	return {
		schemaVersion: 1,
		outcome: 'CLEAN',
		creditedLanes: [...workflowLanes],
		findings: [],
		cleanAttestations: workflowLanes.map((workflowLane) => ({
			coverageScope: `Complete ${workflowLane} surface on the bound diff.`,
			evidence: 'Registered child found no defect in the user checkout.',
			workflowLane,
		})),
		unresolved: [],
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
		prHeadSha: headSha,
		gitHead: headSha,
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
		const promptOwnedLanes = prompt
			.match(/^owned_workflow_lanes: (.+?) —/m)?.[1]
			?.split(',')
			.map((lane) => lane.trim()) ?? [promptField('workflow_lane')];
		const result = parsed(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						batchId: promptField('batch_id'),
						laneId: promptField('lane_id'),
						revisionDigest: promptField('revision_digest'),
						result: cleanEnvelope(promptOwnedLanes),
					},
					{ directory, sessionID: record.subagentSessionId },
				),
			),
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
		const header =
			record.mode === 'swarm-pr-review:micro'
				? CANDIDATE_HEADERS.micro_lane
				: CANDIDATE_HEADERS.base_explorer;
		await finishRecord(
			record,
			`${header}\n[CLEAN] | ${record.workflowLane} | exact reviewed diff | no actionable finding survived`,
		);
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
					pr_head_sha: headSha,
					base_sha: BASE_SHA,
					base_ref: 'origin/main',
					max_concurrent: lanes.length,
					orientation: false,
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
async function writeFindings(
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
	status: 'PENDING' | 'DISPROVED',
	nextAction: 'route_to_reviewer' | 'suppress_with_reason',
): Promise<void> {
	const result = parsed(
		String(
			await plugin.tool.write_pr_review_artifact.execute(
				{
					kind: 'findings',
					run_id: RUN_ID,
					pr_head_sha: headSha,
					boundary,
					records: [artifactRecord('CLEAN-REVIEW', status, nextAction, 'NONE')],
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(result.success).toBe(true);
}
async function readFileOrMissing(relative: string): Promise<string | null> {
	try {
		return await fs.readFile(path.join(directory, relative), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r16-user-checkout-');
	await initializeGitRepository(directory);
	deliveredPrompts = new Map();
	nextChild = 0;
	gateInternals.resetTrackedStateCache();
	restoreGateSeams = pinSeams(
		gateInternals as unknown as Record<string, unknown>,
		{
			resolveCurrentGitHead: () => headSha,
			resolveCurrentGitHeadAsync: async () => headSha,
			resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
			resolvePrWorkflowRevisionDigestDetailed: () => ({
				ok: true,
				digest: REVISION_DIGEST,
			}),
			resolveIsWorkingTreeClean: () => true,
			resolveIsWorkingTreeCleanAsync: async () => true,
			resolvePrReviewDiffStats: () => stats(),
			resolvePrReviewDiffStatsAsync: async () => stats(),
		},
	);
	restoreDispatchSeams = pinSeams(
		dispatchInternals as unknown as Record<string, unknown>,
		{
			resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
			resolveExactMergeBaseAsync: async () => BASE_SHA,
			loadPluginConfig: () => ({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: false,
				},
			}),
			getGeneratedAgentNames: () => ['explorer', 'reviewer'],
		},
	);
	restoreTriggerSeams = pinSeams(
		triggerInternals as unknown as Record<string, unknown>,
		{
			resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
			resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
			resolveMergeBase: () => BASE_SHA,
			resolveMergeBaseAsync: async () => BASE_SHA,
		},
	);
	await git(['config', 'user.email', 'r16@example.com']);
	await git(['config', 'user.name', 'R16 Checkout Fixture']);
	await git(['config', 'core.autocrlf', 'false']);
	await fs.writeFile(path.join(directory, CONFIG_PATH), '{"dirty":false}\n');
	await git(['add', '.']);
	await git(['commit', '-m', 'base']);
	baseBranch = await git(['symbolic-ref', '--short', 'HEAD']);
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r16-child-${++nextChild}`,
			onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
		}),
	);
	// Race: plugin rewrites the host config post-boot; poll (PRR-006, 20x50ms).
	const cfg = path.join(directory, '.opencode/opencode-swarm.json');
	const boot = await fs.readFile(cfg, 'utf8');
	for (let i = 0; i < 20 && (await fs.readFile(cfg, 'utf8')) === boot; i++)
		await new Promise((r) => setTimeout(r, 50));
	await git(['add', '.opencode']);
	await git(['commit', '-m', 'host config']);
	baseHead = await git(['rev-parse', 'HEAD']);
	await git(['switch', '-c', 'review-head']);
	await fs.writeFile(path.join(directory, 'review.txt'), 'review\n');
	await git(['add', 'review.txt']);
	await git(['commit', '-m', 'review']);
	headSha = await git(['rev-parse', 'HEAD']);
	await git(['switch', baseBranch]);
	expect(await git(['status', '--porcelain'])).toBe('');
	await fs.writeFile(path.join(directory, CONFIG_PATH), '{"dirty":true}\n');
	await fs.writeFile(path.join(directory, UNTRACKED_PATH), 'user scratch\n');
});
afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	restoreGateSeams();
	restoreDispatchSeams();
	restoreTriggerSeams();
	await removeTempDir();
});
describe('R16 user checkout preservation through the registered path (#2585 C13+C21/AC8+AC14)', () => {
	test('discovery prepare stashes user changes; registered restore returns them and retains the workflow safety stash', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		const prepared = parsed(
			String(
				await executePreparePrWorkflowCheckout({}, directory, {
					sessionID: SESSION_ID,
				}),
			),
		);
		expect(prepared).toMatchObject({
			success: true,
			discovered: true,
			included_untracked: true,
		});
		const stashOid = String(prepared.stash_oid);
		expect(prepared.paths).toEqual([CONFIG_PATH, UNTRACKED_PATH].sort());
		// The stashed tree is clean; the workflow takes the PR head checkout.
		expect(await readFileOrMissing(CONFIG_PATH)).toBe('{"dirty":false}\n');
		expect(await readFileOrMissing(UNTRACKED_PATH)).toBeNull();
		await git(['switch', '--detach', headSha]);
		await bindPrWorkflowHead(directory, SESSION_ID, headSha);
		// Registered workflow to completion (exemplar CLEAN path).
		await dispatch('r16-base', 'swarm-pr-review:base', [
			PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
		]);
		await submitAndFinish('r16-base');
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
			const lanes = PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(offset, offset + 6);
			const batchId = `r16-micro-${offset / 6}`;
			await dispatch(
				batchId,
				'swarm-pr-review:micro',
				lanes,
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
						pr_head_sha: headSha,
						base_ref: 'origin/main',
						base_sha: BASE_SHA,
						rows: triggerRows,
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(trigger.success).toBe(true);
		await writeFindings('post_explorer', 'PENDING', 'route_to_reviewer');
		const reviewerBatchId = `${RUN_ID}-reviewer`;
		const reviewer = parsed(
			String(
				await plugin.tool.dispatch_lanes_async.execute(
					{
						batch_id: reviewerBatchId,
						mode: 'swarm-pr-review:reviewer',
						pr_head_sha: headSha,
						base_sha: BASE_SHA,
						base_ref: 'origin/main',
						max_concurrent: 1,
						lanes: [
							{
								id: `${reviewerBatchId}-lane`,
								agent: 'reviewer',
								prompt: 'Classify the clean-review sentinel.',
								workflow_lane: `${reviewerBatchId}-lane`,
								review_item_ids: ['CLEAN-REVIEW'],
							},
						],
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		await finishRecord(
			findByBatchId(directory, reviewerBatchId, SESSION_ID)[0]!,
			reviewedRow('CLEAN-REVIEW', 'DISPROVED', 'NONE'),
		);
		await writeFindings('post_reviewer', 'DISPROVED', 'suppress_with_reason');
		await writeFindings('post_critic', 'DISPROVED', 'suppress_with_reason');
		const completion = parsed(
			String(
				await plugin.tool.complete_pr_workflow.execute(
					{
						mode: 'PR_REVIEW',
						pr_head_sha: headSha,
						report_verdict: 'APPROVE',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(completion).toMatchObject({
			success: true,
			status: 'completed',
			gate_cleared: true,
			checkout_restore_required: true,
			checkout_restore_receipts: [{ stash_oid: stashOid, stash_present: true }],
		});
		// NEGATIVE: gate clear is NOT restoration (AC8).
		expect(await readFileOrMissing(CONFIG_PATH)).toBe('{"dirty":false}\n');
		expect(await readFileOrMissing(UNTRACKED_PATH)).toBeNull();
		expect(await git(['branch', '--show-current'])).not.toBe(baseBranch);
		// Registered restore through the tool (AC14).
		const restore = parsed(
			String(
				await plugin.tool.prepare_pr_workflow_checkout.execute(
					{ operation: 'restore' },
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(restore).toMatchObject({
			success: true,
			restored: true,
			stash_oid: stashOid,
			original_head: baseHead,
			original_branch: baseBranch,
			restored_head: baseHead,
			receipt_cleanup_pending: false,
		});
		expect(restore.retained_stash_oids).toContain(stashOid);
		expect(restore.stash_retained).toBe(true);
		expect(restore.stash_retention_verified).toBe(true);
		expect(await git(['branch', '--show-current'])).toBe(baseBranch);
		expect(await git(['rev-parse', 'HEAD'])).toBe(baseHead);
		expect(await readFileOrMissing(CONFIG_PATH)).toBe('{"dirty":true}\n');
		expect(await readFileOrMissing(UNTRACKED_PATH)).toBe('user scratch\n');
		const receiptPath = path.join(
			directory,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(SESSION_ID),
			`${stashOid}.json`,
		);
		await expect(fs.stat(receiptPath)).rejects.toThrow(/ENOENT/);
		expect(await git(['stash', 'list', '--format=%H'])).toContain(stashOid);
	}, 60_000);
});
