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
