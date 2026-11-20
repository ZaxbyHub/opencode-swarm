import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeProjectDb } from '../../src/db/project-db.js';

/**
 * Environment variables redirected into the isolated temp dir.
 *
 * `XDG_CONFIG_HOME` is the load-bearing one: `getUserConfigDir()`
 * (src/services/config-doctor.ts) and src/config/loader.ts read it FIRST on
 * every platform, so it is what stops config-doctor's project-absent fallback
 * from reading — and rewriting — the developer's real
 * `~/.config/opencode/opencode-swarm.json`.
 *
 * `XDG_CACHE_HOME` closes a proven leak (PR #2173 F-007/F-012): it is read
 * first, on all platforms, by src/services/version-check.ts and
 * src/config/cache-paths.ts. Without it, booting the plugin in a test wrote
 * into the developer's real `~/.cache/opencode-swarm/version-check.json`.
 *
 * `HOME` and `USERPROFILE` are defence in depth ONLY. The behavior of
 * `os.homedir()` under a redirect is PLATFORM-SPLIT, verified by execution on
 * both sides (tests/unit/helpers/isolated-test-env-homedir.test.ts): on
 * Windows (Bun 1.3.14) `os.homedir()` FOLLOWS a redirected HOME/USERPROFILE
 * and returns the isolated home, while on POSIX (CI ubuntu runners; macOS is
 * the same libuv family) it does NOT — libuv resolves the passwd entry, so the
 * result stays the real home. The universal false part of the old claim (the
 * Bun 1.3.11 note asserting homedir() never reads the environment) is the
 * Windows arm.
 * On hosts where the redirect DOES take effect, a fixture whose workspace sits
 * under the isolated home can inherit a real-home `.swarm`/`.opencode` claim
 * from a home that carries them: always give dispatched fixtures an explicit
 * project marker (`.opencode` or a `.git` marker directory) inside the fixture
 * root. Never rely on these two vars ALONE to redirect a homedir()-derived
 * path under `bun test`; rely on the XDG_* / APPDATA / LOCALAPPDATA vars,
 * which every path helper in this repo consults ahead of `os.homedir()`.
 *
 * `HOMEDRIVE`/`HOMEPATH` are deliberately NOT set: a POSIX-shaped temp path is
 * not a valid `HOMEDRIVE` (`"C:"`) and would hand malformed values to any
 * cmd.exe subprocess a test spawns.
 */
export const ISOLATED_ENV_KEYS = [
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'APPDATA',
	'LOCALAPPDATA',
	'HOME',
	'USERPROFILE',
] as const;

/**
 * Creates a temp directory and redirects config, data, cache, and home
 * environment roots so all test-owned global path resolution lands in the temp
 * dir. Returns a cleanup function that restores original env vars and
 * removes the temp dir.
 */
export function createIsolatedTestEnv(): {
	configDir: string;
	cleanup: () => void;
} {
	const configDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-')),
	);

	const originalEnv = new Map<string, string | undefined>();
	for (const key of ISOLATED_ENV_KEYS) {
		originalEnv.set(key, process.env[key]);
		process.env[key] = configDir;
	}

	const cleanup = (): void => {
		for (const key of ISOLATED_ENV_KEYS) {
			const original = originalEnv.get(key);
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}

		// Remove temp directory. #2480: release the cached swarm.db handle
		// first — a held WAL lock makes Windows rmSync fail EBUSY regardless
		// of retries (closeProjectDb never throws; no-op without a handle).
		closeProjectDb(configDir);
		fs.rmSync(configDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	};

	return { configDir, cleanup };
}

/**
 * Throws immediately if the given path resolves under the user's
 * real home directory (os.homedir()) and is NOT under os.tmpdir().
 * Use as a safety check before any fs.writeFileSync / fs.rmSync in tests.
 */
export function assertSafeForWrite(targetPath: string): void {
	const resolvedPath = path.resolve(targetPath);
	const homeDir = os.homedir();
	const tmpDir = os.tmpdir();

	const resolvedHome = path.resolve(homeDir);
	const resolvedTmp = path.resolve(tmpDir);

	// Check if path is under home directory
	if (
		resolvedPath.startsWith(resolvedHome + path.sep) ||
		resolvedPath === resolvedHome
	) {
		// Check if it's also under tmpdir (allowed)
		if (
			resolvedPath.startsWith(resolvedTmp + path.sep) ||
			resolvedPath === resolvedTmp
		) {
			// Safe: it's under tmpdir even if tmpdir is under homedir
			return;
		}
		// Not safe: under homedir but not under tmpdir
		throw new Error(
			`Unsafe write target: ${targetPath} resolves to ${resolvedPath} which is under the user's home directory (${resolvedHome}) and not under os.tmpdir() (${resolvedTmp}). Use createIsolatedTestEnv() or write to os.tmpdir() instead.`,
		);
	}
}
