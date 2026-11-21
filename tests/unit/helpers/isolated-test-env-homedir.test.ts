/**
 * Issue #3381 (AC1): pin the REAL `os.homedir()` behavior under redirected
 * HOME/USERPROFILE on Bun, and force the stale docblock claim in
 * tests/helpers/isolated-test-env.ts to be corrected.
 *
 * The helper's docblock claimed (citing "Bun 1.3.11"):
 *   "`os.homedir()` ignores `process.env` entirely — mutating either one,
 *    even before the first `os.homedir()` call, does not change its result"
 *
 * That claim is wrong per-platform, verified by execution on both sides:
 *   - Windows (Bun 1.3.14, this repo's dev/CI Windows legs): `os.homedir()`
 *     FOLLOWS a redirected HOME/USERPROFILE — the result becomes the
 *     isolated temp home.
 *   - POSIX (CI ubuntu runners, Bun 1.3.x; macOS same family): `os.homedir()`
 *     does NOT follow the redirect — libuv resolves the passwd entry, so the
 *     result stays the pre-redirect real home (CI: `/home/runner`).
 *
 * The universal false part of the old claim is "ignores process.env
 * entirely": on Windows the env IS honored. This suite has two legs:
 *
 *  (a) behavior pin — pins the platform-conditional result: the redirected
 *      value on win32, the unchanged real home on POSIX. Passes at BASE and
 *      HEAD on both platform families; a future Bun change that flips the
 *      POSIX (or Windows) arm trips a loud, named failure instead of
 *      silently re-invalidating the docblock correction.
 *  (c) docblock pin — the helper's own source must no longer contain the
 *      false claim text `ignores `process.env` entirely` AND must carry the
 *      corrected platform-split guidance. This FAILS at BASE (the claim is
 *      still present) and goes green once the docblock is corrected. The
 *      file is therefore RED overall at base by design.
 *
 * The source-read assertion is deliberately textual (readFileSync +
 * indexOf) rather than import-based: the docblock is a comment, erased at
 * runtime, so the source file itself is the only observable surface.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

/** The false docblock claim substring (with its literal backticks). */
const FALSE_CLAIM = 'ignores `process.env` entirely';

describe('createIsolatedTestEnv homedir behavior pin (#3381 AC1)', () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		// createIsolatedTestEnv's cleanup restores every ISOLATED_ENV_KEYS
		// entry (HOME/USERPROFILE included) and removes the temp dir.
		cleanup?.();
		cleanup = undefined;
	});

	it('(a) os.homedir() result under the redirected env matches the verified per-platform behavior', () => {
		// Capture BEFORE the redirect so the POSIX arm has the real-home
		// baseline to compare against.
		const realHomeBefore = os.homedir();
		const env = createIsolatedTestEnv();
		cleanup = env.cleanup;
		const during = os.homedir();

		// path.resolve on both sides keeps the comparison insensitive to
		// trailing-separator / drive-case spelling.
		if (process.platform === 'win32') {
			// Verified on Bun 1.3.14/Windows (executed probe, issue #3381):
			// os.homedir() follows the redirected HOME/USERPROFILE and
			// returns the isolated temp home.
			expect(path.resolve(during)).toBe(path.resolve(env.configDir));
		} else {
			// Verified on CI ubuntu (run 44762902376, Bun 1.3.x): os.homedir()
			// does NOT follow the redirected HOME/USERPROFILE on POSIX —
			// the value stays the pre-redirect real
			// home. Pin the not-followed arm so a Bun
			// change that makes POSIX follow too (or Windows stop
			// following) trips this leg loudly.
			expect(path.resolve(during)).toBe(path.resolve(realHomeBefore));
		}
	});

	it('(c) the helper docblock no longer claims os.homedir() ignores process.env entirely', () => {
		const helperSourcePath = path.join(
			import.meta.dir,
			'../../helpers/isolated-test-env.ts',
		);
		const source = fs.readFileSync(helperSourcePath, 'utf8');

		// At base this FAILS: the stale Bun-1.3.11 claim is still in the
		// docblock. The fix rewrites the docblock to the verified
		// platform-split behavior, which removes this substring.
		const claimIndex = source.indexOf(FALSE_CLAIM);
		if (claimIndex !== -1) {
			throw new Error(
				`tests/helpers/isolated-test-env.ts still carries the false claim "${FALSE_CLAIM}" (found at index ${claimIndex}). os.homedir() does NOT ignore process.env universally (it follows the redirect on Windows; POSIX does not) — correct the docblock.`,
			);
		}
		expect(claimIndex).toBe(-1);

		// AMENDED (plan-critic round 1, CHECK_WRONG): absence alone is weak —
		// deleting the guidance entirely would pass it. The docblock must also
		// carry the POSITIVE corrected claim, so the check discriminates
		// "corrected" from "silently emptied". The fix ships this sentence
		// verbatim in the docblock.
		const CORRECTED_CLAIM = 'FOLLOWS a redirected';
		const correctedIndex = source.indexOf(CORRECTED_CLAIM);
		if (correctedIndex === -1) {
			throw new Error(
				`tests/helpers/isolated-test-env.ts does not carry the corrected guidance (expected the substring "${CORRECTED_CLAIM}" describing os.homedir()'s env-following behavior).`,
			);
		}
	});
});
