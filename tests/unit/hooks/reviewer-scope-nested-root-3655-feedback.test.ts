/**
 * PR #3668 feedback-round coverage (FB-001/FB-002/FB-003/FB-004/FB-013):
 * nested-root path-base correctness, every-completion reconciliation union,
 * the generation-cap guard, bounded capture retry inputs, and the
 * reconcile-path capture-failure production branch.
 *
 * GREEN after the feedback fixes; the nested-root and mixed legs are RED on
 * the pre-feedback head d5f2605b6 (reconciliation was inert in nested roots
 * and skipped whenever any write was routed).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { committedFilesBetweenAsync } from '../../../src/background/workspace-snapshot';
import { resolveReviewerScopeTaskId } from '../../../src/hooks/review-receipt-scope';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import {
	getReviewerScopeGenerationForCoderCall,
	MAX_REVIEWER_SCOPE_GENERATION_FILES,
	recordReviewerScopeGenerationFile,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TASK_ID = '4.2';
const DECLARED_FILE = 'docs/declared.md';
const CODER_PROMPT = `TASK: ${TASK_ID}\nWrite ${DECLARED_FILE}.`;
const SUCCESS_OUTPUT = { status: 'completed', output: 'done' };

let parent = '';

function git(args: string[], cwd: string = parent): void {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 15_000,
		maxBuffer: 8 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
}

/** Coder dispatch fixture against `root` (the capture/project root). */
async function beginCoderAt(
	root: string,
	callID: string,
): Promise<'coder_started' | null> {
	startAgentSession(`child-${callID}`, 'coder', root);
	installActiveScopeBinding({
		directory: root,
		childSessionId: `child-${callID}`,
		parentSessionId: 'parent',
		dispatchCallId: callID,
		taskId: TASK_ID,
		files: ['docs/'],
	});
	return beginApprovedReviewerScopeLifecycle({
		directory: root,
		tool: 'Task',
		args: { subagent_type: 'coder', prompt: CODER_PROMPT },
		parentSessionID: 'parent',
		callID,
	});
}

async function completeCoderAt(root: string, callID: string): Promise<unknown> {
	return completeReviewerScopeLifecycle({
		directory: root,
		tool: 'Task',
		args: { subagent_type: 'coder', prompt: CODER_PROMPT },
		output: SUCCESS_OUTPUT,
		parentSessionID: 'parent',
		callID,
	});
}

async function dispatchReviewerAt(
	root: string,
	callID: string,
): Promise<{ threw: boolean; message: string; value: unknown }> {
	try {
		const value = await beginApprovedReviewerScopeLifecycle({
			directory: root,
			tool: 'Task',
			args: { subagent_type: 'reviewer', prompt: `TASK: ${TASK_ID}\nReview.` },
			parentSessionID: 'parent',
			callID,
			maxBytes: 1024 * 1024,
		});
		return { threw: false, message: '', value };
	} catch (error) {
		return {
			threw: true,
			message: error instanceof Error ? error.message : String(error),
			value: undefined,
		};
	}
}

function advisories(): string[] {
	return swarmState.agentSessions.get('parent')?.pendingAdvisoryMessages ?? [];
}

beforeEach(() => {
	resetSwarmState();
	parent = canonicalMkdtemp('reviewer-scope-nested-3655-');
	fs.mkdirSync(path.join(parent, 'proj', 'docs'), { recursive: true });
	fs.writeFileSync(path.join(parent, 'README.md'), 'outer baseline\n');
	git(['init']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test']);
	git(['add', 'README.md']);
	git(['commit', '-m', 'outer baseline']);
	// Model the common real workspace: .swarm excluded repo-wide.
	fs.appendFileSync(
		path.join(parent, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
	);
	startAgentSession('parent', 'architect', path.join(parent, 'proj'));
});

afterEach(() => {
	resetSwarmState();
	safeRmRecursive(parent);
});

describe('reviewer scope nested-root reconciliation (PR #3668 feedback)', () => {
	test('committed declared file in a nested project root reaches reviewer dispatch', async () => {
		const proj = path.join(parent, 'proj');
		expect(await beginCoderAt(proj, 'c-nested')).toBe('coder_started');
		fs.writeFileSync(
			path.join(proj, DECLARED_FILE),
			'# nested committed output\n',
		);
		git(['add', 'proj/docs/declared.md']);
		git(['commit', '-m', 'coder output under nested root']);
		await completeCoderAt(proj, 'c-nested');
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-nested',
		});
		expect(generation?.status).toBe('ready');
		expect(generation?.modifiedFiles).toContain(DECLARED_FILE);
		const reviewerResult = await dispatchReviewerAt(proj, 'r-nested');
		expect(reviewerResult.value).toBe('reviewer_claimed');
	}, 60_000);

	test('mixed completion routes the committed file alongside the routed one', async () => {
		const proj = path.join(parent, 'proj');
		expect(await beginCoderAt(proj, 'c-mixed')).toBe('coder_started');
		// Declared A: guardrail-routed bytes left uncommitted on disk.
		fs.writeFileSync(path.join(proj, 'docs/a.md'), 'routed bytes\n');
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: TASK_ID,
				coderCallID: 'c-mixed',
				file: 'docs/a.md',
			}),
		).toBe(true);
		// Declared B: committed through an unobserved path.
		fs.writeFileSync(path.join(proj, 'docs/b.md'), 'committed bytes\n');
		git(['add', 'proj/docs/b.md']);
		git(['commit', '-m', 'committed declared output']);
		await completeCoderAt(proj, 'c-mixed');
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-mixed',
		});
		expect(generation?.status).toBe('ready');
		expect(generation?.modifiedFiles).toContain('docs/a.md');
		expect(generation?.modifiedFiles).toContain('docs/b.md');
		expect((await dispatchReviewerAt(proj, 'r-mixed')).value).toBe(
			'reviewer_claimed',
		);
	}, 60_000);

	test('declared-scope working-tree dirt routes even without any commit', async () => {
		const proj = path.join(parent, 'proj');
		expect(await beginCoderAt(proj, 'c-dirty')).toBe('coder_started');
		// Uncommitted declared write, never guardrail-observed, never committed.
		fs.writeFileSync(
			path.join(proj, DECLARED_FILE),
			'uncommitted declared bytes\n',
		);
		await completeCoderAt(proj, 'c-dirty');
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-dirty',
		});
		expect(generation?.status).toBe('ready');
		expect(generation?.modifiedFiles).toContain(DECLARED_FILE);
	}, 60_000);

	test('declared changes beyond the generation cap are refused, never destroy the generation', async () => {
		const proj = path.join(parent, 'proj');
		expect(await beginCoderAt(proj, 'c-cap')).toBe('coder_started');
		const overflow = MAX_REVIEWER_SCOPE_GENERATION_FILES + 1;
		for (let i = 0; i < overflow; i += 1) {
			fs.writeFileSync(
				path.join(proj, 'docs', `f${String(i).padStart(3, '0')}.md`),
				`bulk ${i}\n`,
			);
		}
		git(['add', 'proj/docs/']);
		git(['commit', '-m', 'bulk declared output']);
		await completeCoderAt(proj, 'c-cap');
		// The generation survives (never cap-destroyed) with a typed advisory.
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-cap',
		});
		expect(generation?.status).toBe('collecting');
		expect(advisories().join('\n')).toContain(
			'REVIEWER_SCOPE_GENERATION_OVERFLOW',
		);
		const denial = await dispatchReviewerAt(proj, 'r-cap');
		expect(denial.message).toContain('REVIEWER_ATTRIBUTION_EMPTY');
		expect(denial.message).toContain('retryable=true');
	}, 60_000);

	test('reconcile-path capture failure records the permanent failure and denies typed', async () => {
		const proj = path.join(parent, 'proj');
		expect(await beginCoderAt(proj, 'c-capfail')).toBe('coder_started');
		fs.writeFileSync(path.join(proj, DECLARED_FILE), 'will collide\n');
		git(['add', 'proj/docs/declared.md']);
		git(['commit', '-m', 'committed declared output']);
		// Replace the committed FILE with a DIRECTORY of the same name: the
		// committed diff still lists it, but fingerprint capture hits a
		// non-regular entry (permanent class).
		fs.rmSync(path.join(proj, DECLARED_FILE));
		fs.mkdirSync(path.join(proj, DECLARED_FILE), { recursive: true });
		await completeCoderAt(proj, 'c-capfail');
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c-capfail',
		});
		expect(generation?.status).toBe('collecting');
		expect(generation?.captureFailures.some((f) => !f.retryable)).toBe(true);
		const denial = await dispatchReviewerAt(proj, 'r-capfail');
		expect(denial.message).toContain('REVIEWER_CAPTURE_FAILED');
		expect(denial.message).toContain('retryable=false');
		expect(denial.message).toContain('re-dispatch the coder');
	}, 60_000);

	test('committedFilesBetweenAsync relative option returns capture-relative paths', async () => {
		const proj = path.join(parent, 'proj');
		const head0 = git2rev(['rev-parse', 'HEAD'], parent);
		fs.writeFileSync(path.join(proj, DECLARED_FILE), 'x\n');
		git(['add', 'proj/docs/declared.md']);
		git(['commit', '-m', 'relative leg']);
		const head1 = git2rev(['rev-parse', 'HEAD'], parent);
		const absolute = await committedFilesBetweenAsync(proj, head0, head1);
		expect(absolute).toContain('proj/docs/declared.md');
		const relative = await committedFilesBetweenAsync(proj, head0, head1, {
			relative: true,
		});
		expect(relative).toContain('docs/declared.md');
		expect(relative?.some((p) => p.startsWith('proj/'))).toBe(false);
	}, 60_000);
});

function git2rev(args: string[], cwd: string): string {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 10_000,
		stdio: ['ignore', 'pipe', 'ignore'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
	return result.stdout.trim();
}
