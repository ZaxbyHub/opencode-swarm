/**
 * Issue #3315 AC23 — untracked files STILL count as dirt for PR_REVIEW.
 *
 * GREEN at base and head (floor): assertPrReviewCleanCheckout must keep
 * rejecting when the working tree has even ONE untracked file. This pins that
 * the #3315 dirty-path diagnostics work (AC22) never loosens the underlying
 * clean-tree predicate to "untracked files do not count" — a review lane must
 * never read a tree that differs from the exact PR head, whatever the dirt's
 * index status.
 *
 * Real Git fixture (no seam stubs): a real `git init` repo with one commit
 * plus one untracked file; assertPrReviewCleanCheckout runs the REAL working
 * tree clean resolver (src/background/workspace-snapshot.ts) against it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrReviewCleanCheckout } from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

function gitRun(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 15_000,
	});
}

/** Real repo with one commit plus ONE untracked file. */
function createRepoWithOneUntrackedFile(): string {
	const dir = canonicalMkdtemp('pr-review-untracked-dirty-');
	gitRun(dir, ['init', '-q', '-b', 'main']);
	gitRun(dir, ['config', 'user.email', 'swarm-test@example.com']);
	gitRun(dir, ['config', 'user.name', 'Swarm Test']);
	gitRun(dir, ['commit', '--allow-empty', '-q', '-m', 'init']);
	writeFileSync(join(dir, 'stray.txt'), 'untracked dirt\n');
	return dir;
}

describe('issue #3315 AC23 — one untracked file still fails the clean checkout', () => {
	let dir = '';

	afterEach(() => {
		if (dir) removeTreeWithRetry(dir);
		dir = '';
	});

	test('assertPrReviewCleanCheckout rejects an untracked-file tree', async () => {
		dir = createRepoWithOneUntrackedFile();
		await expect(assertPrReviewCleanCheckout(dir, 'PR_REVIEW')).rejects.toThrow(
			/requires a clean index and working tree at the exact PR head/,
		);
	});
});
