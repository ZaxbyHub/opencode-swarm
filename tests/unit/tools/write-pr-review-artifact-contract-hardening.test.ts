import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as artifactInternals,
	executeWritePrReviewArtifact,
} from '../../../src/tools/write-pr-review-artifact.js';
import {
	artifactRecord,
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const SESSION_ID = PR_ARTIFACT_SESSION_ID;

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
const originalAtomicWrite = artifactInternals.atomicWrite;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-artifact-contract-hardening-');
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

function explorerRecords() {
	return Array.from({ length: 6 }, (_unused, index) => ({
		...artifactRecord(`C-${index}`, 'PENDING', 'route_to_reviewer', 'HIGH'),
		// Replay identity includes the typed risk fields (issue #2383): a row
		// persisted without them reads back normalized to UNKNOWN / no tags, so
		// an exact retry must carry those same values to be recognized.
		risk_impact: 'UNKNOWN' as const,
		risk_tags: [] as string[],
	}));
}

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	artifactInternals.atomicWrite = originalAtomicWrite;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('write_pr_review_artifact contract hardening (#2333)', () => {
	test('schema errors name the field, offending value, and legal contract', async () => {
		await establishPrReviewPrerequisites(directory, 'contract-errors');
		const raw = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'contract-errors',
				pr_head_sha: HEAD_SHA,
				boundary: 'post_explorer',
				records: [
					{
						finding_id: '',
						status: 'NOT_A_STATUS',
						file_line: '',
						evidence: '',
						next_action: 'ship_it',
						severity: 'SEVERE',
						extra_field: 'forbidden',
					},
				],
				unexpected_root_key: true,
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		const message = JSON.parse(raw).message as string;
		expect(message).toContain('records.0.finding_id');
		expect(message).toContain('records.0.status');
		expect(message).toContain('NOT_A_STATUS');
		expect(message).toContain('PENDING');
		expect(message).toContain('CONFIRMED');
		expect(message).toContain('records.0.next_action');
		expect(message).toContain('ship_it');
		expect(message).toContain('route_to_reviewer');
		expect(message).toContain('records.0.severity');
		expect(message).toContain('SEVERE');
		expect(message).toContain('records.0.extra_field');
		expect(message).toContain('unexpected_root_key');
	});

	test('oversized input is rejected before reserving a run or writing an artifact', async () => {
		await establishPrReviewPrerequisites(directory, 'size-safe');
		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'oversized-input',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: Array.from({ length: 160 }, (_unused, index) => ({
						...artifactRecord(
							`C-${index}`,
							'PENDING',
							'route_to_reviewer',
							'HIGH',
						),
						evidence: 'x'.repeat(20_000),
					})),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };
		expect(result.success).toBe(false);
		expect(result.message).toContain('serialized UTF-8 payload');
		await expect(
			fs.stat(`${directory}/.swarm/pr-review/oversized-input`),
		).rejects.toThrow();
	});

	test('runtime head and run conflicts name the guarded field plus expected and received values', async () => {
		await establishPrReviewPrerequisites(directory, 'bound-run');
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'bound-run',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords(),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');

		const state = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(state?.prReviewArtifactRunId).toBe('bound-run');

		const headMismatch = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'bound-run',
					pr_head_sha: 'deadbeef',
					boundary: 'post_explorer',
					records: explorerRecords(),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(headMismatch.success).toBe(false);
		expect(headMismatch.message).toContain('pr_head_sha');
		expect(headMismatch.message).toContain(HEAD_SHA);
		expect(headMismatch.message).toContain('deadbeef');

		const runMismatch = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'different-run',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords(),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(runMismatch.success).toBe(false);
		expect(runMismatch.message).toContain('run_id');
		expect(runMismatch.message).toContain('bound-run');
		expect(runMismatch.message).toContain('different-run');
	});

	test('corrupt persisted findings return a bounded read failure without overwrite', async () => {
		await establishPrReviewPrerequisites(directory, 'corrupt-findings');
		const artifactDirectory = `${directory}/.swarm/pr-review/corrupt-findings`;
		const findingsPath = `${artifactDirectory}/findings.jsonl`;
		await fs.mkdir(artifactDirectory, { recursive: true });
		await fs.writeFile(findingsPath, '{not-json}\n', 'utf8');

		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'corrupt-findings',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords(),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };
		expect(result.success).toBe(false);
		expect(result.message).toContain('operation read path');
		expect(result.message).toContain('findings.jsonl');
		expect(result.message).toContain('line 1 is not JSON');
		expect(await fs.readFile(findingsPath, 'utf8')).toBe('{not-json}\n');
	});

	test('findings write I/O failures return operation, path, expected contract, and cause', async () => {
		await establishPrReviewPrerequisites(directory, 'write-failure');
		artifactInternals.atomicWrite = async () => {
			throw new Error('injected disk denied');
		};
		const result = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'write-failure',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords(),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };
		expect(result.success).toBe(false);
		expect(result.message).toContain('operation write path');
		expect(result.message).toContain('findings.jsonl');
		expect(result.message).toContain('atomic findings checkpoint');
		expect(result.message).toContain('injected disk denied');
	});

	test('an exact findings retry is a no-op and a conflicting replay cannot mutate the boundary', async () => {
		await establishPrReviewPrerequisites(directory, 'replay-safe');
		const input = {
			kind: 'findings' as const,
			run_id: 'replay-safe',
			pr_head_sha: HEAD_SHA,
			boundary: 'post_explorer' as const,
			records: explorerRecords(),
		};
		const first = JSON.parse(
			await executeWritePrReviewArtifact(input, directory, {
				sessionID: SESSION_ID,
			}),
		) as { success: boolean; appended: number; replayed: boolean };
		expect(first).toMatchObject({
			success: true,
			appended: 6,
			replayed: false,
		});
		const findingsPath = `${directory}/.swarm/pr-review/replay-safe/findings.jsonl`;
		const original = await fs.readFile(findingsPath, 'utf8');

		const replay = JSON.parse(
			await executeWritePrReviewArtifact(input, directory, {
				sessionID: SESSION_ID,
			}),
		) as { success: boolean; appended: number; replayed: boolean };
		expect(replay).toMatchObject({
			success: true,
			appended: 0,
			replayed: true,
		});
		expect(await fs.readFile(findingsPath, 'utf8')).toBe(original);

		const conflict = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					...input,
					records: input.records.map((record, index) =>
						index === 0
							? { ...record, evidence: 'changed after commit' }
							: record,
					),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };
		expect(conflict.success).toBe(false);
		expect(conflict.message).toContain('exact replay');
		expect(await fs.readFile(findingsPath, 'utf8')).toBe(original);
	});

	test('handoff actionable-set rejections name requested and authoritative ids', async () => {
		await establishPrReviewPrerequisites(directory, 'handoff-contract');
		await expect(
			executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'handoff-contract',
					pr_head_sha: HEAD_SHA,
					boundary: 'post_explorer',
					records: explorerRecords(),
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		).resolves.toContain('"success": true');

		const handoffMismatch = JSON.parse(
			await executeWritePrReviewArtifact(
				{
					kind: 'handoff',
					run_id: 'handoff-contract',
					pr_head_sha: HEAD_SHA,
					handoff: {
						pr_url: 'https://github.com/owner/repo/pull/155',
						finding_ids: ['C-9', 'C-1'],
						summary: 'wrong set',
						provenance: ['contract-hardening'],
					},
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(handoffMismatch.success).toBe(false);
		expect(handoffMismatch.message).toContain('finding_ids');
		expect(handoffMismatch.message).toContain('requested');
		expect(handoffMismatch.message).toContain('C-9');
		expect(handoffMismatch.message).toContain('authoritative');
	});
});
