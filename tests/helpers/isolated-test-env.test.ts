import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveHiveDataDir } from '../../src/knowledge/hive-paths';
import {
	assertSafeForWrite,
	createIsolatedTestEnv,
	ISOLATED_ENV_KEYS,
} from './isolated-test-env';

describe('isolated-test-env', () => {
	describe('createIsolatedTestEnv', () => {
		test('returns a temp dir that exists', () => {
			const { configDir, cleanup } = createIsolatedTestEnv();

			expect(fs.existsSync(configDir)).toBe(true);
			expect(configDir).toContain(os.tmpdir());

			cleanup();
		});

		test('XDG_CONFIG_HOME is set to the temp dir while active', () => {
			const { configDir, cleanup } = createIsolatedTestEnv();

			expect(process.env.XDG_CONFIG_HOME).toBe(configDir);

			cleanup();
		});

		test('XDG_DATA_HOME is set to the temp dir while active', () => {
			const { configDir, cleanup } = createIsolatedTestEnv();

			expect(process.env.XDG_DATA_HOME).toBe(configDir);

			cleanup();
		});

		test('hive data resolves below the isolated temp dir', () => {
			const { configDir, cleanup } = createIsolatedTestEnv();

			const relative = path.relative(configDir, resolveHiveDataDir());
			expect(relative.startsWith('..')).toBe(false);
			expect(path.isAbsolute(relative)).toBe(false);

			cleanup();
		});

		test('On Windows: APPDATA is also redirected', () => {
			const { configDir, cleanup } = createIsolatedTestEnv();

			expect(process.env.APPDATA).toBe(configDir);

			cleanup();
		});

		test('LOCALAPPDATA is also redirected', () => {
			const { configDir, cleanup } = createIsolatedTestEnv();

			expect(process.env.LOCALAPPDATA).toBe(configDir);

			cleanup();
		});

		test('HOME is also redirected', () => {
			const { configDir, cleanup } = createIsolatedTestEnv();

			expect(process.env.HOME).toBe(configDir);

			cleanup();
		});

		test('After cleanup(), original env vars are restored', () => {
			// Save originals
			const originalXDG = process.env.XDG_CONFIG_HOME;
			const originalXDGData = process.env.XDG_DATA_HOME;
			const originalAPPDATA = process.env.APPDATA;
			const originalLOCALAPPDATA = process.env.LOCALAPPDATA;
			const originalHOME = process.env.HOME;

			const { cleanup } = createIsolatedTestEnv();
			const newXDG = process.env.XDG_CONFIG_HOME;
			const newXDGData = process.env.XDG_DATA_HOME;
			const newAPPDATA = process.env.APPDATA;
			const newLOCALAPPDATA = process.env.LOCALAPPDATA;
			const newHOME = process.env.HOME;

			// Verify they changed
			expect(newXDG).not.toBe(originalXDG);
			expect(newXDGData).not.toBe(originalXDGData);
			expect(newAPPDATA).not.toBe(originalAPPDATA);
			expect(newLOCALAPPDATA).not.toBe(originalLOCALAPPDATA);
			expect(newHOME).not.toBe(originalHOME);

			cleanup();

			// After cleanup, original values should be restored
			expect(process.env.XDG_CONFIG_HOME).toBe(originalXDG);
			expect(process.env.XDG_DATA_HOME).toBe(originalXDGData);
			expect(process.env.APPDATA).toBe(originalAPPDATA);
			expect(process.env.LOCALAPPDATA).toBe(originalLOCALAPPDATA);
			expect(process.env.HOME).toBe(originalHOME);
		});

		test('After cleanup(), env vars that were originally undefined are deleted', () => {
			// Save originals
			const originalXDG = process.env.XDG_CONFIG_HOME;
			const originalXDGData = process.env.XDG_DATA_HOME;
			const originalAPPDATA = process.env.APPDATA;
			const originalLOCALAPPDATA = process.env.LOCALAPPDATA;
			const originalHOME = process.env.HOME;

			// Ensure env vars are undefined for this test
			delete process.env.XDG_CONFIG_HOME;
			delete process.env.XDG_DATA_HOME;
			delete process.env.APPDATA;
			delete process.env.LOCALAPPDATA;
			delete process.env.HOME;

			const { cleanup } = createIsolatedTestEnv();

			// Verify they are set
			expect(process.env.XDG_CONFIG_HOME).toBeDefined();
			expect(process.env.XDG_DATA_HOME).toBeDefined();
			expect(process.env.APPDATA).toBeDefined();
			expect(process.env.LOCALAPPDATA).toBeDefined();
			expect(process.env.HOME).toBeDefined();

			cleanup();

			// After cleanup, undefined vars should be deleted (not set to "undefined" string)
			// Check that they are truly deleted (not present in env)
			if (originalXDG === undefined) {
				expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
			}
			if (originalXDGData === undefined) {
				expect(process.env.XDG_DATA_HOME).toBeUndefined();
			}
			if (originalAPPDATA === undefined) {
				expect(process.env.APPDATA).toBeUndefined();
			}
			if (originalLOCALAPPDATA === undefined) {
				expect(process.env.LOCALAPPDATA).toBeUndefined();
			}
			if (originalHOME === undefined) {
				expect(process.env.HOME).toBeUndefined();
			}

			// Restore original state
			if (originalXDG !== undefined) process.env.XDG_CONFIG_HOME = originalXDG;
			if (originalXDGData !== undefined)
				process.env.XDG_DATA_HOME = originalXDGData;
			if (originalAPPDATA !== undefined) process.env.APPDATA = originalAPPDATA;
			if (originalLOCALAPPDATA !== undefined)
				process.env.LOCALAPPDATA = originalLOCALAPPDATA;
			if (originalHOME !== undefined) process.env.HOME = originalHOME;
		});

		test('every ISOLATED_ENV_KEYS entry is redirected, then restored (F-007/F-012)', () => {
			// The per-key tests above enumerate five of the seven keys by hand, so
			// dropping a key from the list is invisible to them. XDG_CACHE_HOME is
			// the proven case: without it, booting the plugin in a test re-created
			// the developer's REAL ~/.cache/opencode-swarm/version-check.json with
			// zero test failures (PR #2173 F-007/F-012). This asserts the WHOLE
			// list, and pins its exact membership so a silent removal fails here.
			expect([...ISOLATED_ENV_KEYS]).toEqual([
				'XDG_CONFIG_HOME',
				'XDG_DATA_HOME',
				'XDG_CACHE_HOME',
				'APPDATA',
				'LOCALAPPDATA',
				'HOME',
				'USERPROFILE',
			]);

			const originals = new Map<string, string | undefined>(
				ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
			);

			const { configDir, cleanup } = createIsolatedTestEnv();
			try {
				for (const key of ISOLATED_ENV_KEYS) {
					expect(`${key}=${process.env[key]}`).toBe(`${key}=${configDir}`);
				}
			} finally {
				cleanup();
			}

			for (const key of ISOLATED_ENV_KEYS) {
				expect(`${key}=${process.env[key]}`).toBe(
					`${key}=${originals.get(key)}`,
				);
			}
		});

		test('After cleanup(), the temp dir is removed', () => {
			const { configDir, cleanup } = createIsolatedTestEnv();
			const savedConfigDir = configDir;

			cleanup();

			expect(fs.existsSync(savedConfigDir)).toBe(false);
		});
	});

	describe('assertSafeForWrite', () => {
		test('throws for path.join(os.homedir(), ".config", "opencode", "opencode-swarm.json")', () => {
			const targetPath = path.join(
				os.homedir(),
				'.config',
				'opencode',
				'opencode-swarm.json',
			);

			expect(() => assertSafeForWrite(targetPath)).toThrow();
		});

		test('throws for path.join(os.homedir(), ".config", "opencode", "config.json")', () => {
			const targetPath = path.join(
				os.homedir(),
				'.config',
				'opencode',
				'config.json',
			);

			expect(() => assertSafeForWrite(targetPath)).toThrow();
		});

		test('does NOT throw for path.join(os.tmpdir(), "swarm-test-abc", "config.json")', () => {
			const targetPath = path.join(
				os.tmpdir(),
				'swarm-test-abc',
				'config.json',
			);

			// Should not throw
			expect(() => assertSafeForWrite(targetPath)).not.toThrow();
		});

		test('handles Windows backslash paths correctly', () => {
			// Test with explicit Windows-style path under actual homedir
			const homeDir = os.homedir();
			const targetPath = path.join(
				homeDir,
				'.config',
				'opencode',
				'config.json',
			);

			// On Windows, this should use backslash separator but resolve correctly
			expect(() => assertSafeForWrite(targetPath)).toThrow();
		});

		test('allows paths under tmpdir even on Windows', () => {
			// Create a temp subdirectory and test
			const tempSubdir = path.join(os.tmpdir(), 'swarm-test-allowed-123');
			fs.mkdirSync(tempSubdir, { recursive: true });

			try {
				const targetPath = path.join(tempSubdir, 'config.json');
				expect(() => assertSafeForWrite(targetPath)).not.toThrow();
			} finally {
				fs.rmSync(tempSubdir, { recursive: true, force: true });
			}
		});

		test('throws for paths that resolve to home but not tmpdir', () => {
			// Construct a path that is under homedir
			const targetPath = path.join(os.homedir(), 'some-app-data', 'file.json');

			expect(() => assertSafeForWrite(targetPath)).toThrow();
		});
	});
});
