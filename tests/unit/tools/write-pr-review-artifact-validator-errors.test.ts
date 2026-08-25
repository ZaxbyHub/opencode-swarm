import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	artifactRecord,
	artifactRecordWithoutSeverity,
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
			artifactRecord(id, 'PENDING', 'route_to_reviewer', 'HIGH'),
		),
	);
}

describe('write_pr_review_artifact validator errors (issue #2277)', () => {
	test('schema rejections describe each offending field with legal contract and actual value', async () => {
		await establishPrReviewPrerequisites(directory, 'schema-errors');
		const raw = await writePrReviewFindings(
			directory,
			'schema-errors',
			'post_explorer',
			[
				{
					finding_id: 'C-0',
					status: 'PENDING',
					file_line: 'src/index.ts:1',
					evidence: 'ok',
					next_action: 'route_to_reviewer',
					severity: 'HIGH',
					extra_field: 'surplus',
				},
			] as unknown as Parameters<typeof writePrReviewFindings>[3],
		);
		const parsed = JSON.parse(raw) as { message?: string };
		expect(parsed.message).toContain(
			'field records.0.extra_field: expected no unknown key, got "surplus"',
		);
	});

	test('schema rejections render omitted enum fields as omitted instead of generic Zod text', async () => {
		await establishPrReviewPrerequisites(directory, 'missing-status');
		const raw = await writePrReviewFindings(
			directory,
			'missing-status',
			'post_explorer',
			[
				{
					finding_id: 'C-0',
					file_line: 'src/index.ts:1',
					evidence: 'ok',
					next_action: 'route_to_reviewer',
					severity: 'HIGH',
				},
			] as unknown as Parameters<typeof writePrReviewFindings>[3],
		);
		const parsed = JSON.parse(raw) as { message?: string };
		expect(parsed.message).toContain(
			'field records.0.status: expected "PENDING" | "CONFIRMED" | "DISPROVED" | "PRE_EXISTING", got (omitted)',
		);
	});

	test('GOLDEN: every violation across every record is reported in one rejection with expected-vs-actual', async () => {
		await establishPrReviewPrerequisites(directory, 'golden-run');
		await expect(persistExplorerCheckpoint('golden-run')).resolves.toContain(
			'"success": true',
		);
		await settleReviewerPhase(
			directory,
			'golden-run',
			[
				reviewedRow('C-0', 'DISPROVED', 'NONE'),
				...candidateIds
					.slice(1)
					.map((id) => reviewedRow(id, 'CONFIRMED', 'HIGH')),
			],
			candidateIds,
		);
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'golden-run', 'post_reviewer', [
				artifactRecord('C-0', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-1', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-2', 'CONFIRMED', 'route_to_critic', 'HIGH'),
				artifactRecord('C-3', 'CONFIRMED', 'route_to_critic', 'HIGH'),
				artifactRecord('C-4', 'CONFIRMED', 'route_to_critic', 'HIGH'),
				artifactRecord('C-5', 'CONFIRMED', 'route_to_critic', 'HIGH'),
			]),
		);
		expect(message.startsWith('field records: expected')).toBe(true);
		expect(message).toContain(', got "BLOCKED:');
		expect(message).toContain(
			[
				'BLOCKED: PR_REVIEW post_reviewer artifact invalid — 5 violation(s):',
				'  C-0: status expected "DISPROVED", got "CONFIRMED"',
				'  C-0: next_action expected "suppress_with_reason", got "report"',
				'  C-0: severity expected "NONE", got "LOW"',
				'  C-1: next_action expected "route_to_critic", got "report"',
				'  C-1: severity expected "HIGH", got "LOW"',
			].join('\n'),
		);
	});

	test('post_explorer violations accumulate per field', async () => {
		await establishPrReviewPrerequisites(directory, 'explorer-errs');
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'explorer-errs', 'post_explorer', [
				artifactRecord('C-0', 'CONFIRMED', 'route_to_reviewer', 'HIGH'),
				artifactRecord('C-1', 'PENDING', 'report', 'HIGH'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'HIGH'),
				artifactRecord('C-3', 'PENDING', 'route_to_reviewer', 'HIGH'),
				artifactRecord('C-4', 'PENDING', 'route_to_reviewer', 'HIGH'),
				artifactRecord('C-5', 'PENDING', 'route_to_reviewer', 'HIGH'),
			]),
		);
		expect(message).toContain(
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
				reviewedRow('C-5', 'DISPROVED', 'NONE'),
			],
			candidateIds,
		);
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'matrix-run', 'post_reviewer', [
				artifactRecord('C-0', 'CONFIRMED', 'report', 'CRITICAL'),
				artifactRecord('C-1', 'CONFIRMED', 'report', 'HIGH'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'MEDIUM'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'PRE_EXISTING', 'report', 'MEDIUM'),
				artifactRecord('C-5', 'DISPROVED', 'report', 'HIGH'),
			]),
		);
		expect(message).toContain(
			[
				'BLOCKED: PR_REVIEW post_reviewer artifact invalid — 5 violation(s):',
				'  C-0: next_action expected "route_to_critic", got "report"',
				'  C-1: next_action expected "route_to_critic", got "report"',
				'  C-2: next_action expected "route_to_critic", got "report"',
				'  C-5: next_action expected "suppress_with_reason", got "report"',
				'  C-5: severity expected "NONE", got "HIGH"',
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
				artifactRecord('C-0', 'CONFIRMED', 'report', 'HIGH'),
				...candidateIds
					.slice(1)
					.map((id) => artifactRecord(id, 'CONFIRMED', 'report', 'LOW')),
			]),
		);
		expect(message).toContain(
			[
				'BLOCKED: PR_REVIEW post_reviewer artifact invalid — 2 violation(s):',
				'  C-0: status expected "PENDING", got "CONFIRMED"',
				'  C-0: next_action expected "route_to_reviewer", got "report"',
			].join('\n'),
		);
	});

	test('post_critic downgrade persists the critic severity verbatim', async () => {
		await establishPrReviewPrerequisites(directory, 'downgrade-run');
		await settleReviewerPhase(
			directory,
			'downgrade-run',
			[
				reviewedRow('C-0', 'DISPROVED', 'NONE'),
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
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				artifactRecord('C-1', 'CONFIRMED', 'route_to_critic', 'MEDIUM'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
			]),
		).resolves.toContain('"success": true');

		// The critic's downgraded severity (LOW) is authoritative at post_critic,
		// even though the reviewer's severity (MEDIUM) differs.
		await expect(
			writePrReviewFindings(directory, 'downgrade-run', 'post_critic', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				artifactRecord('C-1', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
			]),
		).resolves.toContain('"success": true');
	});

	test('post_critic severity disagreement rejects the reviewer value and omission', async () => {
		await establishPrReviewPrerequisites(directory, 'downgrade-reject-run');
		await settleReviewerPhase(
			directory,
			'downgrade-reject-run',
			[
				reviewedRow('C-0', 'DISPROVED', 'NONE'),
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
			'downgrade-reject-run',
			['[CRITIC] | C-1 | DOWNGRADED | LOW | rationale | suggested change'],
			['C-1'],
		);
		await expect(
			persistExplorerCheckpoint('downgrade-reject-run'),
		).resolves.toContain('"success": true');
		await expect(
			writePrReviewFindings(
				directory,
				'downgrade-reject-run',
				'post_reviewer',
				[
					artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
					artifactRecord('C-1', 'CONFIRMED', 'route_to_critic', 'MEDIUM'),
					artifactRecord('C-2', 'CONFIRMED', 'report', 'LOW'),
					artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
					artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
					artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
				],
			),
		).resolves.toContain('"success": true');

		// Reporting the reviewer's (pre-downgrade) severity at post_critic is
		// rejected: the critic's severity is authoritative here.
		const reviewerSeverityMessage = await rejectionMessage(
			writePrReviewFindings(directory, 'downgrade-reject-run', 'post_critic', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				artifactRecord('C-1', 'CONFIRMED', 'report', 'MEDIUM'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
			]),
		);
		expect(reviewerSeverityMessage).toContain(
			[
				'BLOCKED: PR_REVIEW post_critic artifact invalid — 1 violation(s):',
				'  C-1: severity expected "LOW", got "MEDIUM"',
			].join('\n'),
		);

		// Omitting severity is rejected too: presence is mandatory now.
		const omittedMessage = await rejectionMessage(
			writePrReviewFindings(directory, 'downgrade-reject-run', 'post_critic', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				artifactRecordWithoutSeverity('C-1', 'CONFIRMED', 'report'),
				artifactRecord('C-2', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
			]),
		);
		expect(omittedMessage).toContain(
			[
				'BLOCKED: PR_REVIEW post_critic artifact invalid — 1 violation(s):',
				'  C-1: severity expected "LOW", got (omitted)',
			].join('\n'),
		);
	});

	test('post_critic disposition matrix: critic DISPROVED preservation and non-critic override refusal', async () => {
		await establishPrReviewPrerequisites(directory, 'critic-matrix');
		await settleReviewerPhase(
			directory,
			'critic-matrix',
			[
				reviewedRow('C-0', 'DISPROVED', 'NONE'),
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
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				artifactRecord('C-1', 'CONFIRMED', 'route_to_critic', 'HIGH'),
				artifactRecord('C-2', 'CONFIRMED', 'route_to_critic', 'HIGH'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
			]),
		).resolves.toContain('"success": true');

		// C-2's reviewer and critic severities AGREE (both HIGH), so its present
		// but differing severity pins the agreement cell of the truth table.
		// C-1 is critic-routed and DISPROVED with severity NONE, so its
		// authoritative severity here is NONE.
		const message = await rejectionMessage(
			writePrReviewFindings(directory, 'critic-matrix', 'post_critic', [
				artifactRecord('C-0', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-1', 'CONFIRMED', 'report', 'NONE'),
				artifactRecord('C-2', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				artifactRecord('C-3', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-4', 'CONFIRMED', 'report', 'LOW'),
				artifactRecord('C-5', 'CONFIRMED', 'report', 'LOW'),
			]),
		);
		expect(message).toContain(
			[
				'BLOCKED: PR_REVIEW post_critic artifact invalid — 8 violation(s):',
				'  C-0: status expected "DISPROVED", got "CONFIRMED"',
				'  C-0: next_action expected "suppress_with_reason", got "report"',
				'  C-0: severity expected "NONE", got "LOW"',
				'  C-1: status expected "DISPROVED", got "CONFIRMED"',
				'  C-1: next_action expected "suppress_with_reason", got "report"',
				'  C-2: status expected "CONFIRMED", got "DISPROVED"',
				'  C-2: next_action expected "report" or "handoff_to_feedback", got "suppress_with_reason"',
				'  C-2: severity expected "HIGH", got "NONE"',
			].join('\n'),
		);
	});
});
