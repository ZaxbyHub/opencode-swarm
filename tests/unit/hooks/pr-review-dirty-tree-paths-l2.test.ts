/**
 * Issue #3315 AC22 — PR_REVIEW dirty-tree refusal NAMES the dirty paths.
 *
 * RED at base, GREEN after the fix: at the unfixed base
 * assertPrReviewCleanCheckout rejects with a path-free message
 * ("BLOCKED: PR_REVIEW requires a clean index and working tree at the exact
 * PR head") — the refusal names NO file, so the caller cannot see what to
 * clean. After the #3315 fix the same refusal must still match
 * `/requires a clean index and working tree at the exact PR head/` AND name
 * the dirty paths: the message must contain at least `dirty-a.txt` and a
 * total/count indication (shipped shape: "Dirty paths (first N of M): ...",
 * asserted via `/of \d+/`).
 *
 * Real Git fixture (no seam stubs): a real `git init` repo with one commit,
 * then SIX untracked files (dirty-a.txt … dirty-f.txt) plus one modified
 * tracked file — SEVEN dirty paths in total, two OVER the shipped
 * disclosure limit of 5 (PR_WORKFLOW_DIRTY_PATH_DISCLOSURE_LIMIT,
 * pr-workflow-gate.ts), so the fixture exercises both the truncation slice
 * (dirty-f.txt must NOT be disclosed) and the "first N of M" count. One
 * earlier freeze shipped only four dirt sources and never crossed the limit.
 * assertPrReviewCleanCheckout
 * is exported from src/hooks/pr-workflow-gate.ts and runs the REAL working
 * tree clean resolver (src/background/workspace-snapshot.ts) against the
 * repository — no gate state is required for this assertion.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrReviewCleanCheckout } from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

function gitRun(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 15_000,
	});
}

/**
 * Real repo with one commit, then six untracked + one modified tracked file —
 * six paths beyond the disclosure limit of 5 so truncation is exercised.
 */
function createDirtyReviewRepo(): string {
	const dir = canonicalMkdtemp('pr-review-dirty-paths-');
	mkdirSync(join(dir, 'src'), { recursive: true });
	const tracked = join(dir, 'src', 'tracked.ts');
	writeFileSync(tracked, 'export const a = 1;\n');
	gitRun(dir, ['init', '-q', '-b', 'main']);
	gitRun(dir, ['config', 'user.email', 'swarm-test@example.com']);
	gitRun(dir, ['config', 'user.name', 'Swarm Test']);
	gitRun(dir, ['add', '.']);
	gitRun(dir, ['commit', '-q', '-m', 'init']);
	for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
		writeFileSync(join(dir, `dirty-${name}.txt`), `${name}\n`);
	}
	writeFileSync(tracked, 'export const a = 2;\n');
	return dir;
}

describe('issue #3315 AC22 — dirty-tree refusal names the dirty paths', () => {
	let dir = '';

	afterEach(() => {
		if (dir) removeTreeWithRetry(dir);
		dir = '';
	});

	test('rejection still demands a clean tree AND lists dirty-a.txt with a count', async () => {
		dir = createDirtyReviewRepo();
		let message = 'NO_THROW';
		try {
			await assertPrReviewCleanCheckout(dir, 'PR_REVIEW');
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// The refusal itself is unchanged in kind...
		expect(message).toMatch(
			/requires a clean index and working tree at the exact PR head/,
		);
		// ...but at the unfixed base the next assertions FAIL: the base
		// message names NO path. Post-fix it must name at least dirty-a.txt...
		expect(message).toMatch(/dirty-a\.txt/);
		// ...carry the "first N of M" count, and TRUNCATE at the disclosure
		// limit: seven dirty paths exist (the tracked modification first, then
		// the six untracked files in porcelain path order), so the disclosed
		// slice is the first 5 and dirty-f.txt (seventh) must NOT leak into
		// the message.
		expect(message).toMatch(/first 5 of 7/);
		expect(message).not.toMatch(/dirty-f\.txt/);
	});
});
