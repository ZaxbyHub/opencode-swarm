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
	AGENT_TOOL_MAP,
	WRITE_TOOL_NAMES,
} from '../../../src/config/constants';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { TOOL_NAMES } from '../../../src/tools/tool-names';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval';

const tempDirs: string[] = [];
const SESSION_ID = 'trigger-eval-session';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'review-revision';
const REVIEW_SCOPE = `complete PR diff def456...${HEAD_SHA}`;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalGateRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionDigest =
	writerInternals.resolvePrWorkflowRevisionDigest;
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
	const text = (input.ownedWorkflowLanes ?? [input.workflowLane])
		.map(
			(family) =>
				`[CLEAN] | ${family} | exact reviewed diff | no candidate survived the focused review`,
		)
		.join('\n');
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
	});
	for (const lane of baseLanes) {
		await recordCompletedLane(root, {
			batchId: 'base-all',
			laneId: lane.laneId,
			workflowLane: lane.workflowLane,
			mode: 'swarm-pr-review:base',
		});
	}
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
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolvePrWorkflowRevisionDigest = originalGateRevisionDigest;
	writerInternals.resolvePrWorkflowRevisionDigest =
		originalResolveRevisionDigest;
	writerInternals.resolveMergeBase = originalResolveMergeBase;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval', () => {
	test('is fully registered for Architect without becoming a generic write capability', () => {
		expect(TOOL_NAMES).toContain('write_pr_review_trigger_eval');
		expect(TOOL_MANIFEST.write_pr_review_trigger_eval).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('write_pr_review_trigger_eval');
		expect(
			(WRITE_TOOL_NAMES as readonly string[]).includes(
				'write_pr_review_trigger_eval',
			),
		).toBe(false);
	});
	test('writes the exact canonical trigger set atomically under .swarm', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-1805',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response).toMatchObject({
			success: true,
			matched_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
			no_match_count: 0,
			dispatched_micro_lane_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
		});
		const artifactPath = join(
			root,
			'.swarm',
			'pr-review',
			'review-1805',
			'trigger-eval.json',
		);
		expect(existsSync(artifactPath)).toBe(true);
		const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
		expect(artifact.rows).toHaveLength(PR_REVIEW_TRIGGER_DEFINITIONS.length);
		expect(artifact.rows[0]).toMatchObject({
			trigger_id: PR_REVIEW_TRIGGER_DEFINITIONS[0].id,
			scope: PR_REVIEW_TRIGGER_DEFINITIONS[0].scope,
			trigger_row: PR_REVIEW_TRIGGER_DEFINITIONS[0].trigger_row,
			micro_lane: PR_REVIEW_TRIGGER_DEFINITIONS[0].micro_lane,
			result: 'MATCHED',
		});
		expect(artifact).toMatchObject({
			base_ref: 'origin/main',
			base_sha: 'def456',
		});
	});

	test('rejects a claimed base SHA that is not the exact resolved merge base', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'merge-base-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: 'bad999',
					base_ref: 'origin/main',
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response.success).toBe(false);
		expect(response.message).toContain('merge-base mismatch');
		expect(
			existsSync(
				join(
					root,
					'.swarm',
					'pr-review',
					'merge-base-mismatch',
					'trigger-eval.json',
				),
			),
		).toBe(false);
	});

	test('rejects a live merge base that contradicts the durably bound review scope', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		writerInternals.resolveMergeBase = () => 'feed00';
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'bound-base-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: 'feed00',
					base_ref: 'origin/rebased-main',
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response.success).toBe(false);
		expect(response.message).toContain('scope mismatch');
		expect(
			existsSync(
				join(
					root,
					'.swarm',
					'pr-review',
					'bound-base-mismatch',
					'trigger-eval.json',
				),
			),
		).toBe(false);
	});

	for (const [name, establish, context] of [
		['without a current session', async (_root: string) => {}, {}],
		[
			'without an active gate',
			async (_root: string) => {},
			{ sessionID: SESSION_ID },
		],
		[
			'under PR_FEEDBACK',
			async (root: string) => {
				await activatePrWorkflow(root, SESSION_ID, 'PR_FEEDBACK');
			},
			{ sessionID: SESSION_ID },
		],
		[
			'under an unbound PR_REVIEW gate',
			async (root: string) => {
				await activatePrWorkflow(root, SESSION_ID, 'PR_REVIEW');
			},
			{ sessionID: SESSION_ID },
		],
	] as const) {
		test(`fails closed ${name} without writing an artifact`, async () => {
			const root = tempRoot();
			await establish(root);
			const response = JSON.parse(
				await executeWritePrReviewTriggerEval(
					{
						run_id: 'blocked-review',
						pr_head_sha: HEAD_SHA,
						base_sha: 'def456',
						rows: rows(),
					},
					root,
					context,
				),
			);
			expect(response.success).toBe(false);
			expect(response.message).toContain('active, bound PR_REVIEW gate');
			expect(
				existsSync(
					join(
						root,
						'.swarm',
						'pr-review',
						'blocked-review',
						'trigger-eval.json',
					),
				),
			).toBe(false);
		});
	}

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
			const result = JSON.parse(
				await executeWritePrReviewTriggerEval(
					{
						run_id: 'review-1805',
						pr_head_sha: 'abc123',
						rows: mutate(rows()),
					},
					tempRoot(),
				),
			);
			expect(result.success).toBe(false);
			expect(result.message).toContain(message);
		});
	}

	test('unknown-trigger-IDs error lists valid IDs and namespace boundaries (issue #1931)', async () => {
		// The reporter of #1931 fed the validator mode strings and base-lane
		// IDs. The error must surface the 11 valid micro-lane IDs and call
		// out the three namespaces so the next call succeeds.
		const confusedRows = [
			...rows().slice(0, 10),
			{
				trigger_id: 'swarm-pr-review:base',
				result: 'MATCHED' as const,
				evidence: 'confused mode string for trigger_id',
				source_batch_id: 'confused-batch',
				source_lane_id: 'confused-lane',
			},
		];
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-1931',
					pr_head_sha: 'abc123',
					rows: confusedRows,
				},
				tempRoot(),
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('unknown trigger IDs');
		// Must list ALL 11 valid IDs (issue #1931 reviewer item: a regression
		// that drops any ID from the error must fail this test).
		for (const validId of [
			'auth-identity-secrets',
			'untrusted-input-boundaries',
			'subprocess-platform',
			'concurrency-state',
			'dependencies-build-release',
			'api-schema-migrations',
			'test-infrastructure',
			'ui-accessibility-i18n',
			'privacy-observability',
			'generated-provenance',
			'unclassified-risk',
		]) {
			expect(result.message).toContain(validId);
		}
		// Must call out that base-lane IDs and mode strings are not trigger IDs.
		expect(result.message).toMatch(/base-lane IDs/i);
		expect(result.message).toMatch(/mode strings/i);
		expect(result.message).toMatch(/swarm-pr-review:base/);
	});

	test('rejects MATCHED rows missing dispatch provenance fields', async () => {
		const missing = rows();
		delete (missing[0] as { source_batch_id?: string }).source_batch_id;
		const missingResult = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: 'review-1805', pr_head_sha: 'abc123', rows: missing },
				tempRoot(),
			),
		);
		expect(missingResult.message).toContain('MATCHED rows require');
	});

	test('rejects a shared dispatch tuple whose lane never declared consolidated ownership', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const duplicate = rows();
		duplicate[1] = {
			...duplicate[0],
			trigger_id: duplicate[1].trigger_id,
		};
		const duplicateResult = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-1805',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: duplicate,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(duplicateResult.success).toBe(false);
		expect(duplicateResult.message).toContain(
			'does not reference a completed non-degraded micro-lane artifact',
		);
	});

	test('accepts consolidated micro lanes that declared and attested every owned family', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { consolidatedMicro: true });
		const sweepAFamilies = PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(0, 6);
		const consolidated = rows().map((row) => ({
			...row,
			source_batch_id: 'micro-consolidated',
			source_lane_id: (sweepAFamilies as readonly string[]).includes(
				row.trigger_id,
			)
				? 'sweep-a'
				: 'sweep-b',
		}));
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-consolidated',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: consolidated,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response).toMatchObject({
			success: true,
			matched_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
			no_match_count: 0,
			dispatched_micro_lane_count: 2,
		});
	});

	test('rejects a consolidated tuple citing a family outside its declared ownership', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root, { consolidatedMicro: true });
		const consolidated = rows().map((row) => ({
			...row,
			source_batch_id: 'micro-consolidated',
			source_lane_id: 'sweep-a',
		}));
		const result = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'review-overreach',
					pr_head_sha: HEAD_SHA,
					base_sha: 'def456',
					base_ref: 'origin/main',
					rows: consolidated,
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'does not reference a completed non-degraded micro-lane artifact',
		);
	});

	test('rejects any NO-MATCH waiver instead of guessing semantic applicability', async () => {
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
				tempRoot(),
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('MATCHED');
	});

	test('rejects traversal', async () => {
		const traversal = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{ run_id: '../escape', pr_head_sha: 'abc123', rows: rows() },
				tempRoot(),
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
