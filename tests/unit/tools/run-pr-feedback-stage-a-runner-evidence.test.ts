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

const SESSION = 'stage-a-runner-evidence-session';
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

const validChecks = [
	{ category: 'build', command: ['cargo', 'build'] },
	{ category: 'typecheck', command: ['tsc', '--noEmit'] },
	{ category: 'lint', command: ['eslint', '.'] },
	{ category: 'diff-check', command: ['git', 'diff', '--check'] },
	{
		category: 'reproduction',
		command: ['bun', 'test', 'tests/targeted-regression.test.ts'],
		targets: ['tests/targeted-regression.test.ts'],
		feedback_targets: [
			{
				feedback_item_id: 'FB-001',
				target: 'tests/targeted-regression.test.ts',
				expected_behavior: 'targeted regression passes after the feedback fix',
				proof_kind: 'defect',
			},
		],
	},
] as const;

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'feedback-stage-a-runner-')),
	);
	await fs.mkdir(path.join(directory, 'tests'), { recursive: true });
	await fs.writeFile(
		path.join(directory, 'tests', 'targeted-regression.test.ts'),
		'// Stage A target fixture\n',
		'utf8',
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
describe('run_pr_feedback_stage_a runner evidence', () => {
	test('executes a contained standard Gradle wrapper', async () => {
		await Promise.all([
			fs.writeFile(path.join(directory, 'build.gradle'), 'plugins {}\n'),
			fs.writeFile(path.join(directory, 'gradlew'), '#!/bin/sh\n'),
		]);
		const obligation = _internals
			.discoverApplicableStageAObligations(directory)
			.find(({ source }) => source === 'build.gradle');
		expect(obligation).toBeDefined();
		const checks = validChecks.map((check) =>
			check.category === 'build'
				? {
						...check,
						command: ['./gradlew', 'build'],
						obligation_id: obligation!.id,
					}
				: check,
		);
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(true);
	});

	test('requires every concrete build obligation in a polyglot workspace', async () => {
		await fs.mkdir(path.join(directory, 'packages', 'web'), {
			recursive: true,
		});
		await Promise.all([
			fs.writeFile(
				path.join(directory, 'Cargo.toml'),
				'[package]\nname="api"\n',
			),
			fs.writeFile(
				path.join(directory, 'packages', 'web', 'package.json'),
				JSON.stringify({ scripts: { build: 'vite build' } }),
				'utf8',
			),
		]);
		const obligations =
			_internals.discoverApplicableStageAObligations(directory);
		const cargo = obligations.find(({ source }) => source === 'Cargo.toml')!;
		const web = obligations.find(
			({ source }) => source === 'package.json#build',
		)!;
		const partialChecks = validChecks.map((check) =>
			check.category === 'build'
				? { ...check, obligation_id: cargo.id }
				: check,
		);
		const partial = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: partialChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(partial.success).toBe(false);
		expect(partial.message).toContain(web.id);

		const completeChecks = [
			...partialChecks,
			{
				category: 'build',
				command: ['vite', 'build'],
				working_directory: 'packages/web',
				obligation_id: web.id,
			},
		];
		const complete = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: completeChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(complete.success).toBe(true);
		expect(_internals.runExternalTool).toHaveBeenCalledTimes(6);
	});

	test('accepts an exact safe validator from a bounded repository contract', async () => {
		const contractText = JSON.stringify({
			version: 1,
			validators: [
				{
					id: 'custom-build',
					category: 'build',
					working_directory: '.',
					command: ['acme-validator', 'verify-build'],
				},
			],
		});
		baseContracts.set('.pr-validation.json', contractText);
		await fs.writeFile(
			path.join(directory, '.pr-validation.json'),
			contractText,
			'utf8',
		);
		const obligation = _internals
			.discoverApplicableStageAObligations(directory, {
				baseRef: 'origin/main',
				baseSha: BASE,
			})
			.find(({ source }) => source === '.pr-validation.json#custom-build')!;
		const checks = validChecks.map((check) =>
			check.category === 'build'
				? {
						...check,
						command: ['acme-validator', 'verify-build'],
						obligation_id: obligation.id,
						validator_contract: {
							path: '.pr-validation.json',
							id: 'custom-build',
						},
					}
				: check,
		);
		const unboundChecks = checks.map((check) =>
			check.category === 'build'
				? {
						category: check.category,
						command: check.command,
						obligation_id: check.obligation_id,
					}
				: check,
		);
		const unbound = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					base_ref: 'origin/main',
					base_sha: BASE,
					checks: unboundChecks,
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(unbound.success).toBe(false);
		expect(unbound.message).toContain('exact source obligation');

		_internals.runExternalTool = mock(async ({ executable }) => ({
			status: 'completed' as const,
			exitCode: 0,
			stdout: executable === 'acme-validator' ? '' : 'ok',
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
					checks,
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
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					base_ref: 'origin/main',
					base_sha: BASE,
					checks,
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(true);
	});

	test('rejects a complete npm --if-present validation-theater batch', async () => {
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					checks: [
						{
							category: 'build',
							command: ['npm', 'run', 'build-does-not-exist', '--if-present'],
						},
						{
							category: 'typecheck',
							command: [
								'npm',
								'run',
								'typecheck-does-not-exist',
								'--if-present',
							],
						},
						{
							category: 'lint',
							command: ['npm', 'run', 'lint-does-not-exist', '--if-present'],
						},
						{ category: 'diff-check', command: ['git', 'diff', '--check'] },
						{
							category: 'reproduction',
							command: [
								'npm',
								'run',
								'test-does-not-exist',
								'--if-present',
								'--',
								'tests/targeted-regression.test.ts',
							],
							targets: ['tests/targeted-regression.test.ts'],
							feedback_targets: validChecks[4].feedback_targets,
						},
					],
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('not a recognized non-publishing');
		expect(_internals.runExternalTool).not.toHaveBeenCalled();
	});
});
