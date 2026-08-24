/**
 * Issue #2279 / #2320 — the mechanically derived `CLEAN-REVIEW` sentinel.
 *
 * Split out of write-pr-review-artifact-severity.test.ts to stay under the
 * FR-006 500-line cap. These two cases are one concern: the sentinel is the only
 * findings id with no `[CANDIDATE]` row, and `candidate_id` is free text, so a
 * lane can also name a REAL finding `CLEAN-REVIEW`. The gate must therefore key
 * on whether an authority exists, never on the id.
 */
/**
 * Issue #2279 — acceptance criteria for the unified severity dialect.
 *
 * Maps AC1-AC4 of the issue directly onto executable assertions:
 *   AC1 a record with `severity: "NONE"` persists AND reloads
 *   AC2 omitting `severity` is rejected, naming the required value
 *   AC3 a post_critic downgrade (reviewer MEDIUM / critic LOW) persists as LOW
 *       and validates WITHOUT field omission
 *   AC4 non-critic-routed post_critic records still validate against the reviewer
 *
 * AC3's rejection half and the disagreement cells live in
 * write-pr-review-artifact-validator-errors.test.ts; this file owns the
 * persistence-and-reload half plus the NONE round trip.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	type ArtifactRecord,
	artifactRecord,
	artifactRecordWithoutSeverity,
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
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
const originals = {
	head: _test_exports.resolveCurrentGitHead,
	headAsync: _test_exports.resolveCurrentGitHeadAsync,
	digest: _test_exports.resolvePrWorkflowRevisionDigest,
	clean: _test_exports.resolveIsWorkingTreeClean,
	cleanAsync: _test_exports.resolveIsWorkingTreeCleanAsync,
};

beforeEach(() => {
	directory = canonicalMkdtemp('pr-artifact-severity-');
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
	_test_exports.resolveCurrentGitHead = originals.head;
	_test_exports.resolveCurrentGitHeadAsync = originals.headAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originals.digest;
	_test_exports.resolveIsWorkingTreeClean = originals.clean;
	_test_exports.resolveIsWorkingTreeCleanAsync = originals.cleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

/** Read every persisted findings record back off disk. */
async function reloadFindings(
	runId: string,
): Promise<Array<Record<string, unknown>>> {
	const artifactPath = path.join(
		directory,
		'.swarm',
		'pr-review',
		runId,
		'findings.jsonl',
	);
	const text = await fs.readFile(artifactPath, 'utf8');
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The post_explorer checkpoint every later boundary requires. */
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

describe('#2279 CLEAN-REVIEW sentinel', () => {
	test('the CLEAN-REVIEW sentinel carries NONE at post_explorer, matching post_reviewer', async () => {
		// A zero-finding review is a NORMAL outcome, and it had no test at all.
		// The sentinel exists precisely because there is no `[CANDIDATE]` row to
		// compare against, and its mandated reviewer row carries `NONE` — so
		// requiring a non-NONE severity here would force a clean review to invent
		// a value at post_explorer and flip it one boundary later (issue #2320).
		const runId = 'clean-review-run';
		await establishPrReviewPrerequisites(
			directory,
			runId,
			undefined,
			undefined,
			{
				zeroCandidates: true,
			},
		);

		await expect(
			writePrReviewFindings(directory, runId, 'post_explorer', [
				artifactRecord('CLEAN-REVIEW', 'PENDING', 'route_to_reviewer', 'NONE'),
			]),
		).resolves.toContain('"success": true');

		// A fabricated non-NONE severity is rejected against the same authority.
		const fabricated = await rejectionMessage(
			writePrReviewFindings(directory, runId, 'post_explorer', [
				artifactRecord('CLEAN-REVIEW', 'PENDING', 'route_to_reviewer', 'HIGH'),
			]),
		);
		expect(fabricated).toContain(
			'CLEAN-REVIEW: severity expected "NONE", got "HIGH"',
		);

		// Omission is still a violation naming the value owed.
		const omitted = await rejectionMessage(
			writePrReviewFindings(directory, runId, 'post_explorer', [
				artifactRecordWithoutSeverity(
					'CLEAN-REVIEW',
					'PENDING',
					'route_to_reviewer',
				),
			]),
		);
		expect(omitted).toContain(
			'CLEAN-REVIEW: severity expected "NONE", got (omitted)',
		);

		// And the SAME value carries through the next boundary — the round trip
		// that the pre-fix contradiction would have made impossible.
		await settleReviewerPhase(
			directory,
			runId,
			[reviewedRow('CLEAN-REVIEW', 'DISPROVED', 'NONE')],
			['CLEAN-REVIEW'],
		);
		await expect(
			writePrReviewFindings(directory, runId, 'post_reviewer', [
				artifactRecord(
					'CLEAN-REVIEW',
					'DISPROVED',
					'suppress_with_reason',
					'NONE',
				),
			]),
		).resolves.toContain('"success": true');
	});

	test('a real candidate named CLEAN-REVIEW is still compared against its own row', async () => {
		// SENTINEL SPOOFING. `candidate_id` is unconstrained free text, so a lane
		// can name a real finding after the synthetic zero-candidate sentinel. When
		// the sentinel branch was tested BEFORE the severity map, such a record was
		// compared against `NONE` instead of its row — which accepted a fabricated
		// `NONE` for a CRITICAL finding and rejected the truthful value. A derived
		// authority must always win over the sentinel branch (issue #2320).
		const runId = 'sentinel-spoof-run';
		await establishPrReviewPrerequisites(
			directory,
			runId,
			undefined,
			undefined,
			{ firstCandidateId: 'CLEAN-REVIEW', candidateSeverity: 'CRITICAL' },
		);

		const spoofed = await rejectionMessage(
			writePrReviewFindings(
				directory,
				runId,
				'post_explorer',
				candidateIds.map((id, index) =>
					artifactRecord(
						index === 0 ? 'CLEAN-REVIEW' : id,
						'PENDING',
						'route_to_reviewer',
						index === 0 ? 'NONE' : 'CRITICAL',
					),
				),
			),
		);
		// The fabricated NONE must be rejected against the row's real severity.
		expect(spoofed).toContain(
			'CLEAN-REVIEW: severity expected "CRITICAL", got "NONE"',
		);

		// ...and the truthful value must be ACCEPTED, which the id-first ordering
		// made impossible.
		await expect(
			writePrReviewFindings(
				directory,
				runId,
				'post_explorer',
				candidateIds.map((id, index) =>
					artifactRecord(
						index === 0 ? 'CLEAN-REVIEW' : id,
						'PENDING',
						'route_to_reviewer',
						'CRITICAL',
					),
				),
			),
		).resolves.toContain('"success": true');
	});
});
