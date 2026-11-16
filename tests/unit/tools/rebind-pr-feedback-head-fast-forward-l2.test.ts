/**
 * Issue #3315 acceptance check AC2 — rebindPrFeedbackHead fast-forwards the
 * bound local tracking branch to the fetched-forward tracking head.
 * Classification: DISCRIMINATING — RED at base, GREEN after the fix.
 *
 * Base defect (trace 3315-prescribed-tools-reachable, D1): the gate blocks
 * every shell that could move HEAD (merge/rebase/reset/switch), while the
 * rebind precondition `assertCurrentCheckoutHead` requires HEAD to ALREADY
 * equal the new remote head. Nothing the gate admits can satisfy both, so
 * after the remote advances, rebind is a dead end.
 *
 * Post-fix contract (AC2), with a bound tracking ref fetched forward, a clean
 * tree, unarmed gate, and no open lanes: `rebindPrFeedbackHead(dir, session,
 * <tracking-head-sha>)` fast-forwards the local branch to that tracking head
 * ONLY (never merge/rebase/reset) and rebinds. The fixture below builds a
 * REAL git repository whose local branch `pr-head` tracks a REAL bare
 * `origin`, HEAD checked out at commit A, and refs/remotes/origin/pr-head
 * fetched forward to commit B (a strict descendant of A). The fix must move
 * HEAD to B and rebind.
 *
 * The second test freezes the refusal half: when origin advances to a commit
 * C that DIVERGES from the checked-out A (not a descendant), rebind must
 * refuse and leave HEAD exactly at A.
 *
 * BASE signature (verified 2026-10-18): the whole file fails because the
 * fast-forward test's `await rebindPrFeedbackHead(...)` rejects with
 * `BLOCKED: current checkout HEAD "<A>" does not match PR head "<B>" ...` —
 * nothing at base ever moves HEAD. The divergent-refusal test happens to pass
 * at base via the BLOCKED alternation of its loose regex (the base rejection
 * is also a BLOCKED refusal and HEAD stays at A); the fast-forward test
 * carries the file's RED.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	activatePrWorkflow,
	rebindPrFeedbackHead,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Array-form git with explicit cwd; output ignored (mutation commands). */
function gitQuiet(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 30_000,
	});
}

/** Array-form git capturing bounded stdout (rev-parse / status probes). */
function gitOut(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], {
		encoding: 'utf-8',
		maxBuffer: 1024 * 1024,
		timeout: 30_000,
	}).trim();
}

function isAncestor(
	dir: string,
	ancestor: string,
	descendant: string,
): boolean {
	try {
		execFileSync(
			'git',
			['-C', dir, 'merge-base', '--is-ancestor', ancestor, descendant],
			{ stdio: 'ignore', timeout: 30_000 },
		);
		return true;
	} catch {
		return false;
	}
}

interface PrHeadFixture {
	repo: string;
	bare: string;
	/** The commit the gate binds (child of headRoot). */
	headA: string;
	/** The root commit — branching from here diverges from headA. */
	headRoot: string;
}

/**
 * Build a real repo whose `pr-head` branch is pushed to a real bare `origin`
 * with upstream tracking, checked out at commit A (on top of a root commit).
 * `.swarm/` is committed to .gitignore so gate-state writes never dirty the
 * porcelain (mirrors the production ensureSwarmGitExcluded behavior).
 */
function makePrHeadFixture(prefix: string): PrHeadFixture {
	const repo = canonicalMkdtemp(`${prefix}repo-`);
	const bare = canonicalMkdtemp(`${prefix}bare-`);
	execFileSync('git', ['init', '-q', '--bare', bare], {
		stdio: 'ignore',
		timeout: 30_000,
	});
	gitQuiet(repo, ['init', '-q']);
	gitQuiet(repo, ['checkout', '-q', '-b', 'pr-head']);
	gitOut(repo, ['config', 'user.email', 't@example.com']);
	gitOut(repo, ['config', 'user.name', 'T']);
	gitOut(repo, ['config', 'core.autocrlf', 'false']);
	writeFileSync(join(repo, '.gitignore'), '.swarm/\n');
	writeFileSync(join(repo, 'file.txt'), 'root\n');
	gitQuiet(repo, ['add', '.']);
	gitQuiet(repo, ['commit', '-q', '-m', 'root']);
	const headRoot = gitOut(repo, ['rev-parse', 'HEAD']);
	writeFileSync(join(repo, 'file.txt'), 'A\n');
	gitQuiet(repo, ['add', '.']);
	gitQuiet(repo, ['commit', '-q', '-m', 'A']);
	const headA = gitOut(repo, ['rev-parse', 'HEAD']);
	gitQuiet(repo, ['remote', 'add', 'origin', bare]);
	gitQuiet(repo, ['push', '-q', '-u', 'origin', 'pr-head']);
	return { repo, bare, headA, headRoot };
}

describe('rebindPrFeedbackHead fast-forward (issue #3315 AC2)', () => {
	test('fast-forwards the local branch to the fetched-forward tracking head and rebinds', async () => {
		const fixture = makePrHeadFixture('rebind-ff-');
		const { repo, headA } = fixture;
		try {
			// Advance the remote: commit B (a strict descendant of A), push it to
			// origin, then move the local branch BACK to A so the checkout stays
			// clean at A while the tracking ref points at B.
			writeFileSync(join(repo, 'file.txt'), 'B\n');
			gitQuiet(repo, ['add', '.']);
			gitQuiet(repo, ['commit', '-q', '-m', 'B']);
			const headB = gitOut(repo, ['rev-parse', 'HEAD']);
			gitQuiet(repo, ['push', '-q', 'origin', 'pr-head']);
			gitQuiet(repo, ['reset', '-q', '--hard', headA]);
			gitQuiet(repo, ['fetch', '-q', 'origin', 'pr-head']);

			// Fixture invariants: HEAD == A, tracking ref == B, A is an
			// ancestor of B (fast-forwardable), tree clean.
			expect(gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headA);
			expect(gitOut(repo, ['rev-parse', 'refs/remotes/origin/pr-head'])).toBe(
				headB,
			);
			expect(isAncestor(repo, headA, headB)).toBe(true);
			expect(
				gitOut(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
			).toBe('');

			// Bind the gate while HEAD == A (the bind itself runs
			// assertCurrentCheckoutHead and must succeed at A).
			const session = 'rebind-ff-3315';
			await activatePrWorkflow(repo, session, 'PR_FEEDBACK', {
				prHeadSha: headA,
			});

			// POST-FIX contract: the rebind fast-forwards the local branch to the
			// tracking head and rebinds. At base this await rejects with
			// `BLOCKED: current checkout HEAD "<A>" does not match PR head "<B>"`
			// because nothing ever moves HEAD — the documented base signature.
			const state = await rebindPrFeedbackHead(repo, session, headB);
			expect(state.prHeadSha).toBe(headB);
			expect(gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headB);
			// The move was a fast-forward: A remains an ancestor of the NEW HEAD,
			// so no merge/rebase/reset rewrote history (headB was already proven
			// an ancestor of itself by the fixture invariant above).
			expect(isAncestor(repo, headA, gitOut(repo, ['rev-parse', 'HEAD']))).toBe(
				true,
			);
			// The rebind count records the transition.
			expect(state.prFeedbackRebindCount).toBe(1);
		} finally {
			safeRmRecursive(fixture.repo);
			safeRmRecursive(fixture.bare);
		}
	});

	test('refuses a rebind to a tracking head that diverges from the checkout and leaves HEAD untouched', async () => {
		const fixture = makePrHeadFixture('rebind-nff-');
		const { repo, headA, headRoot } = fixture;
		try {
			// Advance origin to a commit C that DIVERGES from A: branch from
			// A's PARENT (the root commit) and commit a different change, so C
			// is NOT a descendant of A. Push that commit to origin's pr-head,
			// return to pr-head (still at A), and fetch so the tracking ref == C.
			gitQuiet(repo, ['checkout', '-q', '-b', 'tmp-diverge', headRoot]);
			writeFileSync(join(repo, 'other.txt'), 'C\n');
			gitQuiet(repo, ['add', '.']);
			gitQuiet(repo, ['commit', '-q', '-m', 'C']);
			const headC = gitOut(repo, ['rev-parse', 'HEAD']);
			// --force: the fixture remote legitimately receives a non-diverging
			// history rewrite (C replaces A as the pr-head tip) — exactly the
			// remote shape that makes the rebind target non-fast-forwardable.
			gitQuiet(repo, [
				'push',
				'-q',
				'--force',
				'origin',
				`${headC}:refs/heads/pr-head`,
			]);
			gitQuiet(repo, ['checkout', '-q', 'pr-head']);
			gitQuiet(repo, ['branch', '-q', '-D', 'tmp-diverge']);
			gitQuiet(repo, ['fetch', '-q', 'origin', 'pr-head']);

			// Fixture invariants: HEAD == A, tracking ref == C, and C is NOT a
			// descendant of A (a fast-forward is impossible).
			expect(gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headA);
			expect(gitOut(repo, ['rev-parse', 'refs/remotes/origin/pr-head'])).toBe(
				headC,
			);
			expect(isAncestor(repo, headA, headC)).toBe(false);

			const session = 'rebind-nff-3315';
			await activatePrWorkflow(repo, session, 'PR_FEEDBACK', {
				prHeadSha: headA,
			});

			// POST-FIX contract: refuse the non-fast-forwardable target and leave
			// the checkout exactly at A. At base this leg also rejects (with the
			// checkout-mismatch BLOCKED message) and HEAD stays at A, so it passes
			// via the BLOCKED alternation; the refusal half of the contract is
			// carried jointly with the fast-forward test above.
			let refusal = '';
			try {
				await rebindPrFeedbackHead(repo, session, headC);
				refusal = 'NO_REFUSAL';
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
			expect(refusal).toMatch(/fast-forward|not a descendant|BLOCKED/);
			expect(gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headA);
		} finally {
			safeRmRecursive(fixture.repo);
			safeRmRecursive(fixture.bare);
		}
	});
});
