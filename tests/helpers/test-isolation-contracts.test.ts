/**
 * Contract self-tests for `tests/helpers/test-isolation.ts` that need a
 * temporarily-mutated seam or a hostile filesystem entry.
 *
 * Split out of `tests/helpers/test-isolation.test.ts`, which was already at 443
 * lines — well past the 400-line proactive-split threshold in
 * `.claude/skills/test-file-split/SKILL.md` and close to the FR-006 500-line cap
 * enforced by `scripts/check-test-file-cap.ts`.
 *
 * Both tests here guard a fix that was previously UNGUARDED: reverting the fix
 * left the rest of the suite green.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	captureFileBytes,
	setupIsolatedState,
	withIsolatedState,
} from './test-isolation.js';

afterEach(() => {
	mock.restore();
});

describe('withIsolatedState — body-error primacy (F-009)', () => {
	test("the body's error survives a THROWING cleanup", async () => {
		// `withIsolatedState` used to be `try { return await fn(state) } finally {
		// state.cleanup() }`. A throw from that finally REPLACES the body's error,
		// so a teardown failure would hide the real test failure. Biome never
		// flagged it because the throw was indirect (inside `cleanup()`), which is
		// exactly why it needs a test rather than a lint rule.
		//
		// The seam is mutated rather than mock.module'd: `mock.module` leaks across
		// files in Bun's shared test-runner process (see writing-tests SKILL.md).
		const originalRunCleanup = _internals.runCleanup;
		_internals.runCleanup = (restoreClock, envCleanup, dirCleanup) => {
			// Run the REAL cleanup first so nothing leaks, then fail like a broken
			// teardown would.
			originalRunCleanup(restoreClock, envCleanup, dirCleanup);
			throw new Error('cleanup boom');
		};

		let rejection: unknown;
		try {
			await withIsolatedState(
				async () => {
					throw new Error('fn boom');
				},
				{ prefix: 'iso-primacy-' },
			);
		} catch (error) {
			rejection = error;
		} finally {
			_internals.runCleanup = originalRunCleanup;
		}

		// The body's error wins. Under the old try/finally shape this was
		// 'cleanup boom'.
		expect((rejection as Error | undefined)?.message).toBe('fn boom');
	});

	test('a cleanup error still surfaces when the body SUCCEEDED', async () => {
		// The mirror case: primacy must not mean "cleanup errors are swallowed".
		const originalRunCleanup = _internals.runCleanup;
		_internals.runCleanup = (restoreClock, envCleanup, dirCleanup) => {
			originalRunCleanup(restoreClock, envCleanup, dirCleanup);
			throw new Error('cleanup boom');
		};

		let rejection: unknown;
		try {
			await withIsolatedState(async () => 'ok', { prefix: 'iso-primacy-ok-' });
		} catch (error) {
			rejection = error;
		} finally {
			_internals.runCleanup = originalRunCleanup;
		}

		expect((rejection as Error | undefined)?.message).toBe('cleanup boom');
	});
});

describe('captureFileBytes — single-read contract (F-014)', () => {
	test('a non-ENOENT read error propagates instead of reading as "absent"', () => {
		// `readFileIfExists` is a single guarded `readFileSync`, not
		// `existsSync` + `readFileSync`. The two-syscall form reports EVERY
		// existsSync-false path as "absent", including ones that are present but
		// unreadable — so `expectFileBytesUnchanged` would silently compare
		// against nothing.
		//
		// A self-referential symlink is the portable probe: `existsSync` follows
		// it, fails with ELOOP, and returns false, while a direct `readFileSync`
		// surfaces the real ELOOP.
		const state = setupIsolatedState({ prefix: 'iso-eloop-' });
		try {
			const loop = path.join(state.dir, 'loop');
			let created = false;
			try {
				fs.symlinkSync(loop, loop);
				created = true;
			} catch {
				// Windows without Developer Mode / SeCreateSymbolicLinkPrivilege
				// rejects symlink creation (EPERM). Nothing to assert there.
			}
			if (!created) {
				expect(created).toBe(false);
				return;
			}

			// existsSync says "absent" — the exact lie the old shape trusted.
			expect(fs.existsSync(loop)).toBe(false);
			// captureFileBytes refuses to agree with it.
			expect(() => captureFileBytes(loop)).toThrow(/ELOOP/);
		} finally {
			state.cleanup();
		}
	});
});
