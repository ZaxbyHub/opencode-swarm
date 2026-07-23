import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeRunPrFeedbackStageA,
} from '../../../src/tools/run-pr-feedback-stage-a.js';

const SESSION = 'stage-a-contract-authorization';
const HEAD = 'abc123';
const BASE = 'def456';
const REVISION = 'revision-1';
let directory = '';
let baseContracts = new Map<string, string>();
const originalRunner = _internals.runExternalTool;
const originalReadGitTextAtRevision = _internals.readGitTextAtRevision;
const originalResolveExactMergeBase = _internals.resolveExactMergeBase;
const originalResolveExactMergeBaseAsync =
	_internals.resolveExactMergeBaseAsync;
const originalDigest = _internals.resolvePrWorkflowRevisionDigest;
const originalDigestAsync = _internals.resolvePrWorkflowRevisionDigestAsync;
const originalStageHead = _internals.resolveCurrentGitHead;
const originalStageHeadAsync = _internals.resolveCurrentGitHeadAsync;
const originalControlDigest = _internals.resolveGitControlStateDigest;
const originalControlDigestAsync = _internals.resolveGitControlStateDigestAsync;
const originalGateDigest = gateInternals.resolvePrWorkflowRevisionDigest;
const originalHead = gateInternals.resolveCurrentGitHead;
const originalHeadAsync = gateInternals.resolveCurrentGitHeadAsync;
const originalWorkingTreeClean = gateInternals.resolveIsWorkingTreeClean;
const originalWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalUpstreamPushTarget =
	gateInternals.resolveCurrentUpstreamPushTarget;
const originalUpstreamPushTargetAsync =
	gateInternals.resolveCurrentUpstreamPushTargetAsync;
const originalRemoteRefsContainingHead =
	gateInternals.resolveRemoteRefsContainingHead;
const originalRemoteRefsContainingHeadAsync =
	gateInternals.resolveRemoteRefsContainingHeadAsync;

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'feedback-stage-a-contract-')),
	);
	await fs.mkdir(path.join(directory, 'tests'), { recursive: true });
	await fs.writeFile(
		path.join(directory, 'tests', 'targeted-regression.test.ts'),
		'// target\n',
	);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-feedback-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-feedback-head',
	});
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async (dir) =>
		gateInternals.resolveCurrentUpstreamPushTarget(dir);
	gateInternals.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-feedback-head',
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async (dir, head) =>
		gateInternals.resolveRemoteRefsContainingHead(dir, head);
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION;
	_internals.resolvePrWorkflowRevisionDigest = () => REVISION;
	_internals.resolvePrWorkflowRevisionDigestAsync = async (...a) =>
		_internals.resolvePrWorkflowRevisionDigest(...a);
	_internals.resolveCurrentGitHead = () => HEAD;
	_internals.resolveCurrentGitHeadAsync = async (dir) =>
		_internals.resolveCurrentGitHead(dir);
	_internals.resolveGitControlStateDigest = () => 'git-control-1';
	_internals.resolveGitControlStateDigestAsync = async (dir) =>
		_internals.resolveGitControlStateDigest(dir);
	baseContracts = new Map();
	_internals.resolveExactMergeBase = () => BASE;
	_internals.resolveExactMergeBaseAsync = async (...a) =>
		_internals.resolveExactMergeBase(...a);
	_internals.readGitTextAtRevision = (_directory, sha, contractPath) =>
		sha === BASE ? (baseContracts.get(contractPath) ?? null) : null;
	_internals.runExternalTool = mock(async () => ({
		status: 'completed' as const,
		exitCode: 0,
		stdout: 'ok',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
	}));
	await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(directory, SESSION, ['FB-001'], {
		prHeadSha: HEAD,
	});
	await enforcePrFeedbackVerificationOwnership(
		directory,
		SESSION,
		[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
		{ batchId: 'verify-batch', prHeadSha: HEAD },
	);
	const text = '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence';
	await recordPendingDelegation(directory, {
		correlationId: 'verify-lane',
		jobId: null,
		subagentSessionId: 'verify-lane',
		parentSessionId: SESSION,
		callID: 'verify-batch',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'verify-batch',
		laneId: 'verify',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		workspace: {
			directory,
			gitHead: HEAD,
			dirtyHash: REVISION,
			prHeadSha: HEAD,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: 'verify-batch',
		laneId: 'verify',
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: 'verify-lane',
		parentSessionId: SESSION,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		prHeadSha: HEAD,
		gitHead: HEAD,
		revisionDigest: REVISION,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, 'verify-lane', {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
});

afterEach(async () => {
	_internals.runExternalTool = originalRunner;
	_internals.readGitTextAtRevision = originalReadGitTextAtRevision;
	_internals.resolveExactMergeBase = originalResolveExactMergeBase;
	_internals.resolveExactMergeBaseAsync = originalResolveExactMergeBaseAsync;
	_internals.resolvePrWorkflowRevisionDigest = originalDigest;
	_internals.resolvePrWorkflowRevisionDigestAsync = originalDigestAsync;
	_internals.resolveCurrentGitHead = originalStageHead;
	_internals.resolveCurrentGitHeadAsync = originalStageHeadAsync;
	_internals.resolveGitControlStateDigest = originalControlDigest;
	_internals.resolveGitControlStateDigestAsync = originalControlDigestAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalGateDigest;
	gateInternals.resolveCurrentGitHead = originalHead;
	gateInternals.resolveCurrentGitHeadAsync = originalHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync = originalWorkingTreeCleanAsync;
	gateInternals.resolveCurrentUpstreamPushTarget = originalUpstreamPushTarget;
	gateInternals.resolveCurrentUpstreamPushTargetAsync =
		originalUpstreamPushTargetAsync;
	gateInternals.resolveRemoteRefsContainingHead =
		originalRemoteRefsContainingHead;
	gateInternals.resolveRemoteRefsContainingHeadAsync =
		originalRemoteRefsContainingHeadAsync;
	gateInternals.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('Stage A coalesced validator contract authorization', () => {
	test('requires exact contract provenance and non-empty execution evidence', async () => {
		const validatorContract = {
			path: '.pr-validation.json',
			id: 'custom-build',
		};
		const contractText = JSON.stringify({
			version: 1,
			validators: [
				{
					id: validatorContract.id,
					category: 'build',
					working_directory: '.',
					command: ['acme-validator', 'verify-build'],
				},
			],
		});
		baseContracts.set(validatorContract.path, contractText);
		await Promise.all([
			fs.writeFile(
				path.join(directory, 'package.json'),
				JSON.stringify({ scripts: { build: 'acme-validator verify-build' } }),
			),
			fs.writeFile(path.join(directory, validatorContract.path), contractText),
		]);
		const build = _internals
			.discoverApplicableStageAObligations(directory, {
				baseRef: 'origin/main',
				baseSha: BASE,
			})
			.find(({ category }) => category === 'build')!;
		expect(build).toMatchObject({
			source: 'package.json#build',
			validatorContract,
		});
		const baseChecks = [
			{
				category: 'build',
				command: ['npm', 'run', 'build'],
				obligation_id: build.id,
			},
			{ category: 'diff-check', command: ['git', 'diff', '--check'] },
			{
				category: 'reproduction',
				command: ['bun', 'test', 'tests/targeted-regression.test.ts'],
				targets: ['tests/targeted-regression.test.ts'],
				feedback_targets: [
					{
						feedback_item_id: 'FB-001',
						target: 'tests/targeted-regression.test.ts',
						expected_behavior: 'targeted regression proves the fixed behavior',
					},
				],
			},
		];
		for (const reference of [
			undefined,
			{ path: '.pr-validation.json', id: 'wrong-validator' },
		]) {
			const rejected = JSON.parse(
				await executeRunPrFeedbackStageA(
					{
						pr_head_sha: HEAD,
						base_ref: 'origin/main',
						base_sha: BASE,
						checks: baseChecks.map((check) =>
							check.category === 'build'
								? { ...check, validator_contract: reference }
								: check,
						),
					},
					directory,
					{ sessionID: SESSION },
				),
			);
			expect(rejected.success).toBe(false);
			expect(rejected.message).toContain('requires exact validator_contract');
		}
		const authorizedChecks = baseChecks.map((check) =>
			check.category === 'build'
				? { ...check, validator_contract: validatorContract }
				: check,
		);
		_internals.runExternalTool = mock(async ({ executable }) => ({
			status: 'completed' as const,
			exitCode: 0,
			stdout: executable === 'npm' ? '' : 'ok',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		}));
		const empty = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					base_ref: 'origin/main',
					base_sha: BASE,
					checks: authorizedChecks,
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(empty.success).toBe(false);
		expect(empty.message).toContain('no machine-observable evidence');
		_internals.runExternalTool = mock(async () => ({
			status: 'completed' as const,
			exitCode: 0,
			stdout: 'ok',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		}));
		const accepted = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					base_ref: 'origin/main',
					base_sha: BASE,
					checks: authorizedChecks,
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(accepted.success).toBe(true);
		expect(
			(await readPrWorkflowGateState(directory, SESSION))?.prFeedbackStageA
				?.checks[0].validatorContract,
		).toEqual(validatorContract);
	});

	test('executes targeted npm and pnpm reproduction through inspected scripts', async () => {
		await fs.writeFile(
			path.join(directory, 'package.json'),
			JSON.stringify({ scripts: { test: 'bun test' } }),
		);
		for (const command of [
			['npm', 'run', 'test', '--', 'tests/targeted-regression.test.ts'],
			['pnpm', 'test', 'tests/targeted-regression.test.ts'],
		]) {
			const result = JSON.parse(
				await executeRunPrFeedbackStageA(
					{
						pr_head_sha: HEAD,
						checks: [
							{ category: 'diff-check', command: ['git', 'diff', '--check'] },
							{
								category: 'reproduction',
								command,
								targets: ['tests/targeted-regression.test.ts'],
								feedback_targets: [
									{
										feedback_item_id: 'FB-001',
										target: 'tests/targeted-regression.test.ts',
										expected_behavior:
											'targeted package-manager regression proves the fix',
									},
								],
							},
						],
					},
					directory,
					{ sessionID: SESSION },
				),
			);
			expect(result.success).toBe(true);
		}
	});

	test('rejects a contract added or changed by the PR tree before any validator can run', async () => {
		const baseContract = JSON.stringify({
			version: 1,
			validators: [
				{
					id: 'trusted-build',
					category: 'build',
					working_directory: '.',
					command: ['trusted-validator', 'build'],
				},
			],
		});
		baseContracts.set('.pr-validation.json', baseContract);
		await fs.writeFile(
			path.join(directory, '.pr-validation.json'),
			JSON.stringify({
				version: 1,
				validators: [
					{
						id: 'pr-added-validator',
						category: 'build',
						working_directory: '.',
						command: ['untrusted-validator', 'build'],
					},
				],
			}),
		);

		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					base_ref: 'origin/main',
					base_sha: BASE,
					checks: [
						{
							category: 'diff-check',
							command: ['git', 'diff', '--check'],
						},
						{
							category: 'reproduction',
							command: ['bun', 'test', 'tests/targeted-regression.test.ts'],
							targets: ['tests/targeted-regression.test.ts'],
							feedback_targets: [
								{
									feedback_item_id: 'FB-001',
									target: 'tests/targeted-regression.test.ts',
									expected_behavior:
										'targeted regression proves the blocked contract does not execute',
								},
							],
						},
					],
				},
				directory,
				{ sessionID: SESSION },
			),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'must be unchanged from the immutable merge base',
		);
		expect(_internals.runExternalTool).not.toHaveBeenCalled();
	});

	test('fails closed for an opaque named script unless a base-identical contract replaces it', async () => {
		await fs.writeFile(
			path.join(directory, 'package.json'),
			JSON.stringify({ scripts: { build: 'custom-build && echo done' } }),
		);
		expect(() =>
			_internals.discoverApplicableStageAObligations(directory),
		).toThrow('opaque package script');

		const contractText = JSON.stringify({
			version: 1,
			validators: [
				{
					id: 'trusted-build',
					category: 'build',
					working_directory: '.',
					command: ['trusted-validator', 'build'],
				},
			],
		});
		baseContracts.set('.pr-validation.json', contractText);
		await fs.writeFile(
			path.join(directory, '.pr-validation.json'),
			contractText,
		);

		const obligations = _internals.discoverApplicableStageAObligations(
			directory,
			{ baseRef: 'origin/main', baseSha: BASE },
		);
		expect(obligations).toContainEqual({
			id: 'build:.:.pr-validation.json#trusted-build',
			category: 'build',
			workingDirectory: '.',
			source: '.pr-validation.json#trusted-build',
		});
	});
});
