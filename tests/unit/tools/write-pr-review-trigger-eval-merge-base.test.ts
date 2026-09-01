import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	type PrReviewInlineTriggerRow,
	parsePrReviewTriggerReceipt,
} from '../../../src/background/pr-review-trigger-contract';
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

const tempDirs: string[] = [];
const SESSION_ID = 'trigger-eval-merge-base-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'review-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;

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
const originalResolveMergeBase = writerInternals.resolveMergeBase;
const originalResolveMergeBaseAsync = writerInternals.resolveMergeBaseAsync;

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'trigger-eval-mb-')));
	tempDirs.push(root);
	return root;
}

function artifactPath(root: string, runId: string): string {
	return join(root, '.swarm', 'pr-review', runId, 'trigger-eval.json');
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

function inlineRows(): PrReviewInlineTriggerRow[] {
	return rows().map(({ trigger_id, result, evidence }) => ({
		trigger_id,
		result,
		evidence,
	}));
}

async function recordCompletedLane(
	root: string,
	input: {
		batchId: string;
		laneId: string;
		workflowLane: string;
		mode: string;
	},
): Promise<void> {
	const correlationId = `${input.batchId}-${input.laneId}-session`;
	const header =
		input.mode === 'swarm-pr-review:base'
			? '[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags'
			: '[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
	const text = `${header}\n[CLEAN] | ${input.workflowLane} | exact reviewed diff | no candidate survived the focused review`;
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
		mode: input.mode as 'swarm-pr-review:base' | 'swarm-pr-review:micro',
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: input.workflowLane,
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
		mode: input.mode as 'swarm-pr-review:base' | 'swarm-pr-review:micro',
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

/**
 * Sibling-suite `establishBoundReviewGate`, with one deliberate difference: it
 * never stubs the SYNC `_internals.resolveMergeBase` member. Production selects
 * that member only while it is overridden, so a scaffold that stubs it (as the
 * six sibling suites do) can never exercise the async production path this file
 * is about. Only case (d) overrides it, explicitly (stub-member precision, WP-1).
 */
async function establishBoundReviewGate(root: string): Promise<void> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	await activatePrWorkflow(root, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(root, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: BASE_REF,
		baseSha: BASE_SHA,
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
	await bindPrReviewTriggerLedger(root, SESSION_ID, inlineRows());
	const microIds = PR_REVIEW_REQUIRED_MICRO_LANE_IDS;
	for (const [index, workflowLane] of microIds.entries()) {
		await recordCompletedLane(root, {
			batchId: `micro-batch-${Math.floor(index / 8)}`,
			laneId: `lane-${index}`,
			workflowLane,
			mode: 'swarm-pr-review:micro',
		});
	}
}

/** Strip the durably bound review base from gate state (unbound-gate fixture). */
function unbindReviewBase(root: string): void {
	const gateDir = join(root, '.swarm', 'pr-workflow-gates');
	const gatePath = join(gateDir, readdirSync(gateDir)[0]);
	const rawState = JSON.parse(readFileSync(gatePath, 'utf8'));
	delete rawState.prReviewBaseRef;
	delete rawState.prReviewBaseSha;
	writeFileSync(gatePath, `${JSON.stringify(rawState)}\n`, 'utf8');
	gateInternals.resetTrackedStateCache();
}

/**
 * Hand-written v2 receipt literal. Deliberately NOT produced by
 * `buildPrReviewTriggerReceiptV2`: pre-fix the builder cannot emit
 * `base_verification` at all, so a builder-produced fixture would round-trip
 * cleanly and the round-trip case would pass for the wrong reason.
 */
function v2ReceiptFixture(extra: Record<string, unknown> = {}) {
	const receiptRows = rows().map((row, index) => ({
		...row,
		scope: PR_REVIEW_TRIGGER_DEFINITIONS[index].scope,
		trigger_row: PR_REVIEW_TRIGGER_DEFINITIONS[index].trigger_row,
		micro_lane: PR_REVIEW_TRIGGER_DEFINITIONS[index].micro_lane,
	}));
	return {
		run_id: 'receipt-roundtrip',
		pr_head_sha: HEAD_SHA,
		base_ref: BASE_REF,
		base_sha: BASE_SHA,
		evaluated_at: '2026-08-19T00:00:00.000Z',
		dispatched_micro_lane_count: receiptRows.length,
		schema_version: 2,
		trigger_count: receiptRows.length,
		matched_count: receiptRows.length,
		not_triggered_count: 0,
		no_match_count: 0,
		rows: receiptRows,
		coverage_degradations: [],
		...extra,
	};
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
	writerInternals.resolveMergeBase = originalResolveMergeBase;
	writerInternals.resolveMergeBaseAsync = originalResolveMergeBaseAsync;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval merge-base re-verification — regression: transient merge-base unavailability permanently wedged the PR_REVIEW workflow (WP-1 / RC-B)', () => {
	test('(a) proceeds with base_verification bound_fallback when live re-derivation is unavailable but the received scope equals the bound scope', async () => {
		// Previous code treated a `null` from `resolveExactMergeBase` — which
		// collapses git timeout, spawn failure, unresolvable ref, and unsafe
		// revision token into one bare `null` — as REFUTATION and hard-failed
		// with "could not resolve the exact merge base". Every retry re-failed,
		// so `prReviewTriggerEvalPath` was never set and the workflow could only
		// be exited with abort_pr_workflow.
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const asyncStub = mock(async () => null);
		writerInternals.resolveMergeBaseAsync = asyncStub;
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'fallback-success',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: BASE_REF,
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response).toMatchObject({
			success: true,
			base_verification: 'bound_fallback',
		});
		expect(response.base_verification_note).toContain('disclosed');
		expect(asyncStub).toHaveBeenCalledTimes(1);
		const outputPath = artifactPath(root, 'fallback-success');
		expect(existsSync(outputPath)).toBe(true);
		const artifact = JSON.parse(readFileSync(outputPath, 'utf-8'));
		expect(artifact.base_verification).toBe('bound_fallback');
		expect(artifact).toMatchObject({
			base_ref: BASE_REF,
			base_sha: BASE_SHA,
			schema_version: 2,
		});
	});

	test('(b) fails closed with enriched null-cause diagnostics when the received scope is not the bound one', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		writerInternals.resolveMergeBaseAsync = mock(async () => null);
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'fallback-ref-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: 'origin/rebased-main',
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response.success).toBe(false);
		expect(response.message).toContain(
			'could not resolve the exact merge base',
		);
		expect(response.message).toContain('timed out');
		expect(response.message).toContain('spawn');
		expect(response.message).toContain('unsafe revision token');
		expect(response.message).toContain('abort_pr_workflow');
		expect(existsSync(artifactPath(root, 'fallback-ref-mismatch'))).toBe(false);

		// Same fail-closed branch when only the SHA half of the scope differs.
		const shaMismatch = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'fallback-sha-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: 'feed00',
					base_ref: BASE_REF,
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(shaMismatch.success).toBe(false);
		expect(shaMismatch.message).toContain(
			'could not resolve the exact merge base',
		);
		expect(existsSync(artifactPath(root, 'fallback-sha-mismatch'))).toBe(false);
	});

	test('(c) fails closed through the explicit unbound guard when gate state has no bound base_ref/base_sha', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		unbindReviewBase(root);
		writerInternals.resolveMergeBaseAsync = mock(async () => null);
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'unbound-guard',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: BASE_REF,
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response.success).toBe(false);
		expect(response.message).toContain('durably bound review base');
		expect(existsSync(artifactPath(root, 'unbound-guard'))).toBe(false);
	});

	test('(d) keeps resolved-mismatch and frozen-scope-mismatch semantics unchanged when the sync seam is overridden', async () => {
		const mismatchRoot = tempRoot();
		await establishBoundReviewGate(mismatchRoot);
		const syncStub = mock(() => BASE_SHA);
		writerInternals.resolveMergeBase = syncStub;
		const asyncStub = mock(async () => null);
		writerInternals.resolveMergeBaseAsync = asyncStub;
		const mismatch = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'merge-base-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: 'bad999',
					base_ref: BASE_REF,
					rows: rows(),
				},
				mismatchRoot,
				{ sessionID: SESSION_ID },
			),
		);
		expect(mismatch.success).toBe(false);
		expect(mismatch.message).toContain('merge-base mismatch');
		// The overridden sync member wins AND actually ran; the async twin is never
		// consulted, so the fallback branch cannot mask a real refutation.
		expect(syncStub).toHaveBeenCalledTimes(1);
		expect(asyncStub).not.toHaveBeenCalled();
		expect(existsSync(artifactPath(mismatchRoot, 'merge-base-mismatch'))).toBe(
			false,
		);

		const scopeRoot = tempRoot();
		await establishBoundReviewGate(scopeRoot);
		writerInternals.resolveMergeBase = () => 'feed00';
		const scope = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'bound-base-mismatch',
					pr_head_sha: HEAD_SHA,
					base_sha: 'feed00',
					base_ref: 'origin/rebased-main',
					rows: rows(),
				},
				scopeRoot,
				{ sessionID: SESSION_ID },
			),
		);
		expect(scope.success).toBe(false);
		expect(scope.message).toContain('scope mismatch');
		expect(existsSync(artifactPath(scopeRoot, 'bound-base-mismatch'))).toBe(
			false,
		);
	});

	test('(e) round-trips a v2 receipt carrying base_verification and still accepts both legacy receipt shapes', () => {
		const withField = parsePrReviewTriggerReceipt(
			v2ReceiptFixture({ base_verification: 'bound_fallback' }),
		);
		expect(withField.schemaVersion).toBe(2);
		expect(withField.baseVerification).toBe('bound_fallback');
		expect(withField.matchedRows).toHaveLength(
			PR_REVIEW_TRIGGER_DEFINITIONS.length,
		);

		const withoutField = parsePrReviewTriggerReceipt(v2ReceiptFixture());
		expect(withoutField.schemaVersion).toBe(2);
		expect(withoutField.baseVerification).toBeUndefined();

		const legacyV1 = parsePrReviewTriggerReceipt({
			run_id: 'legacy-v1',
			pr_head_sha: HEAD_SHA,
			base_ref: BASE_REF,
			base_sha: BASE_SHA,
			evaluated_at: '2026-08-19T00:00:00.000Z',
			dispatched_micro_lane_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
			schema_version: 1,
			trigger_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
			matched_count: PR_REVIEW_TRIGGER_DEFINITIONS.length,
			no_match_count: 0,
			rows: rows(),
		});
		expect(legacyV1.schemaVersion).toBe(1);
		expect(legacyV1.baseVerification).toBeUndefined();

		const legacyUnversioned = parsePrReviewTriggerReceipt({
			rows: rows(),
		});
		expect(legacyUnversioned.schemaVersion).toBe(0);
		expect(legacyUnversioned.matchedRows).toHaveLength(
			PR_REVIEW_TRIGGER_DEFINITIONS.length,
		);
	});

	test('(f) routes to the async merge-base twin when the sync seam is not overridden and discloses base_verification live', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		const asyncStub = mock(async () => BASE_SHA);
		writerInternals.resolveMergeBaseAsync = asyncStub;
		const response = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'async-seam',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: BASE_REF,
					rows: rows(),
				},
				root,
				{ sessionID: SESSION_ID },
			),
		);
		expect(response).toMatchObject({
			success: true,
			base_verification: 'live',
		});
		expect(asyncStub).toHaveBeenCalledTimes(1);
		expect(asyncStub).toHaveBeenCalledWith(root, BASE_REF, HEAD_SHA);
		const artifact = JSON.parse(
			readFileSync(artifactPath(root, 'async-seam'), 'utf-8'),
		);
		expect(artifact.base_verification).toBe('live');
	});
});
