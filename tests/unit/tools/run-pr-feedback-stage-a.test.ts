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
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import {
	_internals,
	executeRunPrFeedbackStageA,
} from '../../../src/tools/run-pr-feedback-stage-a.js';
import { TOOL_NAMES } from '../../../src/tools/tool-names.js';

const SESSION = 'stage-a-session';
const HEAD = 'abc123';
const REVISION = 'revision-1';
let directory = '';
const originalRunner = _internals.runExternalTool;
const originalDigest = _internals.resolvePrWorkflowRevisionDigest;
const originalStageHead = _internals.resolveCurrentGitHead;
const originalControlDigest = _internals.resolveGitControlStateDigest;
const originalGateDigest = gateInternals.resolvePrWorkflowRevisionDigest;
const originalHead = gateInternals.resolveCurrentGitHead;

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'feedback-stage-a-')),
	);
	await fs.mkdir(path.join(directory, 'tests'), { recursive: true });
	await fs.writeFile(
		path.join(directory, 'tests', 'targeted-regression.test.ts'),
		'// Stage A target fixture\n',
		'utf8',
	);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION;
	_internals.resolvePrWorkflowRevisionDigest = () => REVISION;
	_internals.resolveCurrentGitHead = () => HEAD;
	_internals.resolveGitControlStateDigest = () => 'git-control-1';
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
	_internals.resolvePrWorkflowRevisionDigest = originalDigest;
	_internals.resolveCurrentGitHead = originalStageHead;
	_internals.resolveGitControlStateDigest = originalControlDigest;
	gateInternals.resolvePrWorkflowRevisionDigest = originalGateDigest;
	gateInternals.resolveCurrentGitHead = originalHead;
	gateInternals.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

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
			},
		],
	},
] as const;

describe('run_pr_feedback_stage_a', () => {
	test('is registered only for the architect', () => {
		expect(TOOL_NAMES).toContain('run_pr_feedback_stage_a');
		expect(TOOL_MANIFEST.run_pr_feedback_stage_a).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('run_pr_feedback_stage_a');
		expect(AGENT_TOOL_MAP.explorer).not.toContain('run_pr_feedback_stage_a');
	});

	test('executes every mandatory category and persists a revision-bound receipt', async () => {
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: validChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result).toMatchObject({ success: true });
		expect(_internals.runExternalTool).toHaveBeenCalledTimes(5);
		expect(
			(await readPrWorkflowGateState(directory, SESSION))?.prFeedbackStageA,
		).toMatchObject({ revisionDigest: REVISION });
	});

	test('accepts only diff-check and reproduction when no optional category is mechanically applicable', async () => {
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					checks: validChecks.filter((check) =>
						['diff-check', 'reproduction'].includes(check.category),
					),
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result).toMatchObject({ success: true });
		expect(_internals.runExternalTool).toHaveBeenCalledTimes(2);
	});

	test('fails closed when a discovered applicable category is omitted', async () => {
		await fs.writeFile(
			path.join(directory, 'package.json'),
			JSON.stringify({ scripts: { lint: 'eslint .' } }),
			'utf8',
		);
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					checks: validChecks.filter((check) =>
						['diff-check', 'reproduction'].includes(check.category),
					),
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('lint');
		expect(_internals.runExternalTool).not.toHaveBeenCalled();
	});

	test('rejects category labels that do not execute the exact diff check', async () => {
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{
					pr_head_sha: HEAD,
					checks: validChecks.map((check) =>
						check.category === 'diff-check'
							? { ...check, command: ['echo', 'clean'] }
							: check,
					),
				},
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('git');
		expect(_internals.runExternalTool).not.toHaveBeenCalled();
	});

	test('rejects mutating, publishing, wrapped, and no-op category commands', async () => {
		for (const [category, command] of [
			['build', ['git', 'commit', '-m', 'bypass']],
			['build', ['npm', 'run', 'publish']],
			['lint', ['true']],
			['reproduction', ['node', '-e', 'process.exit(0)']],
			[
				'reproduction',
				['scripts/test.sh', 'tests/targeted-regression.test.ts'],
			],
			[
				'reproduction',
				[
					'go',
					'test',
					'-c',
					'-o',
					'.cache/pkg.test',
					'tests/targeted-regression.test.ts',
				],
			],
		] as const) {
			const checks = validChecks.map((check) =>
				check.category === category ? { ...check, command } : check,
			);
			const result = JSON.parse(
				await executeRunPrFeedbackStageA(
					{ pr_head_sha: HEAD, checks },
					directory,
					{ sessionID: SESSION },
				),
			);
			expect(result.success).toBe(false);
			expect(result.message).toContain('not a recognized non-publishing');
		}
		expect(_internals.runExternalTool).not.toHaveBeenCalled();
	});

	test('rejects package-script name theater and empty reproduction evidence', async () => {
		await fs.writeFile(
			path.join(directory, 'package.json'),
			JSON.stringify({ scripts: { build: 'echo not-a-build' } }),
			'utf8',
		);
		const packageChecks = validChecks.map((check) =>
			check.category === 'build'
				? { ...check, command: ['npm', 'run', 'build'] }
				: check,
		);
		const packageResult = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: packageChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(packageResult.success).toBe(false);
		expect(_internals.runExternalTool).not.toHaveBeenCalled();

		await fs.rm(path.join(directory, 'package.json'));
		_internals.runExternalTool = mock(async ({ executable }) => ({
			status: 'completed' as const,
			exitCode: 0,
			stdout: executable === 'bun' ? '' : 'ok',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		}));
		const emptyResult = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: validChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(emptyResult.success).toBe(false);
		expect(emptyResult.message).toContain('no machine-observable');
	});

	test('rejects selector-free or nonexistent reproduction targets', async () => {
		const reproduction = validChecks.find(
			(check) => check.category === 'reproduction',
		)!;
		for (const replacement of [
			{ ...reproduction, targets: undefined },
			{
				...reproduction,
				command: [
					'bun',
					'test',
					'tests/targeted-regression.test.ts',
					'--test-name-pattern',
					'is registered only',
				],
				targets: ['test'],
			},
			{
				...reproduction,
				command: ['bun', 'test', 'tests/missing.test.ts'],
				targets: ['tests/missing.test.ts'],
			},
		]) {
			const checks = validChecks.map((check) =>
				check.category === 'reproduction' ? replacement : check,
			);
			const result = JSON.parse(
				await executeRunPrFeedbackStageA(
					{ pr_head_sha: HEAD, checks },
					directory,
					{ sessionID: SESSION },
				),
			);
			expect(result.success).toBe(false);
		}
	});

	test('rejects reproduction mappings unrelated to the immutable feedback inventory', async () => {
		const checks = validChecks.map((check) =>
			check.category === 'reproduction'
				? {
						...check,
						feedback_targets: [
							{
								feedback_item_id: 'FB-999',
								target: 'tests/targeted-regression.test.ts',
								expected_behavior: 'unrelated test passes after some other fix',
							},
						],
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
		expect(result.success).toBe(false);
		expect(result.message).toContain('every immutable feedback item');
		expect(_internals.runExternalTool).not.toHaveBeenCalled();
	});

	test('rejects HEAD, ref, config, or index mutation during any command', async () => {
		let controlCalls = 0;
		_internals.resolveGitControlStateDigest = () =>
			++controlCalls <= 2 ? 'git-control-1' : 'git-control-2';
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: validChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('mutated content, HEAD, refs, Git config');
	});

	test('does not record Stage A when the revision changes during execution', async () => {
		let calls = 0;
		_internals.resolvePrWorkflowRevisionDigest = () =>
			++calls === 1 ? REVISION : 'revision-2';
		const result = JSON.parse(
			await executeRunPrFeedbackStageA(
				{ pr_head_sha: HEAD, checks: validChecks },
				directory,
				{ sessionID: SESSION },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('Stage A');
		expect(
			(await readPrWorkflowGateState(directory, SESSION))?.prFeedbackStageA,
		).toBeUndefined();
	});
});
