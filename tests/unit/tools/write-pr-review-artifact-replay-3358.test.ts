/**
 * FB-008 committed-replay writer leg, split out of
 * write-pr-review-artifact-validator-errors.test.ts for FR-006 (500-line cap).
 * Same fixture lifecycle (gate seams + canonicalMkdtemp + artifact helpers).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	markPrReviewArtifactBoundary,
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
	settleReviewerPhase,
	writePrReviewFindings,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('pr-artifact-fb008-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
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

describe('write_pr_review_artifact committed-replay tolerance (FB-008)', () => {
	test('FB-008: a committed legacy post_reviewer boundary replays idempotently through the writer', async () => {
		await establishPrReviewPrerequisites(directory, 'fb008-replay');
		await persistExplorerCheckpoint('fb008-replay');
		// A reviewer phase must exist before post_reviewer can commit.
		await settleReviewerPhase(
			directory,
			'fb008-replay',
			candidateIds.map((id) => reviewedRow(id, 'CONFIRMED', 'HIGH')),
			candidateIds,
		);
		// Then overwrite the committed post_reviewer rows with v1-era
		// CONFIRMED+NONE rows (the strict write schema refuses a FRESH such
		// write, but the durable store can hold rows committed under earlier
		// semantics).
		const v1Records = candidateIds.map((id) =>
			artifactRecord(id, 'CONFIRMED', 'report', 'NONE'),
		);
		const rel = 'pr-review/fb008-replay/findings.jsonl';
		const abs = path.join(directory, '.swarm', ...rel.split('/'));
		const existingLines = (await fs.readFile(abs, 'utf8'))
			.split(String.fromCharCode(10))
			.filter((line) => line.length > 0 && !line.includes('"post_reviewer"'));
		const seeded = v1Records
			.map((record) =>
				JSON.stringify({
					...record,
					boundary: 'post_reviewer',
					pr_head_sha: HEAD_SHA,
					recorded_at: '2026-11-10T00:00:00.000Z',
				}),
			)
			.join(String.fromCharCode(10));
		await fs.writeFile(
			abs,
			[...existingLines, seeded].join(String.fromCharCode(10)) +
				String.fromCharCode(10),
		);
		await markPrReviewArtifactBoundary(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'fb008-replay',
			'post_reviewer',
			rel,
			candidateIds,
			false,
		);
		_test_exports.resetTrackedStateCache();
		// Exact replay of the committed boundary: admitted, nothing appended.
		const replay = await writePrReviewFindings(
			directory,
			'fb008-replay',
			'post_reviewer',
			v1Records,
		);
		expect(replay).toContain('"success": true');
		expect(replay).toContain('"replayed": true');
		// A non-identical payload still surfaces the strict schema error.
		const altered = await rejectionMessage(
			writePrReviewFindings(directory, 'fb008-replay', 'post_reviewer', [
				{ ...v1Records[0]!, evidence: 'changed evidence' },
				...v1Records.slice(1),
			]),
		);
		expect(altered).toContain('CONFIRMED finding severity must not be NONE');
	});
});
