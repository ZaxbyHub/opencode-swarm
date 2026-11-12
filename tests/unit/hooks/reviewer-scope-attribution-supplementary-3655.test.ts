/**
 * Issue #3655 supplementary coverage (plan Revision 4, plan-critic blockers 5/6/7).
 *
 * GREEN after the fix; companion to the frozen acceptance file
 * (reviewer-scope-committed-attribution-3655.test.ts) — that file owns the
 * RED-at-base discrimination; this one pins the residual contracts the critic
 * required: runtime-path filtering on the no-change verdict, the
 * scope-local truthful NO_CHANGE wording, degraded reconciliation never
 * becoming no_change, typed collecting-state denials (transient vs permanent
 * capture failures), the terminal retryable=false genuine-drift pin, and the
 * channel-A settlement-attribution input.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { changedFilesSinceSnapshotAsync } from '../../../src/background/workspace-snapshot';
import {
	captureReviewerScopeFileFingerprint,
	reviewerScopeCaptureToFingerprint,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import {
	getReviewerScopeGenerationForCoderCall,
	recordReviewerScopeGenerationCaptureFailure,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TASK_ID = '3.1';
const DECLARED_FILE = 'docs/declared.md';
const CODER_PROMPT = `TASK: ${TASK_ID}\nWrite ${DECLARED_FILE}.`;
const SUCCESS_OUTPUT = { status: 'completed', output: 'done' };

let directory = '';

function git(args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
}

async function beginCoder(callID: string): Promise<unknown> {
	startAgentSession(`child-${callID}`, 'coder', directory);
	installActiveScopeBinding({
		directory,
		childSessionId: `child-${callID}`,
		parentSessionId: 'parent',
		dispatchCallId: callID,
		taskId: TASK_ID,
		files: [DECLARED_FILE],
	});
	return beginApprovedReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: { subagent_type: 'coder', prompt: CODER_PROMPT },
		parentSessionID: 'parent',
		callID,
	});
}

async function completeCoder(callID: string): Promise<unknown> {
	return completeReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: { subagent_type: 'coder', prompt: CODER_PROMPT },
		output: SUCCESS_OUTPUT,
		parentSessionID: 'parent',
		callID,
	});
}

async function dispatchReviewer(
	callID: string,
): Promise<{ threw: boolean; message: string }> {
	try {
		await beginApprovedReviewerScopeLifecycle({
			directory,
			tool: 'Task',
			args: { subagent_type: 'reviewer', prompt: `TASK: ${TASK_ID}\nReview.` },
			parentSessionID: 'parent',
			callID,
			maxBytes: 1024 * 1024,
		});
		return { threw: false, message: '' };
	} catch (error) {
		return {
			threw: true,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function generationFor(callID: string) {
	return getReviewerScopeGenerationForCoderCall({
		parentSessionID: 'parent',
		taskId: TASK_ID,
		coderCallID: callID,
	});
}

beforeEach(() => {
	resetSwarmState();
	directory = canonicalMkdtemp('reviewer-scope-supplementary-3655-');
	fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
	fs.writeFileSync(path.join(directory, 'README.md'), 'baseline\n');
	git(['init']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test']);
	git(['add', 'README.md']);
	git(['commit', '-m', 'baseline']);
	// NOTE: no `.swarm/` exclusion on purpose — the runtime-filter leg needs
	// plugin-owned paths VISIBLE to `git status --porcelain`.
	startAgentSession('parent', 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	safeRmRecursive(directory);
});

describe('reviewer scope attribution supplementary (issue #3655)', () => {
	test('unexcluded .swarm runtime dirt does not flip a no-change completion', async () => {
		await beginCoder('c-runtime');
		// Runtime paths visible to porcelain (no info/exclude entry in this
		// fixture) must not count as dirt on the no-change verdict.
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(directory, '.swarm/events.jsonl'), '{}\n');
		await completeCoder('c-runtime');
		expect(generationFor('c-runtime')?.status).toBe('no_change');
		const denial = await dispatchReviewer('r-runtime');
		expect(denial.message).toContain('REVIEWER_SCOPE_NO_CHANGE');
	}, 60_000);

	test('out-of-scope committed change yields truthful scope-local no-change', async () => {
		await beginCoder('c-oos');
		fs.writeFileSync(path.join(directory, 'UNRELATED.md'), 'other task\n');
		git(['add', 'UNRELATED.md']);
		git(['commit', '-m', 'unrelated change']);
		await completeCoder('c-oos');
		expect(generationFor('c-oos')?.status).toBe('no_change');
		const denial = await dispatchReviewer('r-oos');
		expect(denial.message).toContain('REVIEWER_SCOPE_NO_CHANGE');
		// Scope-local truth: the denial must not claim a globally empty diff.
		expect(denial.message).toContain('within the declared reviewer scope');
		expect(denial.message).not.toContain('the workspace diff is empty');
	}, 60_000);

	test('non-git workspace degrades to a typed denial, never no-change', async () => {
		// Rebuild the fixture as a plain (non-git) directory.
		safeRmRecursive(directory);
		directory = canonicalMkdtemp('reviewer-scope-supplementary-nogit-');
		startAgentSession('parent', 'architect', directory);
		await beginCoder('c-nogit');
		fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
		fs.writeFileSync(path.join(directory, DECLARED_FILE), 'content\n');
		await completeCoder('c-nogit');
		// Degraded reconciliation retains collecting; dispatch is typed retryable.
		expect(generationFor('c-nogit')?.status).toBe('collecting');
		// PR #3668 feedback FB-009: the degraded advisory itself is asserted.
		const advisoryText = (
			swarmState.agentSessions.get('parent')?.pendingAdvisoryMessages ?? []
		).join('\n');
		expect(advisoryText).toContain('REVIEWER_ATTRIBUTION_DEGRADED');
		expect(advisoryText).toContain('ACTION[architect]');
		const denial = await dispatchReviewer('r-nogit');
		expect(denial.message).toContain('REVIEWER_ATTRIBUTION_EMPTY');
		expect(denial.message).toContain('retryable=true');
	}, 60_000);

	test('null dispatch head on a git workspace degrades, never no-change', async () => {
		// Direct generation construction (the v2-suite state pattern) with a
		// null dispatch head on a CLEAN git workspace: the only shape that
		// distinguishes degraded from proved-empty, because verifyWorkingTreeClean
		// would otherwise happily report clean and misclassify as no_change.
		const child = 'child-nullhead';
		startAgentSession(child, 'coder', directory);
		installActiveScopeBinding({
			directory,
			childSessionId: child,
			parentSessionId: 'parent',
			dispatchCallId: 'c-nullhead',
			taskId: TASK_ID,
			files: [DECLARED_FILE],
		});
		expect(
			startReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: TASK_ID,
				coderCallID: 'c-nullhead',
				declaredFiles: [DECLARED_FILE],
				captureDirectory: directory,
				workspaceIdentity: directory,
				dispatchGitHead: null,
			}),
		).not.toBeNull();
		await completeCoder('c-nullhead');
		expect(generationFor('c-nullhead')?.status).toBe('collecting');
		const denial = await dispatchReviewer('r-nullhead');
		expect(denial.message).toContain('REVIEWER_ATTRIBUTION_EMPTY');
		expect(denial.message).toContain('retryable=true');
	}, 60_000);

	test('tracked .swarm runtime modification does not flip a no-change completion', async () => {
		// The porcelain line for a tracked runtime file is " M .swarm/..." —
		// the leading-space X column must survive parsing so the runtime filter
		// sees the real path (implementation-review round 1, finding 1).
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(directory, '.swarm/events.jsonl'), '{}\n');
		git(['add', '-f', '.swarm/events.jsonl']);
		git(['commit', '-m', 'track swarm runtime file']);
		await beginCoder('c-tracked');
		// Modify the tracked runtime file in the worktree (no commit).
		fs.appendFileSync(path.join(directory, '.swarm/events.jsonl'), '{}\n');
		await completeCoder('c-tracked');
		expect(generationFor('c-tracked')?.status).toBe('no_change');
		const trackedDenial = await dispatchReviewer('r-tracked');
		expect(trackedDenial.message).toContain('REVIEWER_SCOPE_NO_CHANGE');
	}, 60_000);

	test('one-character-prefix non-runtime dirt stays dirty, never false clean', async () => {
		// " M a.swarm/config.json" must parse to a.swarm/config.json (dirt),
		// not .swarm/config.json (filtered runtime) — the fail-open shape from
		// implementation-review round 1, finding 1. The file is TRACKED and
		// modified in the worktree so the porcelain line carries the " M"
		// worktree-status shape (review round-2 LOW correction).
		fs.mkdirSync(path.join(directory, 'a.swarm'), { recursive: true });
		fs.writeFileSync(path.join(directory, 'a.swarm/config.json'), '{}\n');
		git(['add', '-f', 'a.swarm/config.json']);
		git(['commit', '-m', 'track one-char-prefix dir']);
		await beginCoder('c-prefix');
		fs.appendFileSync(path.join(directory, 'a.swarm/config.json'), '{}\n');
		await completeCoder('c-prefix');
		// Non-runtime tracked dirt: stranded collecting, typed denial.
		expect(generationFor('c-prefix')?.status).toBe('collecting');
		const prefixDenial = await dispatchReviewer('r-prefix');
		expect(prefixDenial.message).toContain('REVIEWER_ATTRIBUTION_EMPTY');
		expect(prefixDenial.message).not.toContain('REVIEWER_SCOPE_NO_CHANGE');
	}, 60_000);

	test('failed committed diff degrades to a typed denial, never no-change', async () => {
		// Resolvable current head but a dispatch head that cannot be diffed
		// (nonexistent object): committedFilesBetweenAsync returns null and
		// completion must classify degraded, not proved-empty (plan-mandated
		// diff-failure leg; implementation-review round 1, finding 3).
		const childBadDiff = 'child-baddiff';
		startAgentSession(childBadDiff, 'coder', directory);
		installActiveScopeBinding({
			directory,
			childSessionId: childBadDiff,
			parentSessionId: 'parent',
			dispatchCallId: 'c-baddiff',
			taskId: TASK_ID,
			files: [DECLARED_FILE],
		});
		expect(
			startReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: TASK_ID,
				coderCallID: 'c-baddiff',
				declaredFiles: [DECLARED_FILE],
				captureDirectory: directory,
				workspaceIdentity: directory,
				dispatchGitHead: '0000000000000000000000000000000000000000',
			}),
		).not.toBeNull();
		await completeCoder('c-baddiff');
		expect(generationFor('c-baddiff')?.status).toBe('collecting');
		const badDiffDenial = await dispatchReviewer('r-baddiff');
		expect(badDiffDenial.message).toContain('REVIEWER_ATTRIBUTION_EMPTY');
		expect(badDiffDenial.message).toContain('retryable=true');
	}, 60_000);

	test('routed file without fingerprint gets retryable capture-incomplete denial', async () => {
		await beginCoder('c-incomplete');
		fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
		fs.writeFileSync(path.join(directory, DECLARED_FILE), 'content\n');
		// Routing without fingerprint completion (the v2-suite state pattern).
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: TASK_ID,
				coderCallID: 'c-incomplete',
				file: DECLARED_FILE,
			}),
		).toBe(true);
		await completeCoder('c-incomplete');
		expect(generationFor('c-incomplete')?.status).toBe('collecting');
		const denial = await dispatchReviewer('r-incomplete');
		expect(denial.message).toContain('REVIEWER_CAPTURE_INCOMPLETE');
		expect(denial.message).toContain('retryable=true');
	}, 60_000);

	test('permanent capture failure keeps its code and coder-recapture action', async () => {
		await beginCoder('c-permanent');
		fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
		fs.writeFileSync(path.join(directory, DECLARED_FILE), 'content\n');
		recordReviewerScopeGenerationFile({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-permanent',
			file: DECLARED_FILE,
		});
		recordReviewerScopeGenerationCaptureFailure({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-permanent',
			file: DECLARED_FILE,
			code: 'workspace_mismatch',
			retryable: false,
		});
		await completeCoder('c-permanent');
		const denial = await dispatchReviewer('r-permanent');
		expect(denial.message).toContain('REVIEWER_CAPTURE_FAILED');
		expect(denial.message).toContain('retryable=false');
		// Status-appropriate recovery: re-dispatch the CODER so completion
		// recaptures — a reviewer re-dispatch alone cannot fill the gap.
		expect(denial.message).toContain('re-dispatch the coder');
	}, 60_000);

	test('genuine drift on a ready generation stays terminal retryable=false', async () => {
		await beginCoder('c-drift');
		fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
		fs.writeFileSync(path.join(directory, DECLARED_FILE), 'v1\n');
		recordReviewerScopeGenerationFile({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-drift',
			file: DECLARED_FILE,
		});
		const capture = captureReviewerScopeFileFingerprint(
			directory,
			DECLARED_FILE,
		);
		if (capture.kind === 'capture_failed') {
			throw new Error(`fixture capture failed: ${capture.code}`);
		}
		const fingerprint = reviewerScopeCaptureToFingerprint(capture);
		expect(fingerprint).not.toBeNull();
		recordReviewerScopeGenerationFileFingerprint({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-drift',
			fingerprint: fingerprint!,
		});
		await completeCoder('c-drift');
		expect(generationFor('c-drift')?.status).toBe('ready');
		// Post-capture mutation = genuine drift; the denial is terminal.
		fs.appendFileSync(path.join(directory, DECLARED_FILE), 'v2 bytes\n');
		const denial = await dispatchReviewer('r-drift');
		expect(denial.message).toContain('REVIEWER_SCOPE_STALE');
		expect(denial.message).toContain('retryable=false');
	}, 60_000);

	test('channel-A settlement attribution returns the committed declared file', async () => {
		const { captureWorkspaceSnapshotAsync } = await import(
			'../../../src/background/workspace-snapshot'
		);
		const baseline = await captureWorkspaceSnapshotAsync(directory);
		expect(baseline.gitHead).not.toBeNull();
		fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
		fs.writeFileSync(path.join(directory, DECLARED_FILE), 'committed\n');
		git(['add', DECLARED_FILE]);
		git(['commit', '-m', 'coder output']);
		const observed = await changedFilesSinceSnapshotAsync(directory, baseline);
		expect(observed).toContain(DECLARED_FILE);
	}, 60_000);
});
