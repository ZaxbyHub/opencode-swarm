/**
 * RETAINED FOR THE FROZEN CHECKPOINT MANIFEST ONLY — the real-process
 * pipe-holding legs that used this fixture were removed after CI round 1
 * proved the mechanism non-portable on Linux (see
 * repository-validation-reader-completeness-3664.test.ts). No test imports
 * this file; the frozen manifest row pins its bytes, so it stays.
 */

/**
 * Issue #3664 fixture: a test that PASSES immediately while a DETACHED child
 * keeps an inherited copy of stdout/stderr open long after the test process
 * exits.
 *
 * The direct child (this `bun test` process) exits 0 with all of its output
 * already written, but the detached descendant holds the pipe, so the
 * harness's bounded readers can never observe EOF and cannot prove the
 * channel was read to completion. The row recorded for this file must not
 * claim a clean `passed` on the strength of an incomplete reader.
 */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

test('passes immediately while a detached child holds the inherited pipe', () => {
	spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
		stdin: 'ignore',
		stdout: 'inherit',
		stderr: 'inherit',
		detached: true,
		windowsHide: true,
	}).unref();
	expect(true).toBe(true);
});
