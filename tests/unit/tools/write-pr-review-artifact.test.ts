import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	completePrWorkflow,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
	rejectionMessage,
} from '../../helpers/pr-review-artifact-fixtures.js';

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const REVISION_DIGEST = PR_ARTIFACT_REVISION_DIGEST;

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
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'write-pr-review-artifact-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
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

describe('write_pr_review_artifact', () => {
	test('ARTIFACT-ORDER regression: requires explorer, reviewer, then critic checkpoints', async () => {
		await establishPrReviewPrerequisites(directory, 'coverage-order');
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		const explorerRecords = candidateIds.map((id) => ({
			finding_id: id,
			status: 'PENDING' as const,
			file_line: 'src/index.ts:1',
			evidence: 'discovery evidence',
			next_action: 'route_to_reviewer' as const,
			// Regression: parser-valid INFO findings were rejected by the writer schema.
			severity: 'INFO' as const,
		}));
		const findingsPath = path.join(
			directory,
			'.swarm',
			'pr-review',
			'coverage-order',
			'findings.jsonl',
		);
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'coverage-order',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords.slice(0, -1),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/exactly cover/i);
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'coverage-order',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: explorerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/prior post_explorer checkpoint/i);
		await expect(fs.stat(findingsPath)).rejects.toThrow();
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'coverage-order',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');
		expect(await fs.readFile(findingsPath, 'utf8')).toContain(
			'"severity":"INFO"',
		);
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'coverage-order',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: explorerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(/reviewer/i);
	});

	test('ARTIFACT-VERDICT regression: persists only reviewer and critic-authoritative dispositions', async () => {
		await establishPrReviewPrerequisites(directory, 'review-boundaries');
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		const explorerRecords = candidateIds.map((id) => ({
			finding_id: id,
			status: 'PENDING' as const,
			file_line: 'src/index.ts:1',
			evidence: 'discovery evidence',
			next_action: 'route_to_reviewer' as const,
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
		}));
		const reviewerRows = candidateIds
			.map((id, index) =>
				index === 0
					? `[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | rationale | probe | reviewer`
					: `[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-boundaries',
					workflowLane: 'review-boundaries',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'review-boundaries', prHeadSha: HEAD_SHA },
		);
		await persistPrReviewBatch(
			directory,
			'review-boundaries',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-boundaries', workflowLane: 'review-boundaries' }],
			{ textOverride: reviewerRows },
		);
		const criticRows = candidateIds
			.map((id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | no change`)
			.join('\n');
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-boundaries',
					workflowLane: 'critic-boundaries',
					reviewItemIds: candidateIds.slice(1),
				},
			],
			{ batchId: 'critic-boundaries', prHeadSha: HEAD_SHA },
		);
		await persistPrReviewBatch(
			directory,
			'critic-boundaries',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-boundaries', workflowLane: 'critic-boundaries' }],
			{ textOverride: criticRows },
		);

		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');
		const reviewerOverrideMessage = await rejectionMessage(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: reviewerRecords.map((record) => ({
						...record,
						status: 'DISPROVED' as const,
						next_action: 'suppress_with_reason' as const,
					})),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
			// All violations are reported at once with expected-vs-actual (issue #2277).
		);
		expect(reviewerOverrideMessage).toBe(
			[
				'BLOCKED: PR_REVIEW post_reviewer artifact invalid — 10 violation(s):',
				'  C-1: status expected "CONFIRMED", got "DISPROVED"',
				'  C-1: next_action expected "route_to_critic", got "suppress_with_reason"',
				'  C-2: status expected "CONFIRMED", got "DISPROVED"',
				'  C-2: next_action expected "route_to_critic", got "suppress_with_reason"',
				'  C-3: status expected "CONFIRMED", got "DISPROVED"',
				'  C-3: next_action expected "route_to_critic", got "suppress_with_reason"',
				'  C-4: status expected "CONFIRMED", got "DISPROVED"',
				'  C-4: next_action expected "route_to_critic", got "suppress_with_reason"',
				'  C-5: status expected "CONFIRMED", got "DISPROVED"',
				'  C-5: next_action expected "route_to_critic", got "suppress_with_reason"',
			].join('\n'),
		);
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: reviewerRecords.map((record, index) =>
						index === 0
							? { ...record, next_action: 'report' as const }
							: record,
					),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).rejects.toThrow(
			/C-0: next_action expected "suppress_with_reason", got "report"/,
		);

		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_reviewer',
					records: reviewerRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');
		const criticOverrideMessage = await rejectionMessage(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_critic',
					records: criticRecords.map((record) => ({
						...record,
						status: 'DISPROVED' as const,
						next_action: 'suppress_with_reason' as const,
					})),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(criticOverrideMessage).toBe(
			[
				'BLOCKED: PR_REVIEW post_critic artifact invalid — 10 violation(s):',
				'  C-1: status expected "CONFIRMED", got "DISPROVED"',
				'  C-1: next_action expected "report" or "handoff_to_feedback", got "suppress_with_reason"',
				'  C-2: status expected "CONFIRMED", got "DISPROVED"',
				'  C-2: next_action expected "report" or "handoff_to_feedback", got "suppress_with_reason"',
				'  C-3: status expected "CONFIRMED", got "DISPROVED"',
				'  C-3: next_action expected "report" or "handoff_to_feedback", got "suppress_with_reason"',
				'  C-4: status expected "CONFIRMED", got "DISPROVED"',
				'  C-4: next_action expected "report" or "handoff_to_feedback", got "suppress_with_reason"',
				'  C-5: status expected "CONFIRMED", got "DISPROVED"',
				'  C-5: next_action expected "report" or "handoff_to_feedback", got "suppress_with_reason"',
			].join('\n'),
		);

		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'review-boundaries',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_critic',
					records: criticRecords,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');

		await expect(
			readPrWorkflowGateState(directory, SESSION_ID),
		).resolves.toMatchObject({
			prReviewArtifactRunId: 'review-boundaries',
			prReviewFindingsPath: 'pr-review/review-boundaries/findings.jsonl',
			prReviewArtifactBoundaries: [
				'post_explorer',
				'post_reviewer',
				'post_critic',
			],
		});

		const handoffArgs = {
			kind: 'handoff' as const,
			run_id: 'review-boundaries',
			pr_head_sha: HEAD_SHA,
			handoff: {
				pr_url: 'https://github.com/example/project/pull/123',
				finding_ids: ['C-1'],
				summary: 'validated actionable finding',
				provenance: ['review-boundaries', 'critic-boundaries'],
			},
		};
		const wrongHandoff = await executeWritePrReviewArtifact(
			{
				...handoffArgs,
				handoff: { ...handoffArgs.handoff, finding_ids: ['C-0'] },
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(wrongHandoff).toContain('"success": false');
		await expect(
			executeWritePrReviewArtifact(handoffArgs, directory, {
				sessionID: SESSION_ID,
			}),
		).resolves.toContain('feedback-handoff.json');
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		).resolves.toBe('completed');
	});
});
