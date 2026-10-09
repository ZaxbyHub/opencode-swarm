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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	isSafeCachePath,
	isSafeInstallBackupPath,
	isSafeLockFilePath,
	isSafePluginConfigPath,
	isSafePromptsDir,
} from '../../../src/cli/index.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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

/** Every ancestor of `dir` up to and including the filesystem root. */
function ancestorsOf(dir: string): string[] {
	const out: string[] = [];
	let cur = dir;
	while (true) {
		out.push(cur);
		const parent = path.dirname(cur);
		if (parent === cur) return out;
		cur = parent;
	}
}

describe('cleanup guard home floor: win32 case-insensitive comparison', () => {
	// src/cli/index.ts has no platform seam: normalizePathForComparison reads
	// process.platform directly, so the win32 branch is exercised by overriding
	// that property for the duration of one assertion block and restoring it.
	function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
		const original = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', {
			value: platform,
			configurable: true,
		});
		try {
			return run();
		} finally {
			if (original) Object.defineProperty(process, 'platform', original);
		}
	}

	const upper = (p: string) => p.toUpperCase();
	const hostIsWindows = path.sep !== '/';

	// Upper-casing the WHOLE path would also break the leaf/parent shape
	// layers, so the floor's lowercasing would never be what refuses it. Build
	// a path whose shape is valid (`.../opencode/packages/opencode-swarm`) and
	// that differs from its ancestor-of-home twin only in the case of the
	// segment ABOVE the shaped part: then the floor is the only layer that can
	// refuse it.
	const SHAPED = path.resolve('/srv/opencode/packages/opencode-swarm');
	const caseVariantOfShaped = () =>
		path.join(
			path.dirname(path.dirname(path.dirname(SHAPED))).toUpperCase(),
			'opencode',
			'packages',
			'opencode-swarm',
		);

	test('on win32 a case variant that passes every shape layer is refused only by the floor', () => {
		const variant = caseVariantOfShaped();
		// Control: with a home elsewhere, the shape layers accept the variant,
		// so a refusal below can only come from the floor.
		withPlatform('win32', () => {
			expect(isSafeCachePath(variant)).toBe(true);
		});
		homedirSpy.mockReturnValue(path.join(SHAPED, 'home'));
		withPlatform('win32', () => {
			expect(isSafeCachePath(SHAPED)).toBe(false);
			expect(isSafeCachePath(variant)).toBe(false);
			expect(isSafeLockFilePath(path.join(variant, '..', 'bun.lock'))).toBe(
				false,
			);
		});
	});

	test('upper-cased home and ancestors are refused on win32', () => {
		withPlatform('win32', () => {
			for (const ancestor of ancestorsOf(LONG_HOME)) {
				const variant = upper(ancestor);
				expect(isSafeCachePath(variant)).toBe(false);
				expect(isSafeLockFilePath(variant)).toBe(false);
				expect(isSafePromptsDir(variant)).toBe(false);
				expect(isSafePluginConfigPath(variant)).toBe(false);
				expect(isSafeInstallBackupPath(variant)).toBe(false);
			}
		});
	});

	test('a legitimate cache stays accepted on win32 regardless of case', () => {
		withPlatform('win32', () => {
			const cache = path.resolve(
				'/Var/Cache/opencode/packages/opencode-swarm@latest',
			);
			expect(isSafeCachePath(cache)).toBe(true);
		});
	});

	test('on a case-sensitive platform the floor compares exactly (control)', () => {
		const variant = caseVariantOfShaped();
		homedirSpy.mockReturnValue(path.join(SHAPED, 'home'));
		// Same inputs as the win32 test above, but exact comparison: the
		// differently-cased path is NOT an ancestor of home, so it is accepted.
		withPlatform('linux', () => {
			expect(isSafeCachePath(variant)).toBe(true);
		});
	});
});

describe('cleanup guard home floor: config-artifact guards', () => {
	let cfg: string;
	let tmp: string;

	beforeEach(() => {
		tmp = canonicalMkdtemp('cleanup-floor-cfg-');
		cfg = path.join(tmp, 'opencode');
		fs.mkdirSync(path.join(cfg, 'opencode-swarm'), { recursive: true });
		fs.writeFileSync(path.join(cfg, 'opencode-swarm.json'), '{}');
		fs.writeFileSync(
			path.join(cfg, 'opencode.swarm-install-backup.json'),
			'{}',
		);
	});

	afterEach(() => {
		fs.rmSync(tmp, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	});

	const guards = [
		['isSafePromptsDir', isSafePromptsDir],
		['isSafePluginConfigPath', isSafePluginConfigPath],
		['isSafeInstallBackupPath', isSafeInstallBackupPath],
	] as const;

	test('accept only their tool-owned leaf directly under the configured root', () => {
		expect(isSafePromptsDir(path.join(cfg, 'opencode-swarm'), cfg)).toBe(true);
		expect(
			isSafePluginConfigPath(path.join(cfg, 'opencode-swarm.json'), cfg),
		).toBe(true);
		expect(
			isSafeInstallBackupPath(
				path.join(cfg, 'opencode.swarm-install-backup.json'),
				cfg,
			),
		).toBe(true);
	});

	test('refuse a wrong leaf, a wrong parent, and a sibling guard leaf', () => {
		const other = path.join(tmp, 'elsewhere');
		fs.mkdirSync(path.join(other, 'opencode-swarm'), { recursive: true });
		fs.writeFileSync(path.join(other, 'opencode-swarm.json'), '{}');
		fs.writeFileSync(
			path.join(other, 'opencode.swarm-install-backup.json'),
			'{}',
		);
		expect(isSafePromptsDir(path.join(other, 'opencode-swarm'), cfg)).toBe(
			false,
		);
		expect(
			isSafePluginConfigPath(path.join(other, 'opencode-swarm.json'), cfg),
		).toBe(false);
		expect(
			isSafeInstallBackupPath(
				path.join(other, 'opencode.swarm-install-backup.json'),
				cfg,
			),
		).toBe(false);
		// Each guard rejects the sibling artifacts' names.
		expect(isSafePromptsDir(path.join(cfg, 'opencode-swarm.json'), cfg)).toBe(
			false,
		);
		expect(isSafePluginConfigPath(path.join(cfg, 'opencode-swarm'), cfg)).toBe(
			false,
		);
		expect(
			isSafeInstallBackupPath(path.join(cfg, 'opencode-swarm.json'), cfg),
		).toBe(false);
		expect(isSafePromptsDir(path.join(cfg, 'unrelated'), cfg)).toBe(false);
	});

	test('refuse the filesystem root, home, and every ancestor of home', () => {
		for (const [name, guard] of guards) {
			for (const target of ancestorsOf(LONG_HOME)) {
				expect({ name, target, safe: guard(target) }).toEqual({
					name,
					target,
					safe: false,
				});
				expect({ name, target, safe: guard(target, target) }).toEqual({
					name,
					target,
					safe: false,
				});
			}
		}
	});

	test('refuse a shallow pathological root even with the right leaf name', () => {
		const root = path.parse(LONG_HOME).root;
		expect(isSafePromptsDir(path.join(root, 'opencode-swarm'))).toBe(false);
		expect(isSafePluginConfigPath(path.join(root, 'opencode-swarm.json'))).toBe(
			false,
		);
		expect(
			isSafeInstallBackupPath(
				path.join(root, 'opencode.swarm-install-backup.json'),
			),
		).toBe(false);
	});
});
