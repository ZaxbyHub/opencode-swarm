/**
 * Issue #3358 AC5 (trace 3358-3337-3341, collated AC5 / #3358 AC4): the
 * durable findings record enforces the same CONFIRMED/NONE coherence rule the
 * transport enforces on reviewer verdict rows ("CONFIRMED reviewer severity
 * must not be NONE", pr-review-contract.ts).
 *
 * Leg 1 — `PrReviewFindingSchema` (pr-review-contract.ts:574) must reject a
 * finding with status CONFIRMED and severity NONE (every other field valid:
 * finding_id, file_line, evidence, next_action 'report', risk_impact UNKNOWN,
 * risk_tags []). At base the superRefine has no severity branch, so the exact
 * state the transport rejects is schema-valid.
 *
 * Leg 2 — the findings writer (`executeWritePrReviewArtifact`,
 * src/tools/write-pr-review-artifact.ts) validates its payload through
 * `WritePrReviewArtifactArgsSchema` (which embeds PrReviewFindingSchema)
 * before any workflow-state read, so a write attempt carrying CONFIRMED + NONE
 * must be rejected AT THAT BOUNDARY naming the severity/CONFIRMED coherence —
 * not sail past validation and fail later for an unrelated reason (the
 * no-active-workflow rejection it takes at base), and never reach the
 * writer's `record.severity ?? 'NONE'` coercion sites.
 *
 * Leg 3 (guard, GREEN at base) — a CONFIRMED record whose severity is ABSENT
 * must be rejected naming severity, or admitted without persisting it as
 * NONE. This is the existing #2279 projection guard; it is pinned here so the
 * schema tightening cannot quietly regress it.
 *
 * RED at base (legs 1 and 2), GREEN after the fix.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PrReviewFindingSchema } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	artifactRecord,
	artifactRecordWithoutSeverity,
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	reviewedRow,
	settleReviewerPhase,
	writePrReviewFindings,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Valid in every field except the coherence pair under test. */
const CONFIRMED_NONE_RECORD = {
	finding_id: 'C-NONE-1',
	status: 'CONFIRMED',
	file_line: 'src/a.ts:1',
	evidence: 'direct code evidence at the exact location',
	next_action: 'report',
	severity: 'NONE',
	risk_impact: 'UNKNOWN',
	risk_tags: [] as string[],
};

describe('issue #3358 AC5 leg 1: the findings schema enforces CONFIRMED/NONE coherence', () => {
	test('PrReviewFindingSchema rejects a CONFIRMED finding with severity NONE', () => {
		const parsed = PrReviewFindingSchema.safeParse(CONFIRMED_NONE_RECORD);
		expect(
			parsed.success,
			'the durable findings schema admitted a CONFIRMED finding with severity NONE — the exact state the reviewer transport rejects',
		).toBe(false);
		if (!parsed.success) {
			expect(
				parsed.error.issues.some(
					(issue) =>
						issue.path.includes('severity') || /CONFIRMED/i.test(issue.message),
				),
			).toBe(true);
		}
	});
});

describe('issue #3358 AC5 leg 2: the write boundary rejects CONFIRMED/NONE naming the coherence rule', () => {
	let directory = '';

	afterEach(() => {
		if (directory) safeRmRecursive(directory);
		directory = '';
	});

	test('a findings write carrying CONFIRMED + severity NONE is rejected for the severity itself', async () => {
		directory = canonicalMkdtemp('c5-writer-boundary-');
		const result = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				pr_head_sha: 'abc123',
				boundary: 'post_reviewer',
				records: [CONFIRMED_NONE_RECORD],
			},
			directory,
			{ sessionID: 'c5-writer-boundary' },
		);
		const decoded = JSON.parse(result) as {
			success?: boolean;
			message?: string;
		};
		// The write is refused at base too — but only because no PR workflow is
		// active, AFTER the incoherent record already passed write-boundary
		// validation. The refusal must instead name the record's own
		// severity/classification incoherence (schema-level rejection), proving
		// the coherence rule fires before any persistence decision or severity
		// coercion.
		expect(decoded.success).toBe(false);
		expect(decoded.message ?? '').toMatch(
			/severity/i,
			`the write boundary admitted a CONFIRMED/NONE record through validation and rejected the request only as: ${decoded.message ?? '(no message)'}`,
		);
		expect(decoded.message ?? '').toMatch(/CONFIRMED|NONE/i);
	});
});

describe('issue #3358 AC5 leg 3 (guard): CONFIRMED with absent severity is never persisted as NONE', () => {
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
		directory = canonicalMkdtemp('c5-absent-severity-');
		_test_exports.resetTrackedStateCache();
		_test_exports.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
		_test_exports.resolvePrWorkflowRevisionDigest = () =>
			PR_ARTIFACT_REVISION_DIGEST;
		_test_exports.resolveIsWorkingTreeClean = () => true;
		_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
			_test_exports.resolveCurrentGitHead(dir);
		_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
			_test_exports.resolveIsWorkingTreeClean(dir);
	});

	afterEach(() => {
		_test_exports.resetTrackedStateCache();
		_test_exports.resolveCurrentGitHead = originals.head;
		_test_exports.resolveCurrentGitHeadAsync = originals.headAsync;
		_test_exports.resolvePrWorkflowRevisionDigest = originals.digest;
		_test_exports.resolveIsWorkingTreeClean = originals.clean;
		_test_exports.resolveIsWorkingTreeCleanAsync = originals.cleanAsync;
		if (directory) safeRmRecursive(directory);
		directory = '';
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

	test('a post_reviewer CONFIRMED record without severity is rejected naming severity, or stored not-as-NONE', async () => {
		const runId = 'c5-absent-run';
		await establishPrReviewPrerequisites(directory, runId);
		// The post_explorer checkpoint every post_reviewer write requires.
		await writePrReviewFindings(
			directory,
			runId,
			'post_explorer',
			candidateIds.map((id) =>
				artifactRecord(id, 'PENDING', 'route_to_reviewer', 'HIGH'),
			),
		);
		await settleReviewerPhase(
			directory,
			runId,
			candidateIds.map((id) => reviewedRow(id, 'CONFIRMED', 'LOW')),
			candidateIds,
		);

		const result = await writePrReviewFindings(
			directory,
			runId,
			'post_reviewer',
			[
				artifactRecordWithoutSeverity('C-0', 'CONFIRMED', 'report'),
				...candidateIds
					.slice(1)
					.map((id) => artifactRecord(id, 'CONFIRMED', 'report', 'LOW')),
			],
		);
		const decoded = JSON.parse(result) as {
			success?: boolean;
			message?: string;
		};
		if (decoded.success !== false) {
			// Admitted: the persisted row must not carry (or default to) NONE.
			const reloaded = await reloadFindings(runId);
			const row = reloaded.find(
				(record) =>
					record.finding_id === 'C-0' && record.boundary === 'post_reviewer',
			);
			expect(row, 'the admitted record must be persisted').toBeTruthy();
			expect(row?.severity).not.toBe('NONE');
		} else {
			// Rejected: the refusal must name the severity field, never a
			// severity-unrelated failure.
			expect(decoded.message ?? '').toMatch(/severity/i);
		}
	});
});
