/**
 * Issue #3655 acceptance checks — committed declared changes must attribute
 * into the shared-root reviewer-scope generation at coder completion.
 *
 * The reporter's wedge: a shared-root coder delegation whose declared file was
 * written and COMMITTED via git (outside guardrail write-routing). At base,
 * completeReviewerScopeLifecycle classifies the generation using only
 * guardrail-routed writes, so zero routed writes plus a dirty tree (variant A)
 * strands the generation in `collecting` and reviewer dispatch throws terminal
 * REVIEWER_SCOPE_STALE, while a clean tree (variant B) marks `no_change` even
 * though a committed declared change exists (wrong REVIEWER_SCOPE_NO_CHANGE).
 *
 * RED at base, GREEN after the fix: the committed-file checks (variants A and
 * B) and the typed attribution-empty check. GREEN at base and must stay GREEN
 * (preserving truthfulness): the no-change check — a coder run with no writes
 * and no commits on a clean tree is genuinely owed no reviewer pass.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import {
	getReviewerScopeGenerationForCoderCall,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TASK_ID = '9.4';
const DECLARED_FILE = 'docs/service-access-standard.md';
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

/** Coder dispatch fixture: child session, scope binding, lifecycle begin. */
async function beginCoderDispatch(
	callID: string,
): Promise<'coder_started' | null> {
	const childSessionID = `child-${callID}`;
	startAgentSession(childSessionID, 'coder', directory);
	installActiveScopeBinding({
		directory,
		childSessionId: childSessionID,
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

async function completeCoderDispatch(callID: string): Promise<unknown> {
	return completeReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: { subagent_type: 'coder', prompt: CODER_PROMPT },
		output: SUCCESS_OUTPUT,
		parentSessionID: 'parent',
		callID,
	});
}

async function dispatchReviewer(callID: string): Promise<unknown> {
	return beginApprovedReviewerScopeLifecycle({
		directory,
		tool: 'Task',
		args: {
			subagent_type: 'reviewer',
			prompt: `TASK: ${TASK_ID}\nReview the task.`,
		},
		parentSessionID: 'parent',
		callID,
		maxBytes: 1024 * 1024,
	});
}

function generationForCoderCall(callID: string) {
	return getReviewerScopeGenerationForCoderCall({
		parentSessionID: 'parent',
		taskId: TASK_ID,
		coderCallID: callID,
	});
}

/**
 * The coder writes its declared file and COMMITS it through a path the
 * guardrail write-routing never observed (shell write + git commit — the
 * commit itself is the un-routed operation, exactly the reporter's scenario).
 */
function writeAndCommitDeclaredFile(): void {
	fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, DECLARED_FILE),
		'# Service Access Standard\ncommitted coder output\n',
	);
	git(['add', DECLARED_FILE]);
	git(['commit', '-m', 'coder: write service access standard']);
}

beforeEach(() => {
	resetSwarmState();
	directory = canonicalMkdtemp('reviewer-scope-committed-3655-');
	fs.mkdirSync(path.join(directory, 'docs'), { recursive: true });
	fs.writeFileSync(path.join(directory, 'README.md'), 'baseline\n');
	git(['init']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test']);
	git(['add', 'README.md']);
	git(['commit', '-m', 'baseline']);
	// Model the common real workspace: .swarm excluded (ensureSwarmGitExcluded),
	// so runtime writes do not dirty `git status`.
	fs.appendFileSync(path.join(directory, '.git/info/exclude'), '\n.swarm/\n');
	startAgentSession('parent', 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	safeRmRecursive(directory);
});

describe('reviewer scope committed-change attribution (issue #3655)', () => {
	test('committed declared file with stray untracked path reaches reviewer dispatch', async () => {
		expect(await beginCoderDispatch('coder-dirty')).toBe('coder_started');
		writeAndCommitDeclaredFile();
		// One untracked non-runtime path at completion (editor artifact, leftover).
		fs.writeFileSync(path.join(directory, 'NOTES-untracked.md'), 'stray\n');
		await completeCoderDispatch('coder-dirty');
		const generation = generationForCoderCall('coder-dirty');
		expect(generation?.status).toBe('ready');
		expect(generation?.modifiedFiles).toContain(DECLARED_FILE);
		expect(generation?.modifiedFileFingerprints).toHaveLength(1);
		await expect(dispatchReviewer('reviewer-dirty')).resolves.toBe(
			'reviewer_claimed',
		);
	}, 60_000);

	test('committed declared file on clean tree reaches reviewer dispatch', async () => {
		expect(await beginCoderDispatch('coder-clean')).toBe('coder_started');
		writeAndCommitDeclaredFile();
		await completeCoderDispatch('coder-clean');
		const generation = generationForCoderCall('coder-clean');
		expect(generation?.status).toBe('ready');
		expect(generation?.modifiedFiles).toContain(DECLARED_FILE);
		expect(generation?.modifiedFileFingerprints).toHaveLength(1);
		await expect(dispatchReviewer('reviewer-clean')).resolves.toBe(
			'reviewer_claimed',
		);
	}, 60_000);

	test('truthful no-change coder run still reports REVIEWER_SCOPE_NO_CHANGE', async () => {
		expect(await beginCoderDispatch('coder-nochange')).toBe('coder_started');
		// No writes, no commits, clean tree: genuinely no change to review.
		await completeCoderDispatch('coder-nochange');
		expect(generationForCoderCall('coder-nochange')?.status).toBe('no_change');
		let message = '';
		try {
			await dispatchReviewer('reviewer-nochange');
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('REVIEWER_SCOPE_NO_CHANGE');
	}, 60_000);

	test('attribution-empty dirty workspace gets typed retryable error not terminal stale', async () => {
		expect(await beginCoderDispatch('coder-empty')).toBe('coder_started');
		// Zero routed writes, NO committed declared change, and one stray
		// untracked non-runtime file: nothing attributes the workspace to the
		// coder — a typed retryable error, never terminal REVIEWER_SCOPE_STALE.
		fs.writeFileSync(path.join(directory, 'NOTES-untracked.md'), 'stray\n');
		await completeCoderDispatch('coder-empty');
		let message = '';
		try {
			await dispatchReviewer('reviewer-empty');
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('REVIEWER_ATTRIBUTION_EMPTY');
		expect(message).toContain('retryable=true');
		expect(message).not.toContain('retryable=false');
	}, 60_000);
});
