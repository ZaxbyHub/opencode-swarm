import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
	_test_exports,
	completePrWorkflow,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readAuthoritativePrReviewCriticSettlements,
	readPrReviewFinalFindingPolicyForReport,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	assessTerminalReadiness,
	readReviewOutcome,
} from '../../../src/pr-review/finding-policy.js';
import {
	_internals as artifactInternals,
	executeWritePrReviewArtifact,
} from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishPrReviewPrerequisites,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'write-pr-review-artifact';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'revision-1';
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
	directory = canonicalMkdtemp('pr-review-policy-integration-');
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

describe('PR-review finding policy writer/reader integration', () => {
	test('retains independent provenance and blocks a non-terminal critic settlement', async () => {
		await establishPrReviewPrerequisites(directory, 'policy-open');
		const findingIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		const explorerRecords = findingIds.map((finding_id) => ({
			finding_id,
			status: 'PENDING' as const,
			file_line: 'src/index.ts:1',
			evidence: 'discovery evidence',
			next_action: 'route_to_reviewer' as const,
			severity: 'HIGH' as const,
		}));
		const reviewerRecords = findingIds.map((finding_id, index) => ({
			finding_id,
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
		const criticRecords = findingIds.map((finding_id, index) => ({
			finding_id,
			status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
			file_line: 'src/index.ts:1',
			evidence: 'critic evidence',
			next_action:
				index === 0 ? ('suppress_with_reason' as const) : ('report' as const),
			severity: index === 0 ? ('NONE' as const) : ('HIGH' as const),
			...(index === 0
				? {}
				: {
						risk_impact: 'ORDINARY' as const,
						risk_tags: [] as string[],
						...(index === 1
							? { provenance: ['reviewer-a', 'reviewer-b'] }
							: {}),
					}),
		}));
		const reviewerRows = findingIds
			.map((finding_id, index) =>
				index === 0
					? `[REVIEWED] | ${finding_id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `
					: `[REVIEWED] | ${finding_id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `,
			)
			.join('\n');
		const criticRows = findingIds
			.slice(1)
			.map(
				(finding_id) =>
					`[CRITIC] | ${finding_id} | UPHELD | HIGH | reason | no change`,
			)
			.join('\n');
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'policy-reviewer',
					workflowLane: 'policy-reviewer',
					reviewItemIds: findingIds,
				},
			],
			{ batchId: 'policy-reviewer', prHeadSha: HEAD_SHA },
		);
		await persistPrReviewBatch(
			directory,
			'policy-reviewer',
			'swarm-pr-review:reviewer',
			[{ laneId: 'policy-reviewer', workflowLane: 'policy-reviewer' }],
			{ textOverride: reviewerRows },
		);
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'policy-critic',
					workflowLane: 'policy-critic',
					reviewItemIds: findingIds.slice(1),
				},
			],
			{ batchId: 'policy-critic', prHeadSha: HEAD_SHA },
		);
		const pendingCriticSettlements =
			await readAuthoritativePrReviewCriticSettlements(directory, SESSION_ID);
		expect(pendingCriticSettlements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					findingId: 'C-1',
					terminal: false,
					status: 'NEEDS_MORE_EVIDENCE',
				}),
			]),
		);
		expect(
			assessTerminalReadiness({
				baseReceipt: { id: 'base', valid: true },
				reviewerReceipts: [{ id: 'reviewer', valid: true }],
				criticReceipt: { id: 'critic', valid: true },
				coverage: { kind: 'base', quality: 'complete', provenance: 'valid' },
				council: { enabled: false },
				criticSettlements: pendingCriticSettlements,
			}).blockers,
		).toContain('CRITIC_SETTLEMENT_INCOMPLETE');
		await persistPrReviewBatch(
			directory,
			'policy-critic',
			'swarm-pr-review:critic',
			[{ laneId: 'policy-critic', workflowLane: 'policy-critic' }],
			{ textOverride: criticRows },
		);

		for (const [boundary, records] of [
			['post_explorer', explorerRecords],
			['post_reviewer', reviewerRecords],
			['post_critic', criticRecords],
		] as const) {
			if (boundary === 'post_critic') {
				const contradictoryRecords = records.map((record) =>
					record.finding_id === 'C-1'
						? { ...record, critic_status: 'NEEDS_MORE_EVIDENCE' as const }
						: record,
				);
				await expect(
					executeWritePrReviewArtifact(
						{
							kind: 'findings',
							run_id: 'policy-open',
							pr_head_sha: HEAD_SHA,
							boundary,
							records: contradictoryRecords,
						},
						directory,
						{ sessionID: SESSION_ID },
					),
				).resolves.toMatch(
					/contradicts the authenticated authoritative critic status/,
				);
			}
			await expect(
				executeWritePrReviewArtifact(
					{
						kind: 'findings',
						run_id: 'policy-open',
						pr_head_sha: HEAD_SHA,
						boundary,
						records,
					},
					directory,
					{ sessionID: SESSION_ID },
				),
			).resolves.toContain('"success": true');
		}

		const outcome = await readReviewOutcome({
			projectRoot: directory,
			sessionId: SESSION_ID,
			taskId: 'policy-open',
		});
		const synthesis = outcome.evidence.synthesis as {
			findings: Array<{ provenance?: Array<{ identity: string }> }>;
			criticSettlements: Array<{
				findingId: string;
				terminal: boolean;
				status: string;
			}>;
		};
		expect(
			synthesis.findings[0]?.provenance?.map(({ identity }) => identity),
		).toEqual(expect.arrayContaining(['reviewer-a', 'reviewer-b']));
		expect(synthesis.criticSettlements).toContainEqual(
			expect.objectContaining({
				findingId: 'C-1',
				terminal: true,
				status: 'UPHELD',
			}),
		);
		await expect(
			readPrReviewFinalFindingPolicyForReport(directory, SESSION_ID),
		).resolves.toMatchObject({
			policyVersion: 1,
			permittedVerdicts: expect.arrayContaining(['REQUEST_CHANGES']),
		});
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				// C-1..C-5 remain HIGH/UPHELD and therefore allow only REQUEST_CHANGES.
				reportVerdict: 'REQUEST_CHANGES',
			}),
		).resolves.toBe('completed');
	});

	test('rejects an authenticated DOWNGRADED settlement when persisted severity is omitted', () => {
		const records = [
			{
				finding_id: 'finding-nf3',
				status: 'CONFIRMED',
				file_line: 'src/index.ts:1',
				evidence: 'NF-3 fixture evidence',
				next_action: 'report',
				risk_impact: 'HIGH_IMPACT',
				risk_tags: [],
			},
		] as Parameters<typeof artifactInternals.assertCriticSettlements>[0];
		const prior = [
			{
				finding_id: 'finding-nf3',
				status: 'CONFIRMED',
				file_line: 'src/index.ts:1',
				evidence: 'NF-3 fixture evidence',
				next_action: 'route_to_critic',
				severity: 'MEDIUM',
				boundary: 'post_reviewer',
				pr_head_sha: HEAD_SHA,
				recorded_at: '2026-01-01T00:00:00.000Z',
			},
		] as Parameters<typeof artifactInternals.assertCriticSettlements>[1];

		expect(() =>
			artifactInternals.assertCriticSettlements(
				records,
				prior,
				new Map([['finding-nf3', { status: 'DOWNGRADED', severity: 'LOW' }]]),
			),
		).toThrow('requires an explicit severity matching the authenticated');
	});
});
