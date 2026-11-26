/**
 * #3844 round-5 (plan-critic) findings-comparator executor pins: corrupt /
 * missing sidecar legs, the token-bearing severity-only committed replay
 * through the sidecar (FB-008 + #3844), and the same-family different-secret
 * conflict. Split from pr-review-artifact-claims-3844.test.ts (FR-006).
 * Synthetic tokens only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	markPrReviewArtifactBoundary,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	replayFingerprint,
	replaySidecarPath,
	writeReplayIdentityFingerprint,
} from '../../../src/security/replay-identity.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	artifactRecord,
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	rejectionMessage,
	reviewedRow,
	settleReviewerPhase,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const TOKEN = `ghp_${'z'.repeat(30)}`;

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
	directory = canonicalMkdtemp('pr-artifact-findings-3844-');
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

const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

function explorerRecordsFor(evidenceFor: (id: string) => string) {
	return candidateIds.map((id) => ({
		finding_id: id,
		status: 'PENDING' as const,
		file_line: 'src/index.ts:1',
		evidence: evidenceFor(id),
		next_action: 'route_to_reviewer' as const,
		severity: 'HIGH' as const,
		// The read path backfills UNKNOWN/[] on legacy rows lacking typed
		// risk metadata (issue #2383), so canonical parity needs them.
		risk_impact: 'UNKNOWN' as const,
		risk_tags: [] as string[],
	}));
}

function findingsPathFor(runId: string): string {
	return path.join(directory, '.swarm', 'pr-review', runId, 'findings.jsonl');
}

async function commitExplorer(
	runId: string,
	evidenceFor: (id: string) => string,
): Promise<void> {
	await establishPrReviewPrerequisites(directory, runId);
	await expect(
		executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: runId,
				pr_head_sha: HEAD_SHA,
				boundary: 'post_explorer',
				records: explorerRecordsFor(evidenceFor),
			},
			directory,
			{ sessionID: SESSION_ID },
		),
	).resolves.toContain('"success": true');
}

describe('#3844 round-5 findings comparator executor pins', () => {
	test('corrupt sidecar makes an exact retry FAIL CLOSED (never admitted as a replay)', async () => {
		const runId = 'findings-corrupt-sidecar';
		await commitExplorer(
			runId,
			(id) => `evidence mentioning ${TOKEN} for ${id}`,
		);
		nodeFs.writeFileSync(
			replaySidecarPath(directory, runId),
			'not json',
			'utf8',
		);
		const afterCorruption = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: runId,
				pr_head_sha: HEAD_SHA,
				boundary: 'post_explorer',
				records: explorerRecordsFor(
					(id) => `evidence mentioning ${TOKEN} for ${id}`,
				),
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(afterCorruption.includes('"replayed": true')).toBe(false);
	}, 120_000);

	test('legacy RAW rows with NO sidecar still exact-replay (legacy direct-compare leg)', async () => {
		const runId = 'findings-legacy';
		const records = explorerRecordsFor(
			(id) => `legacy raw evidence ${TOKEN} for ${id}`,
		);
		await commitExplorer(
			runId,
			(id) => `legacy raw evidence ${TOKEN} for ${id}`,
		);
		const findingsPath = findingsPathFor(runId);
		const persisted = (await fs.readFile(findingsPath, 'utf8'))
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const rawEvidenceById = new Map(
			records.map((record) => [record.finding_id, record.evidence]),
		);
		const rawLines = persisted
			.map((row) =>
				JSON.stringify({
					...row,
					evidence:
						rawEvidenceById.get(row.finding_id as string) ?? row.evidence,
				}),
			)
			.join('\n');
		nodeFs.writeFileSync(findingsPath, `${rawLines}\n`, 'utf8');
		nodeFs.rmSync(replaySidecarPath(directory, runId), { force: true });
		const replay = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: runId,
				pr_head_sha: HEAD_SHA,
				boundary: 'post_explorer',
				records,
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(replay).toContain('"replayed": true');
	}, 120_000);

	test('same-family DIFFERENT-secret retry conflicts (placeholders collide, fingerprints do not)', async () => {
		const runId = 'findings-sister-secret';
		const sisterToken = `ghp_${'y'.repeat(30)}`;
		await commitExplorer(
			runId,
			(id) => `evidence mentioning ${TOKEN} for ${id}`,
		);
		const conflict = await rejectionMessage(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: runId,
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecordsFor(
						(id) => `evidence mentioning ${sisterToken} for ${id}`,
					),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(conflict).toContain('an exact replay');
	}, 120_000);

	test('token-bearing severity-only committed replay through the SIDECAR (FB-008 + #3844)', async () => {
		const runId = 'findings-severity-sidecar';
		await establishPrReviewPrerequisites(directory, runId);
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: runId,
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecordsFor((id) => `discovery ${id}`),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');
		await settleReviewerPhase(
			directory,
			runId,
			candidateIds.map((id) => reviewedRow(id, 'CONFIRMED', 'HIGH')),
			candidateIds,
		);
		// Overwrite the committed post_reviewer rows with v1-era
		// CONFIRMED+NONE rows carrying token-bearing evidence, and seed the
		// sidecar with the fingerprint of their canonical form.
		const v1Records = candidateIds.map((id) =>
			artifactRecord(id, 'CONFIRMED', 'report', 'NONE'),
		);
		const rel = `pr-review/${runId}/findings.jsonl`;
		const abs = path.join(directory, '.swarm', ...rel.split('/'));
		const existingLines = (await fs.readFile(abs, 'utf8'))
			.split(String.fromCharCode(10))
			.filter((line) => line.length > 0 && !line.includes('"post_reviewer"'));
		const seededRows = v1Records.map((record, index) => ({
			...record,
			evidence: `v1 row evidence ${TOKEN} ${index}`,
			boundary: 'post_reviewer',
			pr_head_sha: HEAD_SHA,
			recorded_at: '2026-11-10T00:00:00.000Z',
		}));
		await fs.writeFile(
			abs,
			[...existingLines, ...seededRows.map((row) => JSON.stringify(row))].join(
				String.fromCharCode(10),
			) + String.fromCharCode(10),
		);
		await markPrReviewArtifactBoundary(
			directory,
			SESSION_ID,
			runId,
			'post_reviewer',
			rel,
			candidateIds,
			false,
		);
		// Sidecar identity for the seeded boundary: the canonical of the
		// incoming retry (severity omitted on CONFIRMED normalizes to NONE,
		// matching the seeded rows' explicit NONE).
		const canonical = JSON.stringify(
			v1Records
				.map((record, index) => ({
					finding_id: record.finding_id,
					status: record.status,
					file_line: record.file_line,
					evidence: `v1 row evidence ${TOKEN} ${index}`,
					next_action: record.next_action,
					severity: 'NONE',
					category: undefined,
					confidence: undefined,
					provenance: undefined,
					risk_impact: 'ORDINARY',
					risk_tags: [] as string[],
					critic_status: undefined,
					order_agreement: undefined,
				}))
				.sort((left, right) => left.finding_id.localeCompare(right.finding_id)),
		);
		writeReplayIdentityFingerprint(
			directory,
			runId,
			'findings:post_reviewer',
			replayFingerprint(directory, canonical),
		);
		_test_exports.resetTrackedStateCache();
		const replayRecords = v1Records.map((record, index) => ({
			...record,
			evidence: `v1 row evidence ${TOKEN} ${index}`,
		}));
		const replay = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: runId,
				pr_head_sha: HEAD_SHA,
				boundary: 'post_reviewer',
				records: replayRecords,
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(replay).toContain('"replayed": true');
	}, 120_000);
});
