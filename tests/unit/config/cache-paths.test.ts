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
	getPluginCachePaths,
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
