/**
 * Issue #2585 (Roadmap H8) — C6 / AC4 / R06–R08: verdict/coverage policy
 * values runtime-enforced against repo constants, honored end to end.
 *
 * 1. R06 vocabulary: `PR_REVIEW_REPORT_VERDICTS` and every
 *    `allowedPrReviewReportVerdicts` row pinned exactly (completion.ts); the
 *    REAL reducer's acceptance matrix over every (kind, verdict) pair equals
 *    the policy function's matrix.
 * 2. R07 missing base: a five-of-six settlement keeps the missing dimension an
 *    explicit NOT_LAUNCHED record; PARTIAL never admits APPROVE — reducer AND
 *    gate completion refusal.
 * 3. R07 uncertain read: a torn delegation store fails settlement closed
 *    (never NOT_LAUNCHED); PR_REVIEW completion refuses typed while the gate
 *    stays active (#2511 precedent: completion-uncertainty-2511.test.ts).
 * 4. R08 healthy zero coverage: completes ONLY as forced INCOMPLETE through
 *    the gate's NO_COVERAGE path, with the durable v2 disclosure.
 *
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	allowedPrReviewReportVerdicts,
	derivePrReviewDimensionSettlement,
	PR_REVIEW_REPORT_VERDICTS,
} from '../../../src/pr-review/completion.js';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewCoverageSettlementInput,
	PrReviewReportVerdict,
	PrReviewWorkflowState,
} from '../../../src/pr-review/types.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

/**
 * `persistPrReviewBatch` stamps its records with `PR_ARTIFACT_SESSION_ID` as
 * the parent session; the settlement reads batches by that exact parent, so
 * the gate session under test must be the same identity.
 */
const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const OTHER_SESSION_ID = 'ses_r06_raw_store';
const BOUND_HEAD = PR_ARTIFACT_HEAD_SHA;
const FIXED_NOW = 1_800_000_000_000;
const ORIGINALS = {
	head: _test_exports.resolveCurrentGitHead,
	headAsync: _test_exports.resolveCurrentGitHeadAsync,
	revision: _test_exports.resolvePrWorkflowRevisionDigest,
	revisionDetailed: _test_exports.resolvePrWorkflowRevisionDigestDetailed,
	clean: _test_exports.resolveIsWorkingTreeClean,
	cleanAsync: _test_exports.resolveIsWorkingTreeCleanAsync,
	sessionOps: _test_exports.getSessionOps,
};

let directory = '';
let restoreClock: (() => void) | null = null;

/** Minimal reducer state slice the coverage finalization transition reads. */
function reducerState(revision = 1): PrReviewWorkflowState {
	return {
		sessionID: SESSION_ID,
		revision,
		prHeadSha: BOUND_HEAD,
	};
}

/** Settlement input with no live lanes; PARTIAL/NO_COVERAGE carry unresolved rows. */
function settlementInput(
	kind: PrReviewCoverageSettlementInput['kind'],
	covered: readonly string[],
): PrReviewCoverageSettlementInput {
	return {
		kind,
		coveredDimensions:
			covered as PrReviewCoverageSettlementInput['coveredDimensions'],
		unresolvedDimensions:
			kind === 'COMPLETE'
				? []
				: [
						{
							dimension:
								PR_REVIEW_BASE_DIMENSION_IDS.find(
									(dimension) => !covered.includes(dimension),
								) ?? PR_REVIEW_BASE_DIMENSION_IDS[0]!,
							terminalState: 'NOT_LAUNCHED',
							reasonKind: 'not_launched',
						},
					],
		liveDimensions: [],
	};
}

/** Raw pending base-lane store + torn compaction manifest (issue #2511 fixture shape). */
function writeTornRawStore(dir: string, workflowLane: string): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		`${JSON.stringify({
			schemaVersion: 1,
			correlationId: 'ses_r06_uncertain',
			jobId: null,
			subagentSessionId: 'ses_r06_uncertain',
			parentSessionId: OTHER_SESSION_ID,
			callID: 'call_r06',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			status: 'pending',
			createdAt: FIXED_NOW,
			updatedAt: FIXED_NOW,
			batchId: 'r06-batch',
			laneId: 'r06-lane',
			mode: 'swarm-pr-review:base',
			workflowLane,
			promptHash: 'r'.repeat(24),
		})}\n`,
		'utf-8',
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
		'{"schemaVersion": 1, "sequence": ',
		'utf-8',
	);
}

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
	directory = canonicalMkdtemp('pr-review-r06-08-policy-');
	fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => BOUND_HEAD;
	_test_exports.resolveCurrentGitHeadAsync = async () => BOUND_HEAD;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolvePrWorkflowRevisionDigestDetailed = () => ({
		ok: true,
		digest: PR_ARTIFACT_REVISION_DIGEST,
	});
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
	// Pin "no host" so lane settlement probes cannot wait on a real host client
	// leaked by another file (abort-tool precedent).
	_test_exports.getSessionOps = () => null;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = ORIGINALS.head;
	_test_exports.resolveCurrentGitHeadAsync = ORIGINALS.headAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = ORIGINALS.revision;
	_test_exports.resolvePrWorkflowRevisionDigestDetailed =
		ORIGINALS.revisionDetailed;
	_test_exports.resolveIsWorkingTreeClean = ORIGINALS.clean;
	_test_exports.resolveIsWorkingTreeCleanAsync = ORIGINALS.cleanAsync;
	_test_exports.getSessionOps = ORIGINALS.sessionOps;
	await fs.promises.rm(directory, { recursive: true, force: true });
	restoreClock?.();
});

describe('R06 verdict vocabulary — runtime-enforced values against repo constants', () => {
	test('PR_REVIEW_REPORT_VERDICTS is exactly the frozen three-value vocabulary', () => {
		expect([...PR_REVIEW_REPORT_VERDICTS]).toEqual([
			'APPROVE',
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
	});

	test('allowedPrReviewReportVerdicts rows: COMPLETE→all, PARTIAL→no APPROVE, NO_COVERAGE→INCOMPLETE only', () => {
		expect([...allowedPrReviewReportVerdicts('COMPLETE')]).toEqual([
			'APPROVE',
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
		expect([...allowedPrReviewReportVerdicts('PARTIAL')]).toEqual([
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
		expect([...allowedPrReviewReportVerdicts('NO_COVERAGE')]).toEqual([
			'INCOMPLETE',
		]);
	});

	test.each(
		PR_REVIEW_REPORT_VERDICTS,
	)('reducer matrix == policy matrix: every (kind, verdict) pair agrees (%s leg)', (verdict: PrReviewReportVerdict) => {
		for (const kind of ['COMPLETE', 'PARTIAL', 'NO_COVERAGE'] as const) {
			const covered = kind === 'COMPLETE' ? PR_REVIEW_BASE_DIMENSION_IDS : [];
			const outcome = reducePrReviewEvent(reducerState(), {
				type: 'coverage_finalization_requested',
				settlement: settlementInput(kind, covered),
				requestedVerdict: verdict,
			});
			const policyAllows =
				allowedPrReviewReportVerdicts(kind).includes(verdict);
			expect(outcome.status).toBe(policyAllows ? 'applied' : 'rejected');
		}
	});

	test('PARTIAL + APPROVE is rejected as partial_coverage_cannot_approve', () => {
		const outcome = reducePrReviewEvent(reducerState(), {
			type: 'coverage_finalization_requested',
			settlement: settlementInput('PARTIAL', []),
			requestedVerdict: 'APPROVE',
		});
		expect(outcome.status).toBe('rejected');
		if (outcome.status === 'rejected') {
			expect(outcome.rejection.code).toBe('partial_coverage_cannot_approve');
			expect(outcome.rejection.detail).toContain('APPROVE');
		}
	});

	test.each([
		'APPROVE',
		'REQUEST_CHANGES',
	] as const)('NO_COVERAGE + %s is rejected as no_coverage_requires_incomplete', (verdict) => {
		const outcome = reducePrReviewEvent(reducerState(), {
			type: 'coverage_finalization_requested',
			settlement: settlementInput('NO_COVERAGE', []),
			requestedVerdict: verdict,
		});
		expect(outcome.status).toBe('rejected');
		if (outcome.status === 'rejected') {
			expect(outcome.rejection.code).toBe('no_coverage_requires_incomplete');
			expect(outcome.rejection.detail).toContain(verdict);
		}
	});

	test('a live dimension blocks finalization ahead of any verdict question', () => {
		const settlement = settlementInput('PARTIAL', []);
		const outcome = reducePrReviewEvent(reducerState(), {
			type: 'coverage_finalization_requested',
			settlement: {
				...settlement,
				liveDimensions: [
					settlement.unresolvedDimensions[0]!.dimension as never,
				],
			},
			requestedVerdict: 'INCOMPLETE',
		});
		expect(outcome.status).toBe('rejected');
		if (outcome.status === 'rejected') {
			expect(outcome.rejection.code).toBe('live_lane_blocks_coverage');
			expect(outcome.rejection.detail).toContain('live dimension');
		}
	});

	test('an admitted finalization mutates no state and emits no effects', () => {
		const state = reducerState(7);
		const outcome = reducePrReviewEvent(state, {
			type: 'coverage_finalization_requested',
			settlement: settlementInput('COMPLETE', PR_REVIEW_BASE_DIMENSION_IDS),
			requestedVerdict: 'APPROVE',
		});
		expect(outcome.status).toBe('applied');
		if (outcome.status === 'applied') {
			expect(outcome.state).toBe(state);
			expect(outcome.effects).toEqual([]);
		}
	});
});

describe('R07 missing base dispatch — NOT_LAUNCHED unresolved blocks COMPLETE/APPROVE', () => {
	test('five-of-six: the never-dispatched dimension stays an explicit NOT_LAUNCHED record; APPROVE refused', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		const coveredDimensions = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5);
		const missingDimension = PR_REVIEW_BASE_DIMENSION_IDS[5]!;
		const lanes = coveredDimensions.map((workflowLane) => ({
			laneId: `ok-${workflowLane}`,
			workflowLane,
		}));
		await enforcePrReviewBaseDimensions(directory, SESSION_ID, lanes, {
			batchId: 'r06-base-five',
			prHeadSha: BOUND_HEAD,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		await persistPrReviewBatch(
			directory,
			'r06-base-five',
			'swarm-pr-review:base',
			lanes,
		);

		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(state?.prHeadSha).toBe(BOUND_HEAD);
		const settlement = derivePrReviewDimensionSettlement(
			directory,
			state!,
			PR_ARTIFACT_REVISION_DIGEST,
		);
		expect(settlement.kind).toBe('PARTIAL');
		expect(settlement.coveredDimensions.sort()).toEqual(
			[...coveredDimensions].sort(),
		);
		expect(settlement.liveDimensions).toEqual([]);
		expect(settlement.unresolvedDimensions).toEqual([
			{
				dimension: missingDimension,
				terminalState: 'NOT_LAUNCHED',
				reasonKind: 'not_launched',
				safeDetail: 'no lane for this dimension was ever dispatched',
			},
		]);

		const outcome = reducePrReviewEvent(
			{ ...(state as PrReviewWorkflowState) },
			{
				type: 'coverage_finalization_requested',
				settlement: {
					kind: settlement.kind,
					coveredDimensions: settlement.coveredDimensions,
					unresolvedDimensions: settlement.unresolvedDimensions,
					liveDimensions: settlement.liveDimensions,
				},
				requestedVerdict: 'APPROVE',
			},
		);
		expect(outcome.status).toBe('rejected');
		// ...and so does the gate's completion admission, with the next step.
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', BOUND_HEAD, {
				reportVerdict: 'APPROVE',
			}),
		).rejects.toThrow(
			/PR_REVIEW PARTIAL completion allows report_verdict REQUEST_CHANGES \| INCOMPLETE; got "APPROVE"/,
		);
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).not.toBeNull();
	});
});

describe('R07 uncertain batch read — unknown, never NOT_LAUNCHED (issue #2511)', () => {
	test('a torn store fails settlement closed instead of deriving coverage labels', async () => {
		await activatePrWorkflow(directory, OTHER_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});
		// Declare one dispatched base lane (gate state only — no store records),
		await enforcePrReviewBaseDimensions(
			directory,
			OTHER_SESSION_ID,
			[
				{
					laneId: 'r06-lane',
					workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0]!,
				},
			],
			{
				batchId: 'r06-batch',
				prHeadSha: BOUND_HEAD,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		writeTornRawStore(directory, PR_REVIEW_BASE_DIMENSION_IDS[0]!);
		const state = await readPrWorkflowGateState(directory, OTHER_SESSION_ID);

		expect(() =>
			derivePrReviewDimensionSettlement(
				directory,
				state!,
				PR_ARTIFACT_REVISION_DIGEST,
			),
		).toThrow(/delegation store is unreadable/i);

		// The gate's completion refuses with the typed uncertainty and names the
		// repair path; the dispatch evidence is UNKNOWN, not absent.
		await expect(
			completePrWorkflow(directory, OTHER_SESSION_ID, 'PR_REVIEW', BOUND_HEAD, {
				reportVerdict: 'INCOMPLETE',
			}),
		).rejects.toThrow(
			/completion refused while the delegation store is unreadable after 2 attempts.*UNKNOWN, not absent/s,
		);
		expect(
			await readPrWorkflowGateState(directory, OTHER_SESSION_ID),
		).not.toBeNull();
	});
});

describe('R08 healthy zero coverage — completes only as forced INCOMPLETE', () => {
	test('NO_COVERAGE refuses APPROVE and REQUEST_CHANGES, completes as INCOMPLETE with a durable disclosure', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: BOUND_HEAD,
		});

		// A zero-coverage run never approves and never claims a full review.
		for (const verdict of ['APPROVE', 'REQUEST_CHANGES'] as const) {
			const refused = JSON.parse(
				await executeCompletePrWorkflow(
					{
						mode: 'PR_REVIEW',
						pr_head_sha: BOUND_HEAD,
						report_verdict: verdict,
					},
					directory,
					{ sessionID: SESSION_ID },
				),
			) as { success: boolean; message: string };
			expect(refused.success).toBe(false);
			expect(refused.message).toMatch(
				/NO_COVERAGE completion must report verdict INCOMPLETE/,
			);
			expect(refused.message).toContain(verdict);
			expect(
				await readPrWorkflowGateState(directory, SESSION_ID),
			).not.toBeNull();
		}

		const completion = JSON.parse(
			await executeCompletePrWorkflow(
				{
					mode: 'PR_REVIEW',
					pr_head_sha: BOUND_HEAD,
					report_verdict: 'INCOMPLETE',
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		) as {
			success: boolean;
			status: string;
			gate_cleared: boolean;
			terminal_report: {
				kind: string;
				covered_dimensions: string[];
				unresolved_dimensions: Array<{
					dimension: string;
					terminal_state: string;
					reason_kind: string;
				}>;
				live_dimensions: string[];
				allowed_verdicts: string[];
				report_verdict: string;
			};
		};
		expect(completion.success).toBe(true);
		expect(completion.status).toBe('completed');
		expect(completion.gate_cleared).toBe(true);
		expect(completion.terminal_report.kind).toBe('NO_COVERAGE');
		expect(completion.terminal_report.covered_dimensions).toEqual([]);
		expect(completion.terminal_report.live_dimensions).toEqual([]);
		expect(completion.terminal_report.allowed_verdicts).toEqual(['INCOMPLETE']);
		expect(completion.terminal_report.report_verdict).toBe('INCOMPLETE');
		expect(
			completion.terminal_report.unresolved_dimensions
				.map((entry) => entry.dimension)
				.sort(),
		).toEqual([...PR_REVIEW_BASE_DIMENSION_IDS].sort());
		for (const entry of completion.terminal_report.unresolved_dimensions) {
			expect(entry.terminal_state).toBe('NOT_LAUNCHED');
			expect(entry.reason_kind).toBe('not_launched');
		}

		// The gate cleared and the durable v2 disclosure proves the NO_COVERAGE
		// kind from the immutable artifact, not only the audit line.
		expect(await readPrWorkflowGateState(directory, SESSION_ID)).toBeNull();
		const disclosureRoot = path.join(directory, '.swarm', 'pr-review');
		const disclosurePaths = fs
			.readdirSync(disclosureRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((runDirectory) =>
				path.join(
					disclosureRoot,
					runDirectory.name,
					'coverage-disclosure.json',
				),
			)
			.filter((candidate) => fs.existsSync(candidate));
		expect(disclosurePaths).toHaveLength(1);
		const disclosure = JSON.parse(
			fs.readFileSync(disclosurePaths[0]!, 'utf-8'),
		) as { schemaVersion: number; unresolvedDimensions: string[] };
		expect(disclosure.schemaVersion).toBe(2);
		expect(disclosure.unresolvedDimensions).toHaveLength(
			PR_REVIEW_BASE_DIMENSION_IDS.length,
		);
	});
});
