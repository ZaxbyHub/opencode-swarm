/**
 * The platform config directory used by this plugin.
 * Mirrors CONFIG_DIR in src/cli/index.ts.
 */
export declare function getPluginConfigDir(): string;
/**
 * All known locations where OpenCode may cache the opencode-swarm plugin.
 * Order: newest/canonical first so status reporting shows the most relevant
 * path at the top.
 */
export declare function getPluginCachePaths(): readonly string[];
/**
 * All known locations where OpenCode stores npm lock files for the plugin
 * environment. These pin the installed version of opencode-swarm and must
 * be cleared during update/install to force a fresh resolution from npm.
 */
export declare function getPluginLockFilePaths(): readonly string[];
