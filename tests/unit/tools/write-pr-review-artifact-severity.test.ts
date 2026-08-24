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

describe('#2279 severity acceptance criteria', () => {
	test('AC1: a NONE severity persists and reloads verbatim', async () => {
		const runId = 'none-run';
		await establishPrReviewPrerequisites(directory, runId);
		await expect(persistExplorerCheckpoint(runId)).resolves.toContain(
			'"success": true',
		);
		// A DISPROVED reviewer verdict legitimately carries NONE — the value that
		// was previously unrepresentable in the findings artifact.
		await settleReviewerPhase(
			directory,
			runId,
			[
				reviewedRow('C-0', 'DISPROVED', 'NONE'),
				...candidateIds
					.slice(1)
					.map((id) => reviewedRow(id, 'CONFIRMED', 'LOW')),
			],
			candidateIds,
		);

		await expect(
			writePrReviewFindings(directory, runId, 'post_reviewer', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				...candidateIds
					.slice(1)
					.map((id) => artifactRecord(id, 'CONFIRMED', 'report', 'LOW')),
			]),
		).resolves.toContain('"success": true');

		// The artifact is append-only, so scope to the boundary under test rather
		// than to the first row for this id (which is the explorer checkpoint).
		const reloaded = await reloadFindings(runId);
		const c0 = reloaded.find(
			(record) =>
				record.finding_id === 'C-0' && record.boundary === 'post_reviewer',
		);
		expect(c0?.severity).toBe('NONE');
	});

	test('AC2: omitting severity is rejected and names the required value', async () => {
		const runId = 'omitted-run';
		await establishPrReviewPrerequisites(directory, runId);
		await expect(persistExplorerCheckpoint(runId)).resolves.toContain(
			'"success": true',
		);
		await settleReviewerPhase(
			directory,
			runId,
			candidateIds.map((id) => reviewedRow(id, 'CONFIRMED', 'LOW')),
			candidateIds,
		);

		const message = await rejectionMessage(
			writePrReviewFindings(directory, runId, 'post_reviewer', [
				artifactRecordWithoutSeverity('C-0', 'CONFIRMED', 'report'),
				...candidateIds
					.slice(1)
					.map((id) => artifactRecord(id, 'CONFIRMED', 'report', 'LOW')),
			]),
		);

		expect(message).toBe(
			[
				'BLOCKED: PR_REVIEW post_reviewer artifact invalid — 1 violation(s):',
				'  C-0: severity expected "LOW", got (omitted)',
			].join('\n'),
		);
	});

	test('AC3/AC4: a critic downgrade persists as LOW beside reviewer-matched siblings', async () => {
		const runId = 'downgrade-persist-run';
		await establishPrReviewPrerequisites(directory, runId);
		await expect(persistExplorerCheckpoint(runId)).resolves.toContain(
			'"success": true',
		);
		// C-1 is critic-routed (CONFIRMED + MEDIUM). Everything else stays at LOW,
		// which is NOT critic-routed, so those keep matching the reviewer (AC4).
		await settleReviewerPhase(
			directory,
			runId,
			[
				reviewedRow('C-0', 'DISPROVED', 'NONE'),
				reviewedRow('C-1', 'CONFIRMED', 'MEDIUM'),
				...candidateIds
					.slice(2)
					.map((id) => reviewedRow(id, 'CONFIRMED', 'LOW')),
			],
			candidateIds,
		);
		await settleCriticPhase(
			directory,
			runId,
			['[CRITIC] | C-1 | DOWNGRADED | LOW | rationale | suggested change'],
			['C-1'],
		);

		await expect(
			writePrReviewFindings(directory, runId, 'post_reviewer', [
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				artifactRecord('C-1', 'CONFIRMED', 'route_to_critic', 'MEDIUM'),
				...candidateIds
					.slice(2)
					.map((id) => artifactRecord(id, 'CONFIRMED', 'report', 'LOW')),
			]),
		).resolves.toContain('"success": true');

		await expect(
			writePrReviewFindings(directory, runId, 'post_critic', [
				// AC4: reviewer-authoritative, unchanged.
				artifactRecord('C-0', 'DISPROVED', 'suppress_with_reason', 'NONE'),
				// AC3: the critic downgraded MEDIUM -> LOW, encodable verbatim and
				// with NO field omission.
				artifactRecord('C-1', 'CONFIRMED', 'report', 'LOW'),
				...candidateIds
					.slice(2)
					.map((id) => artifactRecord(id, 'CONFIRMED', 'report', 'LOW')),
			]),
		).resolves.toContain('"success": true');

		const reloaded = await reloadFindings(runId);
		const latest = new Map<string, Record<string, unknown>>();
		for (const record of reloaded) {
			if (record.boundary === 'post_critic') {
				latest.set(record.finding_id as string, record);
			}
		}
		expect(latest.get('C-1')?.severity).toBe('LOW');
		expect(latest.get('C-0')?.severity).toBe('NONE');
	});

	test('a legacy record persisted WITHOUT severity still reloads', async () => {
		// Durable readability: rows written before severity became mandatory have no
		// `severity` key. `readFindings` JSON-parses persisted lines with no schema
		// re-validation, so the READ shape must stay tolerant even though the WRITE
		// boundary now requires the field. A required read shape would be a lie about
		// data already on disk.
		const runId = 'legacy-reload-run';
		await establishPrReviewPrerequisites(directory, runId);

		// Seed the artifact with a legacy-shaped row: no `severity` key at all.
		const artifactDir = path.join(directory, '.swarm', 'pr-review', runId);
		await fs.mkdir(artifactDir, { recursive: true });
		const legacyRow = {
			finding_id: 'C-0',
			status: 'PENDING',
			file_line: 'src/index.ts:1',
			evidence: 'legacy record written before required-severity',
			next_action: 'route_to_reviewer',
			boundary: 'post_explorer',
			pr_head_sha: HEAD_SHA,
			recorded_at: '2026-01-01T00:00:00.000Z',
		};
		await fs.writeFile(
			path.join(artifactDir, 'findings.jsonl'),
			`${JSON.stringify(legacyRow)}
`,
			'utf8',
		);

		// A subsequent write must read the existing artifact without throwing.
		await expect(persistExplorerCheckpoint(runId)).resolves.toContain(
			'"success": true',
		);

		const reloaded = await reloadFindings(runId);
		const legacy = reloaded.find(
			(record) => record.recorded_at === '2026-01-01T00:00:00.000Z',
		);
		expect(legacy).toBeDefined();
		expect(legacy?.severity).toBeUndefined();
	});

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

	test('post_explorer severity must equal the candidate row that produced it', async () => {
		// #2320: the candidate rows the inventory is derived from ARE the authority
		// at this boundary. Fixture candidate rows declare HIGH.
		const runId = 'explorer-authority-run';
		await establishPrReviewPrerequisites(directory, runId);

		// A wrong-but-legal value is now rejected by exact comparison — this is the
		// hole that presence-and-domain enforcement alone left open.
		const wrong = await rejectionMessage(
			writePrReviewFindings(
				directory,
				runId,
				'post_explorer',
				candidateIds.map((id, index) =>
					artifactRecord(
						id,
						'PENDING',
						'route_to_reviewer',
						index === 0 ? 'LOW' : 'HIGH',
					),
				),
			),
		);
		expect(wrong).toBe(
			[
				'BLOCKED: PR_REVIEW post_explorer artifact invalid — 1 violation(s):',
				'  C-0: severity expected "HIGH", got "LOW"',
			].join('\n'),
		);

		// Omission is reported against the same authority.
		const omitted = await rejectionMessage(
			writePrReviewFindings(
				directory,
				runId,
				'post_explorer',
				candidateIds.map((id, index) =>
					index === 0
						? artifactRecordWithoutSeverity(id, 'PENDING', 'route_to_reviewer')
						: artifactRecord(id, 'PENDING', 'route_to_reviewer', 'HIGH'),
				),
			),
		);
		expect(omitted).toContain('C-0: severity expected "HIGH", got (omitted)');

		// `NONE` can never match a candidate row, so it is rejected here too.
		const fabricated = await rejectionMessage(
			writePrReviewFindings(
				directory,
				runId,
				'post_explorer',
				candidateIds.map((id, index) =>
					artifactRecord(
						id,
						'PENDING',
						'route_to_reviewer',
						index === 0 ? 'NONE' : 'HIGH',
					),
				),
			),
		);
		expect(fabricated).toContain('C-0: severity expected "HIGH", got "NONE"');

		// The matching payload is accepted.
		await expect(
			writePrReviewFindings(
				directory,
				runId,
				'post_explorer',
				candidateIds.map((id) =>
					artifactRecord(id, 'PENDING', 'route_to_reviewer', 'HIGH'),
				),
			),
		).resolves.toContain('"success": true');
	});
});
