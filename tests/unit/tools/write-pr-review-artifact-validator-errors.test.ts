import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	artifactRecord,
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	rejectionMessage,
	reviewedRow,
	settleCriticPhase,
	settleReviewerPhase,
	writePrReviewFindings,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-artifact-validator-errors-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
		_test_exports.resolveCurrentGitHead(dir);
	_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
		_test_exports.resolveIsWorkingTreeClean(dir);
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

function persistExplorerCheckpoint(runId: string): Promise<string> {
	return writePrReviewFindings(
		directory,
		runId,
		'post_explorer',
		candidateIds.map((id) =>
			artifactRecord(id, 'PENDING', 'route_to_reviewer'),
		),
	);
}

describe('write_pr_review_artifact validator errors (issue #2277)', () => {
	test('GOLDEN: every violation across every record is reported in one rejection with expected-vs-actual', async () => {
		await establishPrReviewPrerequisites(directory, 'golden-run');
		await expect(persistExplorerCheckpoint('golden-run')).resolves.toContain(
			'"success": true',
		);
		await settleReviewerPhase(
			directory,
			'golden-run',
			[
				reviewedRow('C-0', 'DISPROVED', 'LOW'),
				...candidateIds
					.slice(1)
					.map((id) => reviewedRow(id, 'CONFIRMED', 'HIGH')),
			],
			candidateIds,
		);
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'golden-run', 'post_reviewer', [
				artifactRecord('C-0', 'CONFIRMED', 'report'),
				artifactRecord('C-1', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-2', 'CONFIRMED', 'route_to_critic'),
				artifactRecord('C-3', 'CONFIRMED', 'route_to_critic'),
				artifactRecord('C-4', 'CONFIRMED', 'route_to_critic'),
				artifactRecord('C-5', 'CONFIRMED', 'route_to_critic'),
			]),
		);
		expect(message).toBe(
			[
				'BLOCKED: PR_REVIEW post_reviewer artifact invalid — 4 violation(s):',
				'  C-0: status expected "DISPROVED", got "CONFIRMED"',
				'  C-0: next_action expected "suppress_with_reason", got "report"',
				'  C-1: next_action expected "route_to_critic", got "report"',
				'  C-1: severity expected "HIGH", got "LOW"',
			].join('\n'),
		);
	});

	test('post_explorer violations accumulate per field', async () => {
		await establishPrReviewPrerequisites(directory, 'explorer-errs');
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'explorer-errs', 'post_explorer', [
				artifactRecord('C-0', 'CONFIRMED', 'route_to_reviewer'),
				artifactRecord('C-1', 'PENDING', 'report'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'HIGH'),
				artifactRecord('C-3', 'PENDING', 'route_to_reviewer'),
				artifactRecord('C-4', 'PENDING', 'route_to_reviewer'),
				artifactRecord('C-5', 'PENDING', 'route_to_reviewer'),
			]),
		);
		expect(message).toBe(
			[
				'BLOCKED: PR_REVIEW post_explorer artifact invalid — 4 violation(s):',
				'  C-0: status expected "PENDING", got "CONFIRMED"',
				'  C-1: next_action expected "route_to_reviewer", got "report"',
				'  C-2: status expected "PENDING", got "CONFIRMED"',
				'  C-2: next_action expected "route_to_reviewer", got "report"',
			].join('\n'),
		);
	});

	test('DISPOSITION MATRIX: post_reviewer next_action expectations per reviewer classification', async () => {
		await establishPrReviewPrerequisites(directory, 'matrix-run');
		await expect(persistExplorerCheckpoint('matrix-run')).resolves.toContain(
			'"success": true',
		);
		await settleReviewerPhase(
			directory,
			'matrix-run',
			[
				reviewedRow('C-0', 'CONFIRMED', 'CRITICAL'),
				reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
				reviewedRow('C-2', 'CONFIRMED', 'MEDIUM'),
				reviewedRow('C-3', 'CONFIRMED', 'LOW'),
				reviewedRow('C-4', 'PRE_EXISTING', 'MEDIUM'),
				reviewedRow('C-5', 'DISPROVED', 'HIGH'),
			],
			candidateIds,
		);
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'matrix-run', 'post_reviewer', [
				artifactRecord('C-0', 'CONFIRMED', 'report'),
				artifactRecord('C-1', 'CONFIRMED', 'report'),
				artifactRecord('C-2', 'CONFIRMED', 'report'),
				artifactRecord('C-3', 'CONFIRMED', 'report'),
				artifactRecord('C-4', 'PRE_EXISTING', 'report'),
				artifactRecord('C-5', 'DISPROVED', 'report'),
			]),
		);
		expect(message).toBe(
			[
				'BLOCKED: PR_REVIEW post_reviewer artifact invalid — 4 violation(s):',
				'  C-0: next_action expected "route_to_critic", got "report"',
				'  C-1: next_action expected "route_to_critic", got "report"',
				'  C-2: next_action expected "route_to_critic", got "report"',
				'  C-5: next_action expected "suppress_with_reason", got "report"',
			].join('\n'),
		);
	});

	test('DISPOSITION MATRIX: UNVERIFIED reviewer verdicts expect PENDING and route_to_reviewer', async () => {
		await establishPrReviewPrerequisites(directory, 'unverified-run');
		await expect(
			persistExplorerCheckpoint('unverified-run'),
		).resolves.toContain('"success": true');
		await settleReviewerPhase(
			directory,
			'unverified-run',
			[
				reviewedRow('C-0', 'UNVERIFIED', 'HIGH'),
				...candidateIds
					.slice(1)
					.map((id) => reviewedRow(id, 'CONFIRMED', 'LOW')),
			],
			candidateIds,
		);
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'unverified-run', 'post_reviewer', [
				artifactRecord('C-0', 'CONFIRMED', 'report'),
				...candidateIds
					.slice(1)
					.map((id) => artifactRecord(id, 'CONFIRMED', 'report')),
			]),
		);
		expect(message).toBe(
			[
				'BLOCKED: PR_REVIEW post_reviewer artifact invalid — 2 violation(s):',
				'  C-0: status expected "PENDING", got "CONFIRMED"',
				'  C-0: next_action expected "route_to_reviewer", got "report"',
			].join('\n'),
		);
	});

	test('post_critic severity disagreement names omission as the only passing value', async () => {
		await establishPrReviewPrerequisites(directory, 'downgrade-run');
		await settleReviewerPhase(
			directory,
			'downgrade-run',
			[
				reviewedRow('C-0', 'DISPROVED', 'LOW'),
				reviewedRow('C-1', 'CONFIRMED', 'MEDIUM'),
				reviewedRow('C-2', 'CONFIRMED', 'LOW'),
				reviewedRow('C-3', 'CONFIRMED', 'LOW'),
				reviewedRow('C-4', 'CONFIRMED', 'LOW'),
				reviewedRow('C-5', 'CONFIRMED', 'LOW'),
			],
			candidateIds,
		);
		await settleCriticPhase(
			directory,
			'downgrade-run',
			['[CRITIC] | C-1 | DOWNGRADED | LOW | rationale | suggested change'],
			['C-1'],
		);
		await expect(persistExplorerCheckpoint('downgrade-run')).resolves.toContain(
			'"success": true',
		);
		await expect(
			writePrReviewFindings(directory, 'downgrade-run', 'post_reviewer', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason'),
				artifactRecord('C-1', 'CONFIRMED', 'route_to_critic'),
				artifactRecord('C-2', 'CONFIRMED', 'report'),
				artifactRecord('C-3', 'CONFIRMED', 'report'),
				artifactRecord('C-4', 'CONFIRMED', 'report'),
				artifactRecord('C-5', 'CONFIRMED', 'report'),
			]),
		).resolves.toContain('"success": true');

		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'downgrade-run', 'post_critic', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason'),
				artifactRecord('C-1', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-2', 'CONFIRMED', 'report'),
				artifactRecord('C-3', 'CONFIRMED', 'report'),
				artifactRecord('C-4', 'CONFIRMED', 'report'),
				artifactRecord('C-5', 'CONFIRMED', 'report'),
			]),
		);
		expect(message).toBe(
			[
				'BLOCKED: PR_REVIEW post_critic artifact invalid — 1 violation(s):',
				'  C-1: severity expected NONE (omit field; reviewer "MEDIUM" and critic "LOW" disagree), got "LOW"',
			].join('\n'),
		);

		// The omission cell of the severity truth table: omitting the optional
		// field is accepted even when the authorities disagree.
		await expect(
			writePrReviewFindings(directory, 'downgrade-run', 'post_critic', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason'),
				artifactRecord('C-1', 'CONFIRMED', 'report'),
				artifactRecord('C-2', 'CONFIRMED', 'report'),
				artifactRecord('C-3', 'CONFIRMED', 'report'),
				artifactRecord('C-4', 'CONFIRMED', 'report'),
				artifactRecord('C-5', 'CONFIRMED', 'report'),
			]),
		).resolves.toContain('"success": true');
	});

	test('post_critic disposition matrix: critic DISPROVED preservation and non-critic override refusal', async () => {
		await establishPrReviewPrerequisites(directory, 'critic-matrix');
		await settleReviewerPhase(
			directory,
			'critic-matrix',
			[
				reviewedRow('C-0', 'DISPROVED', 'LOW'),
				reviewedRow('C-1', 'CONFIRMED', 'HIGH'),
				reviewedRow('C-2', 'CONFIRMED', 'HIGH'),
				...candidateIds
					.slice(3)
					.map((id) => reviewedRow(id, 'CONFIRMED', 'LOW')),
			],
			candidateIds,
		);
		await settleCriticPhase(
			directory,
			'critic-matrix',
			[
				'[CRITIC] | C-1 | DISPROVED | NONE | rationale | no change',
				'[CRITIC] | C-2 | UPHELD | HIGH | rationale | required change',
			],
			['C-1', 'C-2'],
		);
		await expect(persistExplorerCheckpoint('critic-matrix')).resolves.toContain(
			'"success": true',
		);
		await expect(
			writePrReviewFindings(directory, 'critic-matrix', 'post_reviewer', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason'),
				artifactRecord('C-1', 'CONFIRMED', 'route_to_critic'),
				artifactRecord('C-2', 'CONFIRMED', 'route_to_critic'),
				artifactRecord('C-3', 'CONFIRMED', 'report'),
				artifactRecord('C-4', 'CONFIRMED', 'report'),
				artifactRecord('C-5', 'CONFIRMED', 'report'),
			]),
		).resolves.toContain('"success": true');

		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'critic-matrix', 'post_critic', [
				artifactRecord('C-0', 'CONFIRMED', 'report'),
				artifactRecord('C-1', 'CONFIRMED', 'report'),
				artifactRecord('C-2', 'DISPROVED', 'suppress_with_reason'),
				artifactRecord('C-3', 'CONFIRMED', 'report'),
				artifactRecord('C-4', 'CONFIRMED', 'report'),
				artifactRecord('C-5', 'CONFIRMED', 'report'),
			]),
		);
		expect(message).toBe(
			[
				'BLOCKED: PR_REVIEW post_critic artifact invalid — 6 violation(s):',
				'  C-0: status expected "DISPROVED", got "CONFIRMED"',
				'  C-0: next_action expected "suppress_with_reason", got "report"',
				'  C-1: status expected "DISPROVED", got "CONFIRMED"',
				'  C-1: next_action expected "suppress_with_reason", got "report"',
				'  C-2: status expected "CONFIRMED", got "DISPROVED"',
				'  C-2: next_action expected "report" or "handoff_to_feedback", got "suppress_with_reason"',
			].join('\n'),
		);
	});
});
