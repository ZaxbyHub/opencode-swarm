/**
 * #3844 Stage-B (FB-008): the handoff replay identity must be computed over
 * ONE comparable — the RAW one.
 *
 * The claim fingerprint and the comparison fingerprint used to be built over
 * DIFFERENT inputs (the claim over the REDACTED pr_url/provenance, the
 * comparison over the RAW ones). Whenever the raw text actually carried a
 * credential the two fingerprints disagreed, so an IDENTICAL retry was
 * refused as a "conflicting handoff content" and two different raw payloads
 * that redact to the same text shared one claim.
 *
 * Synthetic tokens only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { readReplayIdentitySidecar } from '../../../src/security/replay-identity';
import {
	_internals as artifactInternals,
	executeWritePrReviewArtifact,
} from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const GH = `ghp_${'h'.repeat(30)}`;
const GH_X = `ghp_${'x'.repeat(30)}`;
const GH_Y = `ghp_${'y'.repeat(30)}`;
// The fixture's established review run id — the artifact tool refuses a
// run_id that does not match the workflow's own lane identity.
const RUN_ID = 'test-run';

/** The handoff replay-identity CLAIM this run owns (64-hex fingerprint). */
function readClaim(directory: string): string {
	return readFileSync(
		path.join(
			directory,
			'.swarm',
			'pr-review',
			RUN_ID,
			'replay-identity.handoff.claim',
		),
		'utf-8',
	).trim();
}

/**
 * Copy the replay-identity SALT from one project root to another.
 *
 * The fingerprint is an HMAC over a per-project random salt, so two roots
 * have incomparable fingerprints unless they share the salt. A test that
 * compares fingerprints across roots MUST pin the salt, or the comparison
 * proves nothing about the payload.
 */
function copySalt(fromDir: string, toDir: string): void {
	const relative = path.join('.swarm', 'pr-review', 'replay-identity.salt');
	const target = path.join(toDir, relative);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, readFileSync(path.join(fromDir, relative), 'utf-8'));
}

beforeEach(setupPrWorkflowGateFixtures);
afterEach(async () => {
	_test_exports.beforePrFeedbackTransitionLock = undefined;
	await teardownPrWorkflowGateFixtures();
});

/**
 * Drive the review to its terminal boundary and write the handoff.
 *
 * `provenance` carries a synthetic credential so the REDACTED handoff record
 * and the RAW handoff payload genuinely differ — the shape that made the two
 * fingerprints disagree.
 */
async function writeHandoff(provenance: string[]) {
	await establishReviewPrerequisites();
	const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
		(_dimension, index) => `C-${index}`,
	);
	const handoffIds = [candidateIds[1] ?? 'C-1'];
	const explorerRecords = candidateIds.map((id) => ({
		finding_id: id,
		status: 'PENDING' as const,
		file_line: 'src/index.ts:1',
		evidence: `explorer evidence for ${id}`,
		next_action: 'route_to_reviewer' as const,
		severity: 'HIGH' as const,
	}));
	const reviewerRecords = candidateIds.map((id, index) => ({
		finding_id: id,
		status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
		file_line: 'src/index.ts:1',
		evidence: `reviewer evidence for ${id}`,
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
		evidence: `critic evidence for ${id}`,
		next_action:
			index === 0
				? ('suppress_with_reason' as const)
				: handoffIds.includes(id)
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
	const criticRows = candidateIds
		.slice(1)
		.map((id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | no change`)
		.join('\n');

	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: RUN_ID,
				workflowLane: RUN_ID,
				reviewItemIds: candidateIds,
			},
		],
		{ batchId: RUN_ID, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		RUN_ID,
		'swarm-pr-review:reviewer',
		[{ laneId: RUN_ID, workflowLane: RUN_ID }],
		{ textOverride: reviewerRows },
	);
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'critic',
		[
			{
				laneId: `${RUN_ID}-critic`,
				agent: 'critic',
				workflowLane: `${RUN_ID}-critic`,
				reviewItemIds: candidateIds.slice(1),
			},
		],
		{ batchId: `${RUN_ID}-critic`, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		`${RUN_ID}-critic`,
		'swarm-pr-review:critic',
		[{ laneId: `${RUN_ID}-critic`, workflowLane: `${RUN_ID}-critic` }],
		{ textOverride: criticRows },
	);

	await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_explorer',
			records: explorerRecords,
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_reviewer',
			records: reviewerRecords,
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			boundary: 'post_critic',
			records: criticRecords,
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);

	const handoff = {
		pr_url: 'https://github.com/owner/repo/pull/155',
		finding_ids: handoffIds,
		summary: 'validated actionable finding',
		provenance,
	};
	await executeWritePrReviewArtifact(
		{
			kind: 'handoff',
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			handoff,
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
	return { handoff, handoffIds };
}

describe('#3844 FB-008: the handoff replay identity uses ONE comparable', () => {
	test('an IDENTICAL retry of a credential-bearing handoff is not refused as a conflict', async () => {
		const provenance = ['review-boundaries', `critic-boundaries?token=${GH}`];
		const { handoff } = await writeHandoff(provenance);

		// The persisted artifact is redacted — the raw credential is gone.
		const persisted = await Bun.file(
			`${tempDir}/.swarm/pr-review/${RUN_ID}/feedback-handoff.json`,
		).text();
		expect(persisted).not.toContain(GH);
		// The family arm labels the placeholder specifically
		// ([REDACTED:github]); the round-9 placeholder guard stopped the
		// query arm from re-matching the family placeholder into the
		// generic [REDACTED]. Pin the placeholder PREFIX, not one label.
		expect(persisted).toContain('[REDACTED');

		// The SAME raw payload again: the replay identity must recognise it.
		const retry = await executeWritePrReviewArtifact(
			{
				kind: 'handoff',
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				handoff,
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);
		const retryResult = JSON.parse(retry) as {
			success?: boolean;
			message?: string;
		};
		expect(retryResult.success).toBe(true);
		expect(String(retryResult.message ?? '')).not.toContain('conflicting');
	}, 60_000);

	test('a DIFFERENT raw handoff is still refused as a conflict', async () => {
		const { handoffIds } = await writeHandoff([
			'review-boundaries',
			`critic-boundaries?token=${GH}`,
		]);

		const conflicting = await executeWritePrReviewArtifact(
			{
				kind: 'handoff',
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				handoff: {
					pr_url: 'https://github.com/owner/repo/pull/155',
					finding_ids: handoffIds,
					summary: 'a different summary',
					provenance: ['review-boundaries', 'critic-boundaries'],
				},
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);
		const conflictResult = JSON.parse(conflicting) as {
			success?: boolean;
			message?: string;
		};
		expect(conflictResult.success).toBe(false);
		expect(String(conflictResult.message ?? '')).toContain('conflicting');
	}, 60_000);

	test('the claim binds the RAW payload: two secrets that redact alike get different claims', async () => {
		// Two DIFFERENT credentials of the same shape redact to the SAME
		// text. If the claim fingerprint were computed over the REDACTED
		// payload, both would hash to one fingerprint and a second writer
		// would be admitted as the owner of the first writer's identity.
		// The claim is a function of the RAW payload, so the two runs below
		// MUST produce different claim fingerprints.
		//
		// The fingerprint is an HMAC over a PER-PROJECT random salt, so the
		// two runs must share the salt: with different salts the claims
		// would differ for reasons that have nothing to do with the
		// payload, and the assertion would prove nothing.
		const dirX = tempDir;
		try {
			await writeHandoff([
				'review-boundaries',
				`critic-boundaries?token=${GH_X}`,
			]);
			const claimX = readClaim(dirX);

			// A second, INDEPENDENT run whose only difference is the secret's
			// VALUE (the fixture re-points tempDir at a fresh root), with
			// the SAME salt so the two fingerprints are comparable.
			setupPrWorkflowGateFixtures();
			const dirY = tempDir;
			copySalt(dirX, dirY);
			await writeHandoff([
				'review-boundaries',
				`critic-boundaries?token=${GH_Y}`,
			]);
			const claimY = readClaim(dirY);

			expect(claimX).toMatch(/^[0-9a-f]{64}$/);
			expect(claimY).toMatch(/^[0-9a-f]{64}$/);
			expect(claimY).not.toBe(claimX);
		} finally {
			// The first run's root is no longer the fixture's current one, so
			// the fixture teardown would not remove it.
			rmSync(dirX, { recursive: true, force: true });
		}
	}, 60_000);

	test('a failed findings write rolls the identity back, so the retry is NOT a silent replay', async () => {
		// The sidecar-first ordering lands the raw-replay identity BEFORE the
		// artifact it describes. If the artifact write then fails, the sidecar
		// would keep claiming an identity the artifact never committed, and
		// the next identical retry would read it as "already persisted", skip
		// the write and SILENTLY DROP the new content while reporting
		// success. The failed write must therefore ROLL the identity back.
		await establishReviewPrerequisites();
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		const explorerRecords = candidateIds.map((id) => ({
			finding_id: id,
			status: 'PENDING' as const,
			file_line: 'src/index.ts:1',
			evidence: `explorer evidence for ${id}`,
			next_action: 'route_to_reviewer' as const,
			severity: 'HIGH' as const,
		}));
		const writeExplorer = () =>
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: RUN_ID,
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords,
				},
				tempDir,
				{ sessionID: SESSION_ID },
			);

		// 1. The artifact write fails.
		const realWrite = artifactInternals.atomicWrite;
		artifactInternals.atomicWrite = (async () => {
			throw new Error('ENOSPC simulated artifact write failure');
		}) as typeof artifactInternals.atomicWrite;
		let failed: Record<string, unknown>;
		try {
			failed = JSON.parse(await writeExplorer()) as Record<string, unknown>;
		} finally {
			artifactInternals.atomicWrite = realWrite;
		}
		expect(failed.success).toBe(false);

		// 2. The identity the failed write had landed was ROLLED BACK: the
		// sidecar must not claim a boundary whose rows were never persisted.
		// (The sidecar key is `findings:<boundary>` — a wrong key here would
		// make the assertion vacuous.)
		const sidecar = readReplayIdentitySidecar(tempDir, RUN_ID);
		expect(sidecar?.fingerprints['findings:post_explorer']).toBeUndefined();
		expect(
			Object.keys(sidecar?.fingerprints ?? {}).filter((key) =>
				key.startsWith('findings:'),
			),
		).toEqual([]);

		// 3. The retry WRITES the content (it is not read as a replay).
		const retried = JSON.parse(await writeExplorer()) as {
			success?: boolean;
			replayed?: boolean;
			appended?: number;
		};
		expect(retried.success, JSON.stringify(retried)).toBe(true);
		expect(retried.replayed).toBe(false);
		expect(retried.appended).toBe(explorerRecords.length);

		// 4. The persisted artifact really carries the rows.
		const findings = readFileSync(
			path.join(tempDir, '.swarm', 'pr-review', RUN_ID, 'findings.jsonl'),
			'utf-8',
		);
		expect(findings).toContain('C-0');
	}, 60_000);
});
