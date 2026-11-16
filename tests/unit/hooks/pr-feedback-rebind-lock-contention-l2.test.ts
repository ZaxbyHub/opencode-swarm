/**
 * Feedback-round coverage (F-R25): `rebindPrFeedbackHead` runs its entire
 * body — preconditions, the ff-only HEAD move, and the CAS state write —
 * under `withPrWorkflowCheckoutMutationLock` (issue #3315 D1, lock order of
 * bind). Nothing pinned that a concurrent holder of the checkout-mutation
 * lock makes the rebind WAIT rather than interleave: this test holds the
 * lock, starts a rebind, proves it cannot complete while held, then releases
 * and proves the same rebind completes without a deadlock.
 *
 * Real Git fixture (mirrors frozen C2): a real repo tracking a real bare
 * origin, checked out at A with the tracking ref fetched forward to B.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	activatePrWorkflow,
	rebindPrFeedbackHead,
	withPrWorkflowCheckoutMutationLock,
} from '../../../src/hooks/pr-workflow-gate.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function gitQuiet(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 30_000,
	});
}

function gitOut(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], {
		encoding: 'utf-8',
		maxBuffer: 1024 * 1024,
		timeout: 30_000,
	}).trim();
}

/** Repo at A on branch pr-head tracking a bare origin, like frozen C2. */
function makeFixture(prefix: string): {
	repo: string;
	bare: string;
	headA: string;
} {
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
	gitQuiet(repo, ['commit', '-q', '-m', 'A']);
	const headA = gitOut(repo, ['rev-parse', 'HEAD']);
	gitQuiet(repo, ['remote', 'add', 'origin', bare]);
	gitQuiet(repo, ['push', '-q', '-u', 'origin', 'pr-head']);
	return { repo, bare, headA };
}

describe('rebindPrFeedbackHead waits for the checkout-mutation lock (F-R25)', () => {
	test('a concurrent lock holder blocks the rebind; release lets the same rebind complete', async () => {
		const fixture = makeFixture('rebind-lock-');
		const { repo, bare, headA } = fixture;
		try {
			// Advance origin to B (strict descendant), pull the local branch back
			// to A, and fetch — the C2 fast-forward shape.
			writeFileSync(join(repo, 'file.txt'), 'B\n');
			gitQuiet(repo, ['add', '.']);
			gitQuiet(repo, ['commit', '-q', '-m', 'B']);
			const headB = gitOut(repo, ['rev-parse', 'HEAD']);
			gitQuiet(repo, ['push', '-q', 'origin', 'pr-head']);
			gitQuiet(repo, ['reset', '-q', '--hard', headA]);
			gitQuiet(repo, ['fetch', '-q', 'origin', 'pr-head']);

			const session = 'rebind-lock-3315';
			await activatePrWorkflow(repo, session, 'PR_FEEDBACK', {
				prHeadSha: headA,
			});

			// Hold the checkout-mutation lock from "outside" (as a concurrent
			// bind/complete/checkout op would) and start the rebind under it.
			let releaseHolder: () => void = () => {};
			const holderGate = new Promise<void>((resolve) => {
				releaseHolder = resolve;
			});
			const holder = withPrWorkflowCheckoutMutationLock(repo, () => holderGate);

			let completed = false;
			const rebind = rebindPrFeedbackHead(repo, session, headB).then(
				(state) => {
					completed = true;
					return state;
				},
			);

			// Best-effort ordering probe: after a bounded yield window the rebind
			// must NOT have completed — the lock is still held. (A heavily loaded
			// runner may not even have entered the lock queue yet, in which case
			// this probe is vacuously true; the load-bearing assertions are the
			// completion checks below.)
			await Bun.sleep(200);
			expect(completed).toBe(false);

			// Release; the pending rebind must drain and finish the fast-forward.
			releaseHolder();
			await holder;
			const state = await Promise.race([
				rebind,
				Bun.sleep(15_000).then(() => {
					throw new Error(
						'rebind did not complete within 15s of lock release (deadlock?)',
					);
				}),
			]);
			expect(state.prHeadSha).toBe(headB);
			expect(gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headB);
			expect(state.prFeedbackRebindCount).toBe(1);
		} finally {
			safeRmRecursive(fixture.repo);
			safeRmRecursive(fixture.bare);
		}
	});
});
