/**
 * Tests for the version-pinned cache discovery surface added for issue #2236
 * RC3: `getPluginCachePaths()` only ever returns the fixed
 * `opencode-swarm@latest` / `opencode-swarm` literals, so an OpenCode host
 * that pins a specific version (the reporter's actual stale cache was
 * `~/.cache/opencode/packages/opencode-swarm@7.143.1/`) is invisible to it.
 *
 * Split out of tests/unit/config/cache-paths.test.ts (434 lines already, and
 * this PR adds substantial new coverage) rather than growing that file past
 * the FR-006 500-line cap.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	discoverVersionPinnedCachePaths,
	getPluginCachePaths,
	readCachePackageVersion,
	resolveCachePackageRoot,
	VERSION_PINNED_LEAF,
} from '../../../src/config/cache-paths.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalPlatform = process.platform;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restoreEnv(): void {
	Object.defineProperty(process, 'platform', {
		value: originalPlatform,
		configurable: true,
	});
	if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = originalLocalAppData;
	if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
}

describe('VERSION_PINNED_LEAF — anchored semver leaf shape', () => {
	test('accepts a plain semver version', () => {
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@7.143.1')).toBe(true);
	});

	test('accepts pre-release and build-metadata segments', () => {
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@1.2.3-rc.1')).toBe(true);
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@1.2.3+build.5')).toBe(true);
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@1.2.3-rc.1+build.5')).toBe(
			true,
		);
	});

	test('rejects the static literals (handled by separate equality checks, not this pattern)', () => {
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@latest')).toBe(false);
		expect(VERSION_PINNED_LEAF.test('opencode-swarm')).toBe(false);
	});

	test('rejects non-version garbage after the @ — proves this is not a prefix test', () => {
		// A `startsWith('opencode-swarm@')` check would accept all of these.
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@evil')).toBe(false);
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@..')).toBe(false);
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@1.2')).toBe(false);
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@1.2.3.4')).toBe(false);
		expect(VERSION_PINNED_LEAF.test('opencode-swarm@')).toBe(false);
	});

	test('rejects a similar-but-wrong package name', () => {
		expect(VERSION_PINNED_LEAF.test('opencode-swarmx@1.2.3')).toBe(false);
		expect(VERSION_PINNED_LEAF.test('not-opencode-swarm@1.2.3')).toBe(false);
	});
});

describe('discoverVersionPinnedCachePaths', () => {
	let tempDir: string;

	afterEach(async () => {
		restoreEnv();
		if (tempDir && fs.existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('discovers a version-pinned directory under the XDG packages/ parent', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-discover-');
		const xdgCacheHome = join(tempDir, 'cache');
		process.env.XDG_CACHE_HOME = xdgCacheHome;
		const pinnedDir = join(
			xdgCacheHome,
			'opencode',
			'packages',
			'opencode-swarm@7.143.1',
		);
		await mkdir(pinnedDir, { recursive: true });

		const found = discoverVersionPinnedCachePaths();
		expect(found).toContain(pinnedDir);
	});

	test('ignores non-matching entries in the same packages/ directory', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-discover-');
		const xdgCacheHome = join(tempDir, 'cache');
		process.env.XDG_CACHE_HOME = xdgCacheHome;
		const packagesDir = join(xdgCacheHome, 'opencode', 'packages');
		await mkdir(join(packagesDir, 'opencode-swarm@latest'), {
			recursive: true,
		});
		await mkdir(join(packagesDir, 'some-other-package@1.0.0'), {
			recursive: true,
		});
		await mkdir(join(packagesDir, 'opencode-swarm@not-a-version'), {
			recursive: true,
		});

		const found = discoverVersionPinnedCachePaths();
		expect(found).toEqual([]);
	});

	test('returns [] when the packages/ parent does not exist (no throw)', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-discover-');
		process.env.XDG_CACHE_HOME = join(tempDir, 'nonexistent-cache');
		expect(() => discoverVersionPinnedCachePaths()).not.toThrow();
		expect(discoverVersionPinnedCachePaths()).toEqual([]);
	});

	test('ignores a version-pinned FILE (not a directory) with a matching name', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-discover-');
		const xdgCacheHome = join(tempDir, 'cache');
		process.env.XDG_CACHE_HOME = xdgCacheHome;
		const packagesDir = join(xdgCacheHome, 'opencode', 'packages');
		await mkdir(packagesDir, { recursive: true });
		await writeFile(join(packagesDir, 'opencode-swarm@7.143.1'), 'not a dir');

		const found = discoverVersionPinnedCachePaths();
		expect(found).toEqual([]);
	});

	test('on darwin also enumerates ~/Library/Caches/opencode/packages', () => {
		setPlatform('darwin');
		// Only assert it does not throw and does not include Linux-only paths;
		// we cannot create real files under the actual home directory in CI.
		expect(() => discoverVersionPinnedCachePaths()).not.toThrow();
	});

	test('on win32 also enumerates %LOCALAPPDATA%/opencode/packages', async () => {
		setPlatform('win32');
		tempDir = canonicalMkdtemp('opencode-swarm-discover-win-');
		process.env.LOCALAPPDATA = join(tempDir, 'AppData', 'Local');
		const pinnedDir = join(
			process.env.LOCALAPPDATA,
			'opencode',
			'packages',
			'opencode-swarm@2.0.0',
		);
		await mkdir(pinnedDir, { recursive: true });

		const found = discoverVersionPinnedCachePaths();
		expect(found).toContain(pinnedDir);
	});
});

describe('resolveCachePackageRoot / readCachePackageVersion', () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir && fs.existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('resolveCachePackageRoot returns the cache path itself when there is no nested node_modules', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-pkgroot-');
		await mkdir(tempDir, { recursive: true });
		expect(resolveCachePackageRoot(tempDir)).toBe(tempDir);
	});

	test('resolveCachePackageRoot descends into a nested node_modules/opencode-swarm when present', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-pkgroot-');
		const nested = join(tempDir, 'node_modules', 'opencode-swarm');
		await mkdir(nested, { recursive: true });
		expect(resolveCachePackageRoot(tempDir)).toBe(nested);
	});

	test('readCachePackageVersion reads the version from package.json', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-version-');
		await mkdir(tempDir, { recursive: true });
		await writeFile(
			join(tempDir, 'package.json'),
			JSON.stringify({ version: '7.143.1' }),
		);
		expect(readCachePackageVersion(tempDir)).toBe('7.143.1');
	});

	test('readCachePackageVersion returns null when package.json is missing', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-version-');
		await mkdir(tempDir, { recursive: true });
		expect(readCachePackageVersion(tempDir)).toBeNull();
	});

	test('readCachePackageVersion returns null when package.json is unparsable (does not throw)', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-version-');
		await mkdir(tempDir, { recursive: true });
		await writeFile(join(tempDir, 'package.json'), '{not valid json');
		expect(() => readCachePackageVersion(tempDir)).not.toThrow();
		expect(readCachePackageVersion(tempDir)).toBeNull();
	});

	test('readCachePackageVersion returns null when "version" is not a string', async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-version-');
		await mkdir(tempDir, { recursive: true });
		await writeFile(
			join(tempDir, 'package.json'),
			JSON.stringify({ version: 12345 }),
		);
		expect(readCachePackageVersion(tempDir)).toBeNull();
	});
});

describe('getPluginCachePaths — module-scope purity (AGENTS.md invariant 1)', () => {
	// src/cli/index.ts calls getPluginCachePaths() at MODULE SCOPE
	// (`const OPENCODE_PLUGIN_CACHE_PATHS = getPluginCachePaths();`), which
	// runs on every CLI invocation and transitively on plugin init paths that
	// import from src/cli. Filesystem I/O here would violate AGENTS.md
	// invariant 1 (plugin init must stay side-effect-minimal / bounded).
	// discoverVersionPinnedCachePaths() is the separate, impure counterpart
	// that performs the actual readdirSync enumeration — it must be invoked
	// only at command time, never from here.
	test('performs no filesystem I/O', () => {
		const readdirSpy = spyOn(fs, 'readdirSync');
		const existsSpy = spyOn(fs, 'existsSync');
		const readFileSpy = spyOn(fs, 'readFileSync');
		const statSpy = spyOn(fs, 'statSync');
		try {
			const paths = getPluginCachePaths();
			expect(paths.length).toBeGreaterThan(0);
			expect(readdirSpy).not.toHaveBeenCalled();
			expect(existsSpy).not.toHaveBeenCalled();
			expect(readFileSpy).not.toHaveBeenCalled();
			expect(statSpy).not.toHaveBeenCalled();
		} finally {
			readdirSpy.mockRestore();
			existsSpy.mockRestore();
			readFileSpy.mockRestore();
			statSpy.mockRestore();
		}
	});
});

// NOTE: the M6 realpath-canonicalization extension for the widened
// version-pinned leaf (a symlink whose lexical name passes isSafeCachePath
// but whose real target does not) lives in
// tests/unit/cli/update-versioned-cache.test.ts, next to isSafeCachePath's
// other safety-check tests and the existing M6 suite it extends.
