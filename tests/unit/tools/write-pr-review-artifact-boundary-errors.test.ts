import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
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
	directory = canonicalMkdtemp('pr-artifact-boundary-errors-');
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

describe('write_pr_review_artifact boundary and coverage errors (issue #2277)', () => {
	test('boundary-ordering refusal names the missing prerequisite boundary', async () => {
		await establishPrReviewPrerequisites(directory, 'order-run');
		await settleReviewerPhase(
			directory,
			'order-run',
			[
				reviewedRow('C-0', 'DISPROVED', 'LOW'),
				...candidateIds
					.slice(1)
					.map((id) => reviewedRow(id, 'CONFIRMED', 'LOW')),
			],
			candidateIds,
		);
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'order-run', 'post_reviewer', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason'),
				...candidateIds
					.slice(1)
					.map((id) => artifactRecord(id, 'CONFIRMED', 'report')),
			]),
		);
		expect(message).toBe(
			'BLOCKED: PR_REVIEW post_reviewer findings require the prior post_explorer checkpoint',
		);
	});

	test('trigger-eval prerequisite refusal names the producing call', async () => {
		await establishPrReviewPrerequisites(
			directory,
			'no-trigger',
			PR_ARTIFACT_SESSION_ID,
			HEAD_SHA,
			{ skipTriggerEvaluation: true },
		);
		const message = await rejectionMessage(
			writePrReviewFindings(
				directory,
				'no-trigger',
				'post_explorer',
				candidateIds.map((id) =>
					artifactRecord(id, 'PENDING', 'route_to_reviewer'),
				),
			),
		);
		expect(message).toBe(
			'BLOCKED: PR_REVIEW findings persistence requires the trigger evaluation artifact (write_pr_review_trigger_eval must complete first)',
		);
	});

	test('inventory-coverage refusal lists missing, extra, and duplicate ids', async () => {
		await establishPrReviewPrerequisites(directory, 'coverage-run');
		const missingMessage = await rejectionMessage(
			writePrReviewFindings(
				directory,
				'coverage-run',
				'post_explorer',
				candidateIds
					.slice(0, -1)
					.map((id) => artifactRecord(id, 'PENDING', 'route_to_reviewer')),
			),
		);
		expect(missingMessage).toBe(
			'BLOCKED: PR_REVIEW post_explorer findings must exactly cover the discovered candidate inventory; missing: C-5; extra: (none); duplicates: (none)',
		);
		const duplicateMessage = await rejectionMessage(
			writePrReviewFindings(directory, 'coverage-run', 'post_explorer', [
				artifactRecord('C-0', 'PENDING', 'route_to_reviewer'),
				artifactRecord('C-0', 'PENDING', 'route_to_reviewer'),
				...candidateIds
					.slice(1, -1)
					.map((id) => artifactRecord(id, 'PENDING', 'route_to_reviewer')),
			]),
		);
		expect(duplicateMessage).toBe(
			'BLOCKED: PR_REVIEW post_explorer findings must exactly cover the discovered candidate inventory; missing: C-5; extra: (none); duplicates: C-0',
		);
		const nonConsecutiveDuplicateMessage = await rejectionMessage(
			writePrReviewFindings(directory, 'coverage-run', 'post_explorer', [
				artifactRecord('C-0', 'PENDING', 'route_to_reviewer'),
				artifactRecord('C-1', 'PENDING', 'route_to_reviewer'),
				artifactRecord('C-0', 'PENDING', 'route_to_reviewer'),
				...candidateIds
					.slice(2, -1)
					.map((id) => artifactRecord(id, 'PENDING', 'route_to_reviewer')),
			]),
		);
		expect(nonConsecutiveDuplicateMessage).toBe(
			'BLOCKED: PR_REVIEW post_explorer findings must exactly cover the discovered candidate inventory; missing: C-5; extra: (none); duplicates: C-0',
		);
		const extraIdMessage = await rejectionMessage(
			writePrReviewFindings(
				directory,
				'coverage-run',
				'post_explorer',
				candidateIds
					.map((id) => artifactRecord(id, 'PENDING', 'route_to_reviewer'))
					.concat(artifactRecord('C-9', 'PENDING', 'route_to_reviewer')),
			),
		);
		expect(extraIdMessage).toBe(
			'BLOCKED: PR_REVIEW post_explorer findings must exactly cover the discovered candidate inventory; missing: (none); extra: C-9; duplicates: (none)',
		);
	});

	test('empty records stay a tool-level schema rejection, not a validator rejection', async () => {
		await establishPrReviewPrerequisites(directory, 'empty-run');
		const result = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'empty-run',
				pr_head_sha: HEAD_SHA,
				boundary: 'post_explorer',
				records: [],
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(result).toContain('"success": false');
		expect(result).toContain('records');
		expect(result).not.toContain('artifact invalid');
	});

	test('clean multi-record payloads still pass at every boundary (no acceptance loosening)', async () => {
		await establishPrReviewPrerequisites(directory, 'clean-run');
		await settleReviewerPhase(
			directory,
			'clean-run',
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
			'clean-run',
			['[CRITIC] | C-1 | DOWNGRADED | LOW | rationale | suggested change'],
			['C-1'],
		);
		await expect(
			writePrReviewFindings(
				directory,
				'clean-run',
				'post_explorer',
				candidateIds.map((id) =>
					artifactRecord(id, 'PENDING', 'route_to_reviewer', 'HIGH'),
				),
			),
		).resolves.toContain('"success": true');
		await expect(
			writePrReviewFindings(directory, 'clean-run', 'post_reviewer', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'LOW'),
				artifactRecord('C-1', 'CONFIRMED', 'route_to_critic', 'MEDIUM'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
			]),
		).resolves.toContain('"success": true');
		await expect(
			writePrReviewFindings(directory, 'clean-run', 'post_critic', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'LOW'),
				artifactRecord('C-1', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
			]),
		).resolves.toContain('"success": true');
	});
});
