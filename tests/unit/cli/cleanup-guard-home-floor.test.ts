/**
 * Catastrophic-path floor of the CLI cleanup guards (src/cli/index.ts).
 *
 * The floor used to be `resolved.length <= home.length`, which refused any
 * target whose path was merely SHORTER than home — so a legitimate cache under
 * `XDG_CACHE_HOME=/var/cache` could never be evicted for a user with a long
 * home path (and every CLI test failed under a long HOME). The floor now
 * refuses exactly the filesystem root, home, and ancestors of home.
 *
 * os.homedir() is pinned with spyOn so the assertions do not depend on the
 * machine's real home.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSafeCachePath, isSafeLockFilePath } from '../../../src/cli/index.js';

const LONG_HOME = path.resolve(
	'/home/a-user-with-a-rather-long-home-directory-name/nested/deeper/still',
);

let homedirSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	homedirSpy = spyOn(os, 'homedir').mockReturnValue(LONG_HOME);
});

afterEach(() => {
	homedirSpy.mockRestore();
});

describe('cleanup guard home floor', () => {
	test('accepts a cache under a short XDG root when home is longer', () => {
		const cache = path.resolve(
			'/var/cache/opencode/packages/opencode-swarm@latest',
		);
		expect(cache.length).toBeLessThan(LONG_HOME.length);
		expect(isSafeCachePath(cache)).toBe(true);
		expect(
			isSafeLockFilePath(path.resolve('/var/cache/opencode/bun.lock')),
		).toBe(true);
	});

	test('still refuses root, home, and every ancestor of home', () => {
		expect(isSafeCachePath(path.parse(LONG_HOME).root)).toBe(false);
		let dir = LONG_HOME;
		while (dir !== path.dirname(dir)) {
			expect(isSafeCachePath(dir)).toBe(false);
			expect(isSafeLockFilePath(dir)).toBe(false);
			dir = path.dirname(dir);
		}
	});

	test('a sibling of home that shares its prefix is not an ancestor', () => {
		// `/home/a-user...` must not treat `/home/a-use` as an ancestor just
		// because the strings share a prefix; the shape layers still apply.
		const sibling = path.resolve(
			'/home/a-use/.cache/opencode/packages/opencode-swarm',
		);
		expect(isSafeCachePath(sibling)).toBe(true);
	});

	test('the shape layers still reject a short non-cache path', () => {
		expect(
			isSafeCachePath(path.resolve('/var/cache/opencode/packages/evil')),
		).toBe(false);
	});
});
