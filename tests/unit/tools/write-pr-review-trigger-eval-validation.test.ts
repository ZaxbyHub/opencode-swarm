import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// Split from write-pr-review-trigger-eval.test.ts (FR-006): row-shape,
// provenance-field, traversal, and skill-table parity validation cases.

const tempDirs: string[] = [];
const SESSION_ID = 'trigger-eval-session';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'review-revision';
const REVIEW_SCOPE = `complete PR diff def456...${HEAD_SHA}`;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalGateRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionDigest =
	writerInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionDigestAsync =
	writerInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBase = writerInternals.resolveMergeBase;

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'trigger-eval-')));
	tempDirs.push(root);
	return root;
}

function rows() {
	return PR_REVIEW_TRIGGER_DEFINITIONS.map((definition, index) => ({
		trigger_id: definition.id,
		result: 'MATCHED' as const,
		evidence: `mandatory review focus for ${definition.id}`,
		source_batch_id: `micro-batch-${Math.floor(index / 8)}`,
		source_lane_id: `lane-${index}`,
	}));
}

async function recordCompletedLane(
	root: string,
	input: {
		batchId: string;
		laneId: string;
		workflowLane: string;
		mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro';
		ownedWorkflowLanes?: string[];
	},
): Promise<void> {
	const correlationId = `${input.batchId}-${input.laneId}-session`;
	const header =
		input.mode === 'swarm-pr-review:base'
			? '[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags'
			: '[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
	const cleanRows = (input.ownedWorkflowLanes ?? [input.workflowLane])
		.map(
			(family) =>
				`[CLEAN] | ${family} | exact reviewed diff | no candidate survived the focused review`,
		)
		.join('\n');
	const text = `${header}\n${cleanRows}`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${input.batchId}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: input.batchId,
		laneId: input.laneId,
		mode: input.mode,
		workflowLane: input.workflowLane,
		ownedWorkflowLanes: input.ownedWorkflowLanes,
		prReviewLegacyTranscriptCompatibility: true,
		workspace: {
			directory: root,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: REVIEW_SCOPE,
		},
	});
	const stored = storeLaneOutput(root, {
		batchId: input.batchId,
		laneId: input.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: input.mode,
		workflowLane: input.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: REVIEW_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(root, correlationId, {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

async function establishBoundReviewGate(
	root: string,
	options: { consolidatedMicro?: boolean } = {},
): Promise<void> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => 'def456';
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	await activatePrWorkflow(root, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(root, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: 'def456',
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(root, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	for (const lane of baseLanes) {
		await recordCompletedLane(root, {
			batchId: 'base-all',
			laneId: lane.laneId,
			workflowLane: lane.workflowLane,
			mode: 'swarm-pr-review:base',
		});
	}
	await bindPrReviewTriggerLedger(
		root,
		SESSION_ID,
		rows().map(({ trigger_id, result, evidence }) => ({
			trigger_id,
			result,
			evidence,
		})),
	);
	if (options.consolidatedMicro) {
		const sweepA = [...PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(0, 6)];
		const sweepB = [...PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(6)];
		await recordCompletedLane(root, {
			batchId: 'micro-consolidated',
			laneId: 'sweep-a',
			workflowLane: sweepA[0],
			ownedWorkflowLanes: sweepA,
			mode: 'swarm-pr-review:micro',
		});
		await recordCompletedLane(root, {
			batchId: 'micro-consolidated',
			laneId: 'sweep-b',
			workflowLane: sweepB[0],
			ownedWorkflowLanes: sweepB,
			mode: 'swarm-pr-review:micro',
		});
		return;
	}
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		await recordCompletedLane(root, {
			batchId: `micro-batch-${Math.floor(index / 8)}`,
			laneId: `lane-${index}`,
			workflowLane,
			mode: 'swarm-pr-review:micro',
		});
	}
}

afterEach(() => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalGateRevisionDigest;
	writerInternals.resolvePrWorkflowRevisionDigest =
		originalResolveRevisionDigest;
	writerInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionDigestAsync;
	writerInternals.resolveMergeBase = originalResolveMergeBase;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval - row validation', () => {
	for (const [name, mutate, message] of [
		[
			'missing rows',
			(value: ReturnType<typeof rows>) => value.slice(1),
			'missing trigger IDs',
		],
		[
			'extra rows',
			(value: ReturnType<typeof rows>) => [
				...value,
				{
					trigger_id: 'extra',
					result: 'MATCHED' as const,
					evidence: 'mandatory extra',
					source_batch_id: 'extra-batch',
					source_lane_id: 'extra-lane',
				},
			],
			'unknown trigger IDs',
		],
		[
			'duplicate rows',
			(value: ReturnType<typeof rows>) => [...value, value[0]],
			'duplicate trigger IDs',
		],
	] as const) {
		test(`rejects ${name}`, async () => {
			const root = tempRoot();
			await establishBoundReviewGate(root);
			const result = JSON.parse(
				await executeWritePrReviewTriggerEval(
					{
						run_id: 'review-1805',
						pr_head_sha: 'abc123',
						rows: mutate(rows()),
					},
					root,
					{ sessionID: SESSION_ID },
				),
			);
			expect(result.success).toBe(false);
			expect(result.message).toContain(message);
		});
	}

	test('rejects MATCHED rows missing dispatch provenance fields', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const missing = rows();
		delete (missing[0] as { source_batch_id?: string }).source_batch_id;
		const missingResult = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: 'review-1805', pr_head_sha: 'abc123', rows: missing },
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(missingResult.message).toContain('MATCHED rows require');
	});

	test('rejects any NO-MATCH waiver instead of guessing semantic applicability', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const waived = rows() as Array<Record<string, unknown>>;
		waived[0] = {
			trigger_id: PR_REVIEW_TRIGGER_DEFINITIONS[0].id,
			result: 'NO-MATCH',
			evidence: 'architect claims this family is irrelevant',
		};
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-waiver',
					pr_head_sha: 'abc123',
					rows: waived,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('NO-MATCH');
		expect(result.message).toContain('MATCHED');
		expect(result.message).toContain('NOT_TRIGGERED');
	});

	test('binds the revision digest off the blocking synchronous path', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		// Restore the sync seam to its real implementation so the selection rule
		// must fall through to the async twin; a regression to the blocking
		// resolver would shell out to real git here instead.
		writerInternals.resolvePrWorkflowRevisionDigest =
			originalResolveRevisionDigest;
		let asyncCalls = 0;
		writerInternals.resolvePrWorkflowRevisionDigestAsync = async () => {
			asyncCalls += 1;
			return REVISION_DIGEST;
		};
		const args = {
			run_id: 'async-digest',
			pr_head_sha: HEAD_SHA,
			base_sha: 'def456',
			base_ref: 'origin/main',
			rows: rows(),
		};
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(args, root, {
				sessionID: SESSION_ID,
			}),
		);
		expect(response).toMatchObject({ success: true });
		expect(asyncCalls).toBe(1);
	});

	test('rejects traversal', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const traversal = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: '../escape', pr_head_sha: 'abc123', rows: rows() },
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(traversal.success).toBe(false);
	});

	test('canonical trigger definitions stay in exact parity with the skill table', () => {
		expect(
			PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => definition.id),
		).toEqual([...PR_REVIEW_REQUIRED_MICRO_LANE_IDS]);
		const skill = readFileSync(
			join(process.cwd(), '.opencode/skills/swarm-pr-review/SKILL.md'),
			'utf-8',
		);
		const section = skill.slice(
			skill.indexOf('### Repository-agnostic mandatory micro-lane map'),
			skill.indexOf('Micro-lane output format:'),
		);
		const tablePairs = [
			...section.matchAll(/^\| `([^`]+)` \| ([^|]+) \| [^|]+ \| ([^|]+) \|/gm),
		].map((match) => [match[1], match[2].trim(), match[3].trim()]);
		expect(tablePairs).toEqual(
			PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => [
				definition.id,
				definition.scope,
				definition.micro_lane,
			]),
		);
	});
});
