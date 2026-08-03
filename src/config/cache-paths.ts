/**
 * Shared plugin-cache path definitions.
 *
 * This module exports the canonical list of filesystem locations where OpenCode
 * may cache the opencode-swarm npm plugin. Both the CLI (evictPluginCaches in
 * src/cli/index.ts) and the diagnostics service (getDiagnoseData in
 * src/services/diagnose-service.ts) read from this list so they stay in sync.
 *
 * OpenCode caches plugins in three layouts depending on host and version:
 * 1. XDG packages cache (some macOS + Windows OpenCode installs ≤ v20):
 *    `<XDG_CACHE_HOME or ~/.cache>/opencode/packages/opencode-swarm@latest/`
 * 2. Legacy XDG config node_modules (older OpenCode installs ≤ v19):
 *    `<XDG_CONFIG_HOME or ~/.config>/opencode/node_modules/opencode-swarm/`
 * 3. CANONICAL XDG cache node_modules (current OpenCode v20+, all platforms,
 *    documented at https://opencode.ai/docs/plugins/):
 *    `<XDG_CACHE_HOME or ~/.cache>/opencode/node_modules/opencode-swarm/`
 *
 * Lock files (bun.lock, bun.lockb, package-lock.json) live alongside the
 * cache and pin which plugin version is installed. They are exposed via
 * getPluginLockFilePaths() and cleared during update/install.
 */
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The platform config directory used by this plugin.
 * Mirrors CONFIG_DIR in src/cli/index.ts.
 */
export function getPluginConfigDir(): string {
	return path.join(
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
		'opencode',
	);
}

/**
 * The config directory the OpenCode HOST is actually using, honouring
 * `OPENCODE_CONFIG_DIR`.
 *
 * Verbatim host precedence (`C:\OpenCode\opencode.exe`, opencode 1.18.10,
 * offset 107379448):
 *
 * ```js
 * function y(N={}){return{home:G.home,data:G.data,cache:G.cache,
 *   config:e.OPENCODE_CONFIG_DIR??G.config, ...}}
 * ```
 *
 * This is deliberately SEPARATE from {@link getPluginConfigDir}, which has
 * shared semantics relied on by `src/cli/index.ts` and
 * `src/services/diagnose-service.ts` for locating plugin caches and lock files.
 * Changing that function's meaning would move those consumers too.
 *
 * Only the worktree-lane permission allowlist uses this: under
 * `OPENCODE_CONFIG_DIR` the two directories differ, and allowlisting the wrong
 * one grants a directory the host is not reading while denying the one it is.
 */
export function getHostConfigDir(): string {
	const override = process.env.OPENCODE_CONFIG_DIR;
	if (override && override.trim() !== '') return override;
	return getPluginConfigDir();
}

/**
 * The data directory the OpenCode HOST uses.
 *
 * Verbatim host source (opencode 1.18.10, offset ~107378180):
 *   `V = XDG_DATA_HOME || join(homedir(), ".local", "share")`
 *   `U = join(V, "opencode")`   -> `Global.Path.data`
 *
 * Unlike `config`, the data path has no environment override: the `y()` service
 * factory passes `data: G.data` straight through (offset 107379448).
 *
 * Used by the worktree-lane allowlist to re-grant `<data>/plans`, which the
 * host natively allows to its `plan` agent.
 */
export function getHostDataDir(): string {
	const base =
		process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
	return path.join(base, 'opencode');
}

/**
 * The cache directory the OpenCode HOST uses (`Global.Path.cache`).
 *
 * Verbatim host source (opencode 1.18.10, offset 107378747):
 *   `p = XDG_CACHE_HOME || join(homedir(), ".cache")`
 *   `i = join(p, "opencode")`   -> `An.cache`
 *
 * Like `data`, there is no environment override beyond XDG.
 *
 * Not exported: the same object defines `bin: join(i, "bin")` — a directory the
 * host creates at startup and EXECUTES from — so granting this directory
 * wholesale would place executable code inside a write grant. Keeping it
 * module-private means it cannot be imported and granted directly; callers take
 * a specific subdirectory instead (see {@link getHostSkillCacheDir}).
 *
 * This is a speed bump, not a boundary: `getPluginCachePaths` and
 * `getPluginLockFilePaths` below already inline the identical
 * `XDG_CACHE_HOME || join(homedir(), '.cache')` expression, so the value is
 * trivially reconstructible inside this file.
 */
function getHostCacheDir(): string {
	const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
	return path.join(base, 'opencode');
}

/**
 * Where OpenCode caches URL-sourced skills (`skills.urls`).
 *
 * Both discovery implementations agree on the root:
 *   v1 (offset 102988349): `join(Global.Path.cache, "skills")`
 *   v2 (offset 103375250): `resolve(cache, "skills", Bun.hash(url))` — a
 *                          per-URL subdirectory of the same root.
 *
 * Pure path construction, no I/O and no network: the pull itself is the host's
 * job, and the plugin only needs to know where the result lands.
 */
export function getHostSkillCacheDir(): string {
	return path.join(getHostCacheDir(), 'skills');
}

/**
 * All known locations where OpenCode may cache the opencode-swarm plugin.
 * Order: newest/canonical first so status reporting shows the most relevant
 * path at the top.
 */
export function getPluginCachePaths(): readonly string[] {
	const cacheBase =
		process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
	const configDir = getPluginConfigDir();
	const paths: string[] = [
		path.join(cacheBase, 'opencode', 'node_modules', 'opencode-swarm'),
		path.join(cacheBase, 'opencode', 'packages', 'opencode-swarm@latest'),
		path.join(configDir, 'node_modules', 'opencode-swarm'),
	];
	if (process.platform === 'darwin') {
		const libCaches = path.join(os.homedir(), 'Library', 'Caches');
		paths.push(
			path.join(libCaches, 'opencode', 'node_modules', 'opencode-swarm'),
			path.join(libCaches, 'opencode', 'packages', 'opencode-swarm@latest'),
		);
	}
	if (process.platform === 'win32') {
		const localAppData =
			process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
		const appData =
			process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		paths.push(
			path.join(localAppData, 'opencode', 'node_modules', 'opencode-swarm'),
			path.join(localAppData, 'opencode', 'packages', 'opencode-swarm@latest'),
			path.join(appData, 'opencode', 'node_modules', 'opencode-swarm'),
		);
	}
	return paths;
}

/**
 * All known locations where OpenCode stores npm lock files for the plugin
 * environment. These pin the installed version of opencode-swarm and must
 * be cleared during update/install to force a fresh resolution from npm.
 */
export function getPluginLockFilePaths(): readonly string[] {
	const cacheBase =
		process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
	const configDir = getPluginConfigDir();
	const paths: string[] = [
		path.join(cacheBase, 'opencode', 'bun.lock'),
		path.join(cacheBase, 'opencode', 'bun.lockb'),
		path.join(configDir, 'package-lock.json'),
	];
	if (process.platform === 'darwin') {
		const libCaches = path.join(os.homedir(), 'Library', 'Caches');
		paths.push(
			path.join(libCaches, 'opencode', 'bun.lock'),
			path.join(libCaches, 'opencode', 'bun.lockb'),
		);
	}
	if (process.platform === 'win32') {
		const localAppData =
			process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
		paths.push(
			path.join(localAppData, 'opencode', 'bun.lock'),
			path.join(localAppData, 'opencode', 'bun.lockb'),
		);
	}
	return paths;
}
