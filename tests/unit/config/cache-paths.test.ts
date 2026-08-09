/**
 * Tests for cache-paths.ts — verifies that getPluginCachePaths() and
 * getPluginLockFilePaths() emit the right set of paths for each platform.
 *
 * Linux CI cannot create real macOS/Windows paths, so platform-specific
 * branches are validated by mocking process.platform via Object.defineProperty.
 * The original platform value is restored in afterEach to prevent leakage.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	getHostConfigDir,
	getHostDataDir,
	getHostSkillCacheDir,
	getPluginCachePaths,
	getPluginConfigDir,
	getPluginLockFilePaths,
} from '../../../src/config/cache-paths.js';

const originalPlatform = process.platform;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalAppData = process.env.APPDATA;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', {
		value,
		configurable: true,
	});
}

function restorePlatform(): void {
	Object.defineProperty(process, 'platform', {
		value: originalPlatform,
		configurable: true,
	});
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

describe('getPluginCachePaths', () => {
	afterEach(() => {
		restorePlatform();
		restoreEnv('LOCALAPPDATA', originalLocalAppData);
		restoreEnv('APPDATA', originalAppData);
		restoreEnv('XDG_CACHE_HOME', originalXdgCacheHome);
		restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome);
	});

	test('on linux returns exactly 3 XDG paths and no platform-specific paths', () => {
		setPlatform('linux');
		const paths = getPluginCachePaths();
		expect(paths.length).toBe(3);
		// No darwin or win32 paths
		for (const p of paths) {
			expect(p).not.toContain('Library/Caches');
			expect(p).not.toContain('AppData');
		}
		// All three XDG layouts present
		expect(
			paths.some((p) =>
				p.endsWith(path.join('node_modules', 'opencode-swarm')),
			),
		).toBe(true);
		expect(paths.some((p) => p.endsWith('opencode-swarm@latest'))).toBe(true);
	});

	test('on darwin adds ~/Library/Caches paths', () => {
		setPlatform('darwin');
		const paths = getPluginCachePaths();
		const home = os.homedir();
		const libCaches = path.join(home, 'Library', 'Caches');
		expect(
			paths.some(
				(p) =>
					p ===
					path.join(libCaches, 'opencode', 'node_modules', 'opencode-swarm'),
			),
		).toBe(true);
		expect(
			paths.some(
				(p) =>
					p ===
					path.join(libCaches, 'opencode', 'packages', 'opencode-swarm@latest'),
			),
		).toBe(true);
	});

	test('on win32 adds %LOCALAPPDATA% paths when env is set', () => {
		setPlatform('win32');
		process.env.LOCALAPPDATA = 'C:/Users/test/AppData/Local';
		process.env.APPDATA = 'C:/Users/test/AppData/Roaming';
		const paths = getPluginCachePaths();
		expect(
			paths.some(
				(p) =>
					p ===
					path.join(
						'C:/Users/test/AppData/Local',
						'opencode',
						'node_modules',
						'opencode-swarm',
					),
			),
		).toBe(true);
		expect(
			paths.some(
				(p) =>
					p ===
					path.join(
						'C:/Users/test/AppData/Local',
						'opencode',
						'packages',
						'opencode-swarm@latest',
					),
			),
		).toBe(true);
		expect(
			paths.some(
				(p) =>
					p ===
					path.join(
						'C:/Users/test/AppData/Roaming',
						'opencode',
						'node_modules',
						'opencode-swarm',
					),
			),
		).toBe(true);
	});

	test('on win32 falls back to ~/AppData/Local when LOCALAPPDATA is unset', () => {
		setPlatform('win32');
		delete process.env.LOCALAPPDATA;
		delete process.env.APPDATA;
		const paths = getPluginCachePaths();
		const home = os.homedir();
		const fallbackLocal = path.join(home, 'AppData', 'Local');
		const fallbackRoaming = path.join(home, 'AppData', 'Roaming');
		expect(
			paths.some(
				(p) =>
					p ===
					path.join(
						fallbackLocal,
						'opencode',
						'node_modules',
						'opencode-swarm',
					),
			),
		).toBe(true);
		expect(
			paths.some(
				(p) =>
					p ===
					path.join(
						fallbackRoaming,
						'opencode',
						'node_modules',
						'opencode-swarm',
					),
			),
		).toBe(true);
	});

	test('on win32 falls back to ~/AppData/Roaming when APPDATA is unset', () => {
		setPlatform('win32');
		process.env.LOCALAPPDATA = 'C:/custom/local';
		delete process.env.APPDATA;
		const paths = getPluginCachePaths();
		const home = os.homedir();
		const fallbackRoaming = path.join(home, 'AppData', 'Roaming');
		expect(
			paths.some(
				(p) =>
					p ===
					path.join(
						fallbackRoaming,
						'opencode',
						'node_modules',
						'opencode-swarm',
					),
			),
		).toBe(true);
	});
});

describe('getPluginLockFilePaths', () => {
	afterEach(() => {
		restorePlatform();
		restoreEnv('LOCALAPPDATA', originalLocalAppData);
		restoreEnv('APPDATA', originalAppData);
		restoreEnv('XDG_CACHE_HOME', originalXdgCacheHome);
		restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome);
	});

	test('on linux returns exactly 3 XDG/legacy lock paths', () => {
		setPlatform('linux');
		const paths = getPluginLockFilePaths();
		expect(paths.length).toBe(3);
		// Should include bun.lock, bun.lockb, package-lock.json
		const basenames = paths.map((p) => path.basename(p));
		expect(basenames).toContain('bun.lock');
		expect(basenames).toContain('bun.lockb');
		expect(basenames).toContain('package-lock.json');
		// No platform-specific paths
		for (const p of paths) {
			expect(p).not.toContain('Library/Caches');
			expect(p).not.toContain('AppData');
		}
	});

	test('on darwin adds ~/Library/Caches lock paths', () => {
		setPlatform('darwin');
		const paths = getPluginLockFilePaths();
		const home = os.homedir();
		const libCaches = path.join(home, 'Library', 'Caches');
		expect(
			paths.some((p) => p === path.join(libCaches, 'opencode', 'bun.lock')),
		).toBe(true);
		expect(
			paths.some((p) => p === path.join(libCaches, 'opencode', 'bun.lockb')),
		).toBe(true);
	});

	test('on win32 adds %LOCALAPPDATA% lock paths when env is set', () => {
		setPlatform('win32');
		process.env.LOCALAPPDATA = 'C:/Users/test/AppData/Local';
		const paths = getPluginLockFilePaths();
		expect(
			paths.some(
				(p) =>
					p ===
					path.join('C:/Users/test/AppData/Local', 'opencode', 'bun.lock'),
			),
		).toBe(true);
		expect(
			paths.some(
				(p) =>
					p ===
					path.join('C:/Users/test/AppData/Local', 'opencode', 'bun.lockb'),
			),
		).toBe(true);
	});

	test('on win32 falls back to ~/AppData/Local when LOCALAPPDATA is unset', () => {
		setPlatform('win32');
		delete process.env.LOCALAPPDATA;
		const paths = getPluginLockFilePaths();
		const home = os.homedir();
		const fallbackLocal = path.join(home, 'AppData', 'Local');
		expect(
			paths.some((p) => p === path.join(fallbackLocal, 'opencode', 'bun.lock')),
		).toBe(true);
	});
});

describe('getHostConfigDir — precedence (worktree-lane allowlist only)', () => {
	const saved = {
		OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	};

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	test('OPENCODE_CONFIG_DIR wins when set', () => {
		// Verbatim host precedence (opencode 1.18.10, offset 107379448):
		//   config: e.OPENCODE_CONFIG_DIR ?? G.config
		process.env.OPENCODE_CONFIG_DIR = path.join(
			os.tmpdir(),
			'custom-oc-config',
		);
		expect(getHostConfigDir()).toBe(path.join(os.tmpdir(), 'custom-oc-config'));
	});

	test('falls back to the XDG/plugin config dir when unset', () => {
		delete process.env.OPENCODE_CONFIG_DIR;
		expect(getHostConfigDir()).toBe(getPluginConfigDir());
	});

	test('an empty or whitespace OPENCODE_CONFIG_DIR is ignored', () => {
		for (const bogus of ['', '   ']) {
			process.env.OPENCODE_CONFIG_DIR = bogus;
			expect(getHostConfigDir()).toBe(getPluginConfigDir());
		}
	});

	test('getPluginConfigDir keeps its shared semantics (ignores the env var)', () => {
		// src/cli/index.ts and src/services/diagnose-service.ts depend on this
		// function meaning "the XDG plugin config dir"; only the lane allowlist
		// wants the host override.
		process.env.OPENCODE_CONFIG_DIR = path.join(os.tmpdir(), 'other-config');
		expect(getPluginConfigDir()).not.toBe(process.env.OPENCODE_CONFIG_DIR);
	});
});

describe('getHostDataDir — precedence (worktree-lane allowlist only)', () => {
	const saved = {
		XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	};

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	// Every assertion below builds the expected value from a LITERAL join rather
	// than by calling getHostDataDir() again. Calling the function on both sides
	// passes for any implementation, including a wrong one — which is how the
	// missing XDG_DATA_HOME branch survived a mutation run.

	test('XDG_DATA_HOME wins when set', () => {
		// Verbatim host source (opencode 1.18.10, offset ~107378334):
		//   V = R.XDG_DATA_HOME || (X ? Z.join(X, ".local", "share") : undefined)
		//   An.data = H.join(V, "opencode")
		const xdg = path.join(os.tmpdir(), 'custom-xdg-data');
		process.env.XDG_DATA_HOME = xdg;
		expect(getHostDataDir()).toBe(path.join(xdg, 'opencode'));
	});

	test('falls back to ~/.local/share/opencode when unset', () => {
		delete process.env.XDG_DATA_HOME;
		expect(getHostDataDir()).toBe(
			path.join(os.homedir(), '.local', 'share', 'opencode'),
		);
	});

	test('an empty XDG_DATA_HOME falls back (empty string is falsy, as in the host)', () => {
		process.env.XDG_DATA_HOME = '';
		expect(getHostDataDir()).toBe(
			path.join(os.homedir(), '.local', 'share', 'opencode'),
		);
	});

	test('a whitespace XDG_DATA_HOME is honoured verbatim (host uses ||, not trim)', () => {
		// Deliberately asserting the host's actual semantics rather than a nicer
		// one: `||` treats "   " as truthy, so the host would use it too. If we
		// diverged here our rule text would stop matching the host's asked text.
		process.env.XDG_DATA_HOME = '   ';
		expect(getHostDataDir()).toBe(path.join('   ', 'opencode'));
	});

	test('there is no OPENCODE_DATA_DIR override (unlike the config dir)', () => {
		delete process.env.XDG_DATA_HOME;
		(process.env as Record<string, string>).OPENCODE_DATA_DIR = path.join(
			os.tmpdir(),
			'should-be-ignored',
		);
		try {
			expect(getHostDataDir()).toBe(
				path.join(os.homedir(), '.local', 'share', 'opencode'),
			);
		} finally {
			delete (process.env as Record<string, string>).OPENCODE_DATA_DIR;
		}
	});

	test('the data dir is NOT the config dir (they are independently derived)', () => {
		delete process.env.XDG_DATA_HOME;
		expect(getHostDataDir()).not.toBe(getHostConfigDir());
	});
});

describe('getHostSkillCacheDir — URL-skill cache root', () => {
	const saved = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	// Expected values are built from LITERAL joins, never by calling the
	// function on both sides — the mistake that let a missing XDG branch survive
	// a mutation run for getHostDataDir.

	test('XDG_CACHE_HOME wins when set', () => {
		// Verbatim host source (opencode 1.18.10, offset 107378747):
		//   p = XDG_CACHE_HOME || join(homedir(), '.cache')
		//   i = join(p, 'opencode')          -> Global.Path.cache
		// and the skill cache root is join(cache, 'skills') (offset 102988349).
		const xdg = path.join(os.tmpdir(), 'custom-xdg-cache');
		process.env.XDG_CACHE_HOME = xdg;
		expect(getHostSkillCacheDir()).toBe(path.join(xdg, 'opencode', 'skills'));
	});

	test('falls back to ~/.cache/opencode/skills when unset', () => {
		delete process.env.XDG_CACHE_HOME;
		expect(getHostSkillCacheDir()).toBe(
			path.join(os.homedir(), '.cache', 'opencode', 'skills'),
		);
	});

	test('an empty XDG_CACHE_HOME falls back (empty string is falsy, as in the host)', () => {
		process.env.XDG_CACHE_HOME = '';
		expect(getHostSkillCacheDir()).toBe(
			path.join(os.homedir(), '.cache', 'opencode', 'skills'),
		);
	});

	test('it is a strict SUBdirectory of the cache root, never the root itself', () => {
		// Global.Path.bin = join(cache,'bin') is host-executed, so the parent must
		// never be what this returns.
		delete process.env.XDG_CACHE_HOME;
		const skills = getHostSkillCacheDir();
		const parent = path.dirname(skills);
		expect(path.basename(skills)).toBe('skills');
		expect(parent).toBe(path.join(os.homedir(), '.cache', 'opencode'));
		expect(skills).not.toBe(parent);
	});

	test('the cache dir is independent of the data and config dirs', () => {
		delete process.env.XDG_CACHE_HOME;
		expect(getHostSkillCacheDir()).not.toBe(getHostDataDir());
		expect(getHostSkillCacheDir()).not.toBe(getHostConfigDir());
	});
});
