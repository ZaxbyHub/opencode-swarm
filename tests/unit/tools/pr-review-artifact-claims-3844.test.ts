/**
 * #3844 round-5 (plan-critic) executor-level pins for the pr-review artifact
 * replay-identity mechanics — claim-once handoff identity (concurrent-writer
 * race), fail-closed claim/salt/sidecar legs at BOTH comparators, and the
 * documented inert residue when artifact creation fails after the identity
 * landed. Drives the real executeWritePrReviewArtifact; synthetic tokens only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	readReplayIdentityClaim,
	readReplayIdentitySidecar,
	replayFingerprint,
	replayIdentityClaimPath,
	replaySidecarPath,
} from '../../../src/security/replay-identity.js';
import {
	_internals as artifactInternals,
	executeWritePrReviewArtifact,
} from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
	rejectionMessage,
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
const originalAtomicCreate = artifactInternals.atomicCreate;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-artifact-claims-3844-');
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
	artifactInternals.atomicCreate = originalAtomicCreate;
	await fs.rm(directory, { recursive: true, force: true });
});

const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

/** Commit the full three-boundary review so a handoff is actionable. */
async function commitFullReview(runId: string): Promise<void> {
	await establishPrReviewPrerequisites(directory, runId);
	const explorerRecords = candidateIds.map((id) => ({
		finding_id: id,
		status: 'PENDING' as const,
		file_line: 'src/index.ts:1',
		evidence: 'discovery evidence',
		next_action: 'route_to_reviewer' as const,
		severity: 'HIGH' as const,
	}));
	const reviewerRecords = candidateIds.map((id, index) => ({
		finding_id: id,
		status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
		file_line: 'src/index.ts:1',
		evidence: 'reviewer evidence',
		next_action:
			index === 0
				? ('suppress_with_reason' as const)
				: ('route_to_critic' as const),
		severity: index === 0 ? ('NONE' as const) : ('HIGH' as const),
		...(index === 0
			? {}
			: { risk_impact: 'ORDINARY' as const, risk_tags: [] as string[] }),
	}));
	const criticRecords = candidateIds.map((id, index) => ({
		finding_id: id,
		status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
		file_line: 'src/index.ts:1',
		evidence: 'critic evidence',
		next_action:
			index === 0
				? ('suppress_with_reason' as const)
				: index === 1
					? ('handoff_to_feedback' as const)
					: ('report' as const),
		severity: index === 0 ? ('NONE' as const) : ('HIGH' as const),
		...(index === 0
			? {}
			: { risk_impact: 'ORDINARY' as const, risk_tags: [] as string[] }),
	}));
	const reviewerRows = candidateIds
		.map((id, index) =>
			index === 0
				? `[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `
				: `[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `,
		)
		.join('\n');
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${runId}-reviewer`,
				workflowLane: `${runId}-reviewer`,
				reviewItemIds: candidateIds,
			},
		],
		{ batchId: `${runId}-reviewer`, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${runId}-reviewer`,
		'swarm-pr-review:reviewer',
		[{ laneId: `${runId}-reviewer`, workflowLane: `${runId}-reviewer` }],
		{ textOverride: reviewerRows },
	);
	const criticRows = candidateIds
		.slice(1)
		.map((id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | no change`)
		.join('\n');
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'critic',
		[
			{
				laneId: `${runId}-critic`,
				agent: 'critic',
				workflowLane: `${runId}-critic`,
				reviewItemIds: candidateIds.slice(1),
			},
		],
		{ batchId: `${runId}-critic`, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${runId}-critic`,
		'swarm-pr-review:critic',
		[{ laneId: `${runId}-critic`, workflowLane: `${runId}-critic` }],
		{ textOverride: criticRows },
	);
	for (const [boundary, records] of [
		['post_explorer', explorerRecords],
		['post_reviewer', reviewerRecords],
		['post_critic', criticRecords],
	] as const) {
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: runId,
					pr_head_sha: HEAD_SHA,
					boundary,
					records,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');
	}
}

function handoffArgs(runId: string, summary: string) {
	return {
		kind: 'handoff' as const,
		run_id: runId,
		pr_head_sha: HEAD_SHA,
		handoff: {
			pr_url: 'https://github.com/example/project/pull/123',
			finding_ids: ['C-1'],
			summary,
			provenance: [runId],
		},
	};
}

function handoffPath(runId: string): string {
	return path.join(
		directory,
		'.swarm',
		'pr-review',
		runId,
		'feedback-handoff.json',
	);
}

describe('#3844 round-5 executor-level replay-identity pins', () => {
	test('successful handoff creates the claim-once identity; artifact redacted; claim == sidecar value', async () => {
		const runId = 'claims-success';
		await commitFullReview(runId);
		const result = await executeWritePrReviewArtifact(
			handoffArgs(runId, `summary mentioning ${TOKEN} inline`),
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(result).toContain('"success": true');
		const artifact = await fs.readFile(handoffPath(runId), 'utf8');
		expect(artifact.includes(TOKEN)).toBe(false); // persisted summary redacted
		const claim = readReplayIdentityClaim(directory, runId, 'handoff');
		expect(claim).toMatch(/^[0-9a-f]{64}$/);
		const sidecar = readReplayIdentitySidecar(directory, runId);
		expect(sidecar?.fingerprints['handoff']).toBe(claim);
	}, 120_000);

	test('concurrent-writer race: a pre-existing FOREIGN claim rejects different raw BEFORE any artifact bytes', async () => {
		const runId = 'claims-race-foreign';
		await commitFullReview(runId);
		// The concurrent winner claimed the identity for a DIFFERENT raw
		// summary but has not created the artifact yet.
		const winnerComparable = JSON.stringify({
			schema_version: 1,
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			pr_url: 'https://github.com/example/project/pull/123',
			finding_ids: ['C-1'],
			summary: `winner summary ${TOKEN}`,
			provenance: [runId],
		});
		const claimPath = replayIdentityClaimPath(directory, runId, 'handoff');
		nodeFs.mkdirSync(path.dirname(claimPath), { recursive: true });
		nodeFs.writeFileSync(
			claimPath,
			`${replayFingerprint(directory, winnerComparable)}\n`,
			'utf8',
		);
		const rejected = await rejectionMessage(
			executeWritePrReviewArtifact(
				handoffArgs(runId, 'loser summary with different raw content'),
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(rejected).toContain('conflicting concurrent handoff content');
		// Refused BEFORE creation: no artifact, and the winner's claim stands.
		await expect(fs.stat(handoffPath(runId))).rejects.toThrow();
		expect(readReplayIdentityClaim(directory, runId, 'handoff')).toBe(
			replayFingerprint(directory, winnerComparable),
		);
	}, 120_000);

	test('concurrent-writer race: an IDENTICAL-raw claim proceeds (retry dedups onto the winner)', async () => {
		const runId = 'claims-race-identical';
		await commitFullReview(runId);
		const summary = `same summary ${TOKEN}`;
		const mine = JSON.stringify({
			schema_version: 1,
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			pr_url: 'https://github.com/example/project/pull/123',
			finding_ids: ['C-1'],
			summary,
			provenance: [runId],
		});
		const claimPath = replayIdentityClaimPath(directory, runId, 'handoff');
		nodeFs.mkdirSync(path.dirname(claimPath), { recursive: true });
		nodeFs.writeFileSync(
			claimPath,
			`${replayFingerprint(directory, mine)}\n`,
			'utf8',
		);
		const claimBefore = await fs.readFile(claimPath, 'utf8');
		const result = await executeWritePrReviewArtifact(
			handoffArgs(runId, summary),
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(result).toContain('"success": true');
		expect(await fs.readFile(claimPath, 'utf8')).toBe(claimBefore);
		expect(await fs.readFile(handoffPath(runId), 'utf8')).toContain(
			'[REDACTED:github]',
		);
	}, 120_000);

	test('corrupt claim FAILS CLOSED (no artifact, no overwrite)', async () => {
		const runId = 'claims-corrupt-claim';
		await commitFullReview(runId);
		const claimPath = replayIdentityClaimPath(directory, runId, 'handoff');
		nodeFs.mkdirSync(path.dirname(claimPath), { recursive: true });
		nodeFs.writeFileSync(claimPath, 'not-hex-corrupt\n', 'utf8');
		const rejected = await rejectionMessage(
			executeWritePrReviewArtifact(
				handoffArgs(runId, 'any summary'),
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(rejected).toContain('handoff replay-identity claim');
		await expect(fs.stat(handoffPath(runId))).rejects.toThrow();
	}, 120_000);

	test('unavailable salt ABORTS before the artifact (sidecar-failure-prevents-creation)', async () => {
		const runId = 'claims-no-salt';
		await commitFullReview(runId);
		// A salt is created by the findings writes above; corrupt it so
		// fingerprinting (inside the claim step) fails closed.
		nodeFs.writeFileSync(
			path.join(directory, '.swarm', 'pr-review', 'replay-identity.salt'),
			'corrupt',
			'utf8',
		);
		const rejected = await rejectionMessage(
			executeWritePrReviewArtifact(
				handoffArgs(runId, 'saltless summary'),
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(rejected).toContain('handoff replay-identity claim');
		await expect(fs.stat(handoffPath(runId))).rejects.toThrow();
	}, 120_000);

	test('artifact-create failure after the identity landed leaves ONLY the documented inert residue', async () => {
		const runId = 'claims-residue';
		await commitFullReview(runId);
		artifactInternals.atomicCreate = async () => {
			throw new Error('simulated artifact-create failure');
		};
		try {
			const rejected = await rejectionMessage(
				executeWritePrReviewArtifact(
					handoffArgs(runId, `residue summary ${TOKEN}`),
					directory,
					{ sessionID: SESSION_ID },
				),
			);
			expect(rejected).toContain('operation create');
			// Inert residue: claim + sidecar exist; the artifact does not.
			expect(readReplayIdentityClaim(directory, runId, 'handoff')).toMatch(
				/^[0-9a-f]{64}$/,
			);
			expect(
				readReplayIdentitySidecar(directory, runId)?.fingerprints['handoff'],
			).toMatch(/^[0-9a-f]{64}$/);
			await expect(fs.stat(handoffPath(runId))).rejects.toThrow();
		} finally {
			artifactInternals.atomicCreate = originalAtomicCreate;
		}
		// The residue is inert: an IDENTICAL-raw retry still succeeds through it.
		const retry = await executeWritePrReviewArtifact(
			handoffArgs(runId, `residue summary ${TOKEN}`),
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(retry).toContain('"success": true');
	}, 120_000);

	test('existing artifact: different raw summary conflicts; identical raw dedups byte-stably', async () => {
		const runId = 'claims-retry';
		await commitFullReview(runId);
		const first = await executeWritePrReviewArtifact(
			handoffArgs(runId, `first summary ${TOKEN}`),
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(first).toContain('"success": true');
		const bytes = await fs.readFile(handoffPath(runId), 'utf8');
		// Same-family DIFFERENT-secret: both redact to the same placeholder,
		// but the raw fingerprints differ — the conflict must still fire.
		const sisterToken = `ghp_${'y'.repeat(30)}`;
		const conflict = await rejectionMessage(
			executeWritePrReviewArtifact(
				handoffArgs(runId, `first summary ${sisterToken}`),
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(conflict).toContain('conflicting handoff content');
		expect(await fs.readFile(handoffPath(runId), 'utf8')).toBe(bytes);
		const retry = await executeWritePrReviewArtifact(
			handoffArgs(runId, `first summary ${TOKEN}`),
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(retry).toContain('"success": true');
		expect(await fs.readFile(handoffPath(runId), 'utf8')).toBe(bytes);
	}, 120_000);

	test('legacy handoff artifact with NO claim/sidecar dedups via the direct raw compare', async () => {
		const runId = 'claims-handoff-legacy';
		await commitFullReview(runId);
		// Seed a v1-era handoff: RAW summary on disk, no claim, no sidecar.
		const legacySummary = `legacy raw summary ${TOKEN}`;
		const legacyRecord = {
			schema_version: 1,
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			created_at: '2026-11-01T00:00:00.000Z',
			pr_url: 'https://github.com/example/project/pull/123',
			finding_ids: ['C-1'],
			summary: legacySummary,
			provenance: [runId],
		};
		nodeFs.mkdirSync(path.dirname(handoffPath(runId)), { recursive: true });
		nodeFs.writeFileSync(
			handoffPath(runId),
			`${JSON.stringify(legacyRecord, null, 2)}
`,
			'utf8',
		);
		const retry = await executeWritePrReviewArtifact(
			handoffArgs(runId, legacySummary),
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(retry).toContain('"success": true');
		// The legacy artifact is untouched (the retry deduped, never rewrote).
		expect(
			JSON.parse(await fs.readFile(handoffPath(runId), 'utf8')).summary,
		).toBe(legacySummary);
	}, 120_000);
});
