import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { prReviewLaneResultEnvelopeDigest } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	activatePrWorkflow,
	admitPrReviewPartialBaseCoverage,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
	validatePrReviewDiscoveryLaneCompletion,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

const HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';
const RECEIPT_REVISION_DIGEST = 'd'.repeat(64);

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolvePrWorkflowRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolvePrReviewDiffStatsAsync =
	_test_exports.resolvePrReviewDiffStatsAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-structured-receipts-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => RECEIPT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
	_test_exports.resolvePrReviewDiffStatsAsync = async () => ({
		changedLines: 12,
		changedFiles: 2,
		hasSubmoduleChange: false,
	});
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest =
		originalResolvePrWorkflowRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.resolvePrReviewDiffStatsAsync =
		originalResolvePrReviewDiffStatsAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('structured PR-review receipts', () => {
	test('FB-002/FB-010 credits only receipt-backed lanes and leaves unresolved coverage terminal', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await bindPrReviewBase(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			baseRef: 'origin/main',
			baseSha: 'def456',
		});
		const creditedLane = 'correctness-state';
		const unresolvedLane = 'tests-falsifiability';
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			[
				{
					laneId: 'base-structured-lane',
					workflowLane: creditedLane,
					ownedWorkflowLanes: [creditedLane, unresolvedLane],
				},
			],
			{
				batchId: 'base-structured',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		const state = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(state).not.toBeNull();
		const envelope = {
			schemaVersion: 1 as const,
			outcome: 'INCOMPLETE' as const,
			creditedLanes: [creditedLane],
			findings: [
				{
					id: 'R-1',
					workflowLane: creditedLane,
					severity: 'HIGH' as const,
					riskImpact: 'ORDINARY' as const,
					riskTags: [],
					title: 'Receipt-backed finding',
					body: 'Only the credited lane is settled.',
					evidence: 'Structured receipt preserves only this finding.',
					location: {
						kind: 'non_local' as const,
						label: 'receipt',
						detail: 'lane-settlement',
					},
				},
			],
			cleanAttestations: [],
			unresolved: [
				{
					workflowLane: unresolvedLane,
					reason: 'RESOURCE_LIMIT' as const,
					detail: 'https://user:secret@example.com/private',
				},
			],
		};
		await persistPrReviewBatch(
			directory,
			'base-structured',
			'swarm-pr-review:base',
			[
				{
					laneId: 'base-structured-lane',
					workflowLane: creditedLane,
					ownedWorkflowLanes: [creditedLane, unresolvedLane],
				},
			],
			{
				subagentSessionId: 'child-structured',
				prReviewLegacyTranscriptCompatibility: false,
				prReviewResultReceipt: {
					schemaVersion: 1,
					mode: 'swarm-pr-review:base',
					workflowInstanceId: state!.workflowInstanceId!,
					workflowRevision: state!.revision,
					batchId: 'base-structured',
					laneId: 'base-structured-lane',
					workflowLane: creditedLane,
					ownedWorkflowLanes: [creditedLane, unresolvedLane],
					baseSha: state!.prReviewBaseSha!,
					headSha: PR_ARTIFACT_HEAD_SHA,
					dispatchRevisionDigest: RECEIPT_REVISION_DIGEST,
					childSessionId: 'child-structured',
					generation: 1,
					semanticEnvelopeDigest: prReviewLaneResultEnvelopeDigest(envelope),
					envelope,
				},
				textOverride: [
					HEADER,
					`T-1 | ${creditedLane} | HIGH | correctness | src/a.ts:1 | transcript row | evidence | impact | HIGH | ORDINARY | `,
					`T-2 | ${unresolvedLane} | HIGH | correctness | src/b.ts:1 | transcript row | evidence | impact | HIGH | ORDINARY | `,
				].join('\n'),
			},
		);

		await expect(
			_test_exports.derivePrReviewCandidateInventory(
				directory,
				PR_ARTIFACT_SESSION_ID,
			),
		).resolves.toEqual(['R-1']);

		await admitPrReviewPartialBaseCoverage(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'structured-receipt-run',
			PR_REVIEW_BASE_DIMENSION_IDS.filter(
				(dimension) => dimension !== creditedLane,
			),
		);
		const persistedState = await readPrWorkflowGateState(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(
			persistedState?.prReviewCoverageDisclosurePath?.replace(/\\/g, '/'),
		).toBe('pr-review/structured-receipt-run/coverage-disclosure.json');
		const disclosurePath = path.join(
			directory,
			'.swarm',
			persistedState!.prReviewCoverageDisclosurePath!,
		);
		const disclosure = JSON.parse(
			await fs.readFile(disclosurePath, 'utf8'),
		) as {
			unresolvedDimensions: Array<Record<string, unknown>>;
		};
		expect(
			disclosure.unresolvedDimensions.map((entry) => entry.dimension),
		).toEqual(
			PR_REVIEW_BASE_DIMENSION_IDS.filter(
				(dimension) => dimension !== creditedLane,
			),
		);
		expect(disclosure.unresolvedDimensions).toContainEqual({
			dimension: unresolvedLane,
			terminalState: 'FAILED',
			reasonKind: 'lane_failure',
			failureClass: 'resource',
			batchId: 'base-structured',
			laneId: 'base-structured-lane',
			safeDetail:
				'structured receipt reported the lane exhausted its resource budget',
		});
		expect(
			disclosure.unresolvedDimensions.some(
				(entry) => entry.dimension === creditedLane,
			),
		).toBe(false);
	});

	test('FB-007 fails closed when legacy transcript compatibility is omitted', () => {
		const result = validatePrReviewDiscoveryLaneCompletion({
			record: {
				schemaVersion: 4,
				correlationId: 'child-1',
				jobId: null,
				subagentSessionId: 'child-1',
				parentSessionId: 'parent-1',
				callID: 'call-1',
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
				status: 'completed',
				createdAt: 2_000,
				updatedAt: 2_000,
				batchId: 'batch-1',
				laneId: 'lane-1',
				mode: 'swarm-pr-review:base',
				workflowLane: 'correctness-state',
				workspace: {
					directory: '/project',
					gitHead: 'head-1',
					dirtyHash: null,
					prHeadSha: 'head-1',
					scope: 'complete PR diff base-1...head-1',
				},
			},
			result: {
				text: 'ordinary prose without a structured receipt',
				chars: 41,
				truncated: false,
				digest: 'a'.repeat(64),
				outputRef: `L1:${'b'.repeat(64)}:${'c'.repeat(64)}:${'a'.repeat(64)}`,
			},
			artifact: null,
			expected: {
				mode: 'swarm-pr-review:base',
				workflowLane: 'correctness-state',
				prHeadSha: 'head-1',
				gitHead: 'head-1',
				revisionDigest: 'revision-1',
				workflowInstanceId: 'workflow-1',
				workflowRevision: 1,
				baseSha: 'base-1',
				reviewScope: 'complete PR diff base-1...head-1',
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure.actual).toContain(
				'missing structured receipt (legacy transcript adapter disabled)',
			);
		}
	});

	test('FB-015 redacts URL credentials in publication diagnostics without mangling stable IDs', () => {
		const diagnostic = _test_exports.boundPublicationDiagnostic(
			'push failed for attempt attempt-17 against https://user:supersecret@example.com/org/repo.git token=abc123',
		);
		expect(diagnostic).toContain('attempt-17');
		expect(diagnostic).toContain(
			'https://[REDACTED:url_credentials]@example.com/org/repo.git',
		);
		expect(diagnostic).not.toContain('user:supersecret@');
	});
});
