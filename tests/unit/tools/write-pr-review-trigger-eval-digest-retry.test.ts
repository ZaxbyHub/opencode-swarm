import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	bindPrReviewTriggerLedger,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate';
import {
	executeWritePrReviewTriggerEval,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const tempDirs: string[] = [];
const SESSION_ID = 'trigger-eval-digest-retry-session';
const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const BASE_REF = 'origin/main';
const REVISION_DIGEST = 'review-revision';
const REVIEW_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const DIGEST_FAILURE = /could not bind the current exact revision digest/i;

const originals = {
	resolveCurrentGitHead: gateInternals.resolveCurrentGitHead,
	resolveCurrentGitHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeClean: gateInternals.resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	gateDigest: gateInternals.resolvePrWorkflowRevisionDigest,
	writerDigest: writerInternals.resolvePrWorkflowRevisionDigest,
	writerMergeBase: writerInternals.resolveMergeBase,
};

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'trigger-eval-dr-')));
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

function inlineRows(): PrReviewInlineTriggerRow[] {
	return rows().map(({ trigger_id, result, evidence }) => ({
		trigger_id,
		result,
		evidence,
	}));
}

async function recordCompletedBaseLane(
	root: string,
	laneId: string,
): Promise<void> {
	const correlationId = `base-all-${laneId}-session`;
	const header =
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
	const text = `${header}\n[CLEAN] | ${laneId} | exact reviewed diff | no candidate survived the focused review`;
	await recordPendingDelegation(root, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `base-all-${laneId}-call`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'base-all',
		laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: laneId,
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
		batchId: 'base-all',
		laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: laneId,
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
 * Minimal bound PR_REVIEW gate that reaches the digest-binding step: base
 * coverage settled plus a frozen canonical ledger. Micro-lane provenance
 * records are deliberately absent — they are validated AFTER the digest gate,
 * so their absence keeps these cases focused on the digest resolution itself.
 */
async function establishBoundReviewGate(root: string): Promise<void> {
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
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
		await recordCompletedBaseLane(root, lane.laneId);
	}
	await bindPrReviewTriggerLedger(root, SESSION_ID, inlineRows());
}

async function runWriter(
	root: string,
	runId: string,
): Promise<Record<string, unknown>> {
	return JSON.parse(
		await executeWritePrReviewTriggerEval(
			{
				run_id: runId,
				pr_head_sha: HEAD_SHA,
				base_ref: BASE_REF,
				base_sha: BASE_SHA,
				rows: rows(),
			},
			root,
			{ sessionID: SESSION_ID },
		),
	);
}

afterEach(() => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.resolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync =
		originals.resolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originals.resolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originals.resolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originals.gateDigest;
	writerInternals.resolvePrWorkflowRevisionDigest = originals.writerDigest;
	writerInternals.resolveMergeBase = originals.writerMergeBase;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('write_pr_review_trigger_eval revision digest — regression: a transient digest-null was a per-call dead end (R1 / issue #2242)', () => {
	test('a persistently unresolvable digest FAILS CLOSED — there is no fallback', async () => {
		// Anti-forgery guard, deliberately asserted as a negative: no durable
		// independently-bound revision digest exists for PR_REVIEW (the only
		// durable copies live on the very lane artifacts being validated, and
		// lane-output-store declares `revisionDigest` optional), so a
		// set-comparison fallback would turn today's fail-closed
		// `undefined !== digest` into a passing `undefined === undefined`. If a
		// future change adds a digest fallback here, this test must fail.
		const root = tempRoot();
		await establishBoundReviewGate(root);
		writerInternals.resolvePrWorkflowRevisionDigest = () => null;

		const result = await runWriter(root, 'digest-null-run');

		expect(result.success).toBe(false);
		expect(result.message).toMatch(DIGEST_FAILURE);
		// Nothing was persisted: the run is retryable, not consumed.
		expect(
			existsSync(join(root, '.swarm', 'pr-review', 'digest-null-run')),
		).toBe(false);
	});

	test('the digest resolution is retried exactly once before failing', async () => {
		// Previously a single bounded git read decided the call: one transient
		// timeout under host contention ended the whole trigger evaluation.
		const root = tempRoot();
		await establishBoundReviewGate(root);
		let calls = 0;
		writerInternals.resolvePrWorkflowRevisionDigest = () => {
			calls += 1;
			return null;
		};

		const result = await runWriter(root, 'digest-retry-bounded');

		expect(result.success).toBe(false);
		expect(result.message).toMatch(DIGEST_FAILURE);
		// Exactly one retry — bounded, never a spin loop.
		expect(calls).toBe(2);
	});

	test('a digest that resolves on the RETRY lets the evaluation proceed', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		let calls = 0;
		writerInternals.resolvePrWorkflowRevisionDigest = () => {
			calls += 1;
			return calls === 1 ? null : REVISION_DIGEST;
		};

		const result = await runWriter(root, 'digest-retry-recovers');

		expect(calls).toBe(2);
		// The evaluation moves past the digest gate. It still fails later on the
		// micro-lane provenance this fixture deliberately omits; what must NOT
		// survive is the digest dead end.
		expect(result.message).not.toMatch(DIGEST_FAILURE);
	});

	test('the failure message names the transient causes and the recovery path', async () => {
		const root = tempRoot();
		await establishBoundReviewGate(root);
		writerInternals.resolvePrWorkflowRevisionDigest = () => null;

		const result = await runWriter(root, 'digest-null-message');
		const message = String(result.message);

		expect(message).toContain('timed out');
		expect(message).toContain('spawn');
		expect(message).toContain('retry');
		expect(message).toContain('abort_pr_workflow');
		// The retry itself is disclosed so the operator does not re-run expecting
		// the first attempt to be the only one.
		expect(message).toMatch(/2 attempts/i);
	});
});
