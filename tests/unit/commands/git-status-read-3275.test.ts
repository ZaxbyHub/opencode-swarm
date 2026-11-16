/**
 * Acceptance check C3 for issue #3317 (class: NEW-SURFACE).
 *
 * Direct behavioral contract for the new src/commands/git-status-read module:
 *  - a child that exceeds its timeout resolves to { ok:false, code:'ETIMEDOUT' }
 *    WITHOUT blocking the event loop (a timer scheduled before the call fires
 *    before the promise resolves — impossible if the impl spawnSyncs);
 *  - a child that exits nonzero resolves to { ok:false, status:<exit> } with a
 *    BOUNDED stderr tail (<= 200 chars, not the full 500-char stderr).
 *
 * The executable seam is pointed at process.execPath (the bun binary running
 * this test) so the child programs are real `bun -e` scripts.
 *
 * RED at base (module src/commands/git-status-read does not exist), GREEN
 * after the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	gitStatusReadInternals,
	readGitStatusAsync,
} from '../../../src/commands/git-status-read';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

const originalReadOnce = gitStatusReadInternals.readOnce;
const originalResolveExecutable = gitStatusReadInternals.resolveExecutable;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	gitStatusReadInternals.resolveExecutable = originalResolveExecutable;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('readGitStatusAsync / gitStatusReadInternals (#3317 C3)', () => {
	test('timeout: child sleeping past timeoutMs resolves ETIMEDOUT without blocking the event loop', async () => {
		const cwd = canonicalMkdtemp('3317-read-timeout-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => process.execPath;

		// Event-loop liveness probe: scheduled BEFORE the read. A blocking
		// (spawnSync-style) implementation cannot run this timer until the
		// child is dead; with a 5s child and a 300ms timeout the promise must
		// settle long before 5s, and the timer must have fired by then.
		let fired = false;
		setTimeout(() => {
			fired = true;
		}, 100);

		const result = await gitStatusReadInternals.readOnce(
			['-e', 'await new Promise((r) => setTimeout(r, 5000))'],
			cwd,
			300,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ETIMEDOUT');
		}
		expect(fired).toBe(true);
	}, 30_000);

	test('nonzero exit: status carried, stderr tail bounded and non-empty', async () => {
		const cwd = canonicalMkdtemp('3317-read-exit-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => process.execPath;

		const result = await readGitStatusAsync(
			['-e', "console.error('x'.repeat(500)); process.exit(3)"],
			cwd,
			{ timeoutMs: 10_000 },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(3);
			expect(result.stderrTail.length).toBeLessThanOrEqual(200);
			expect(result.stderrTail).toContain('xxx');
		}
	}, 30_000);
});
