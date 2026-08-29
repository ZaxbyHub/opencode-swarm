#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../../package.json' with { type: 'json' };
import {
	COMMAND_REGISTRY,
	resolveCommand,
	VALID_COMMANDS,
} from '../commands/registry.js';
import {
	discoverVersionPinnedCachePaths,
	getPluginCachePaths,
	getPluginConfigDir,
	getPluginLockFilePaths,
	readCachePackageVersion,
	VERSION_PINNED_LEAF,
} from '../config/cache-paths.js';
import { DEFAULT_AGENT_CONFIGS } from '../config/constants.js';
import { safeRealpathSync } from '../tools/repo-graph/safe-realpath.js';

const { version } = packageJson;

// Two levels up, NOT one. This module lives one directory deeper than the main
// plugin entry: the CLI builds to `<root>/dist/cli/index.js` (`bun build
// src/cli/index.ts --outdir dist/cli`) and runs from `<root>/src/cli/index.ts`
// in dev, whereas `src/index.ts` builds to `<root>/dist/index.js`. Copying that
// module's single `'..'` here would resolve to `<root>/dist` (or `<root>/src`),
// which silently breaks every consumer: the bundled-skill sync would look for a
// nonexistent `<root>/dist/.opencode/skills` and no-op, and `gate-audit` would
// override its correct DEFAULT_PACKAGE_ROOT with a path that hard-throws ENOENT.
// Matches resolvePackageRoot (src/commands/gate-audit.ts) and
// resolvePackageRootFromModule (src/commands/memory.ts), which both special-case
// a `cli`/`commands` leaf with two `'..'`.
const PACKAGE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
);

const CONFIG_DIR = getPluginConfigDir();

const OPENCODE_CONFIG_PATH = path.join(CONFIG_DIR, 'opencode.json');
const PLUGIN_CONFIG_PATH = path.join(CONFIG_DIR, 'opencode-swarm.json');
const PROMPTS_DIR = path.join(CONFIG_DIR, 'opencode-swarm');

const OPENCODE_PLUGIN_CACHE_PATHS = getPluginCachePaths();
const OPENCODE_PLUGIN_LOCK_FILE_PATHS = getPluginLockFilePaths();

// Safety floor: refuse to recursively delete a path that could catastrophically
// damage the user's filesystem if XDG_CACHE_HOME or XDG_CONFIG_HOME are
// pathologically set (e.g., XDG_CACHE_HOME='/'). Defense in depth, four checks:
//   1. Refuse root, home, or shorter-than-home paths.
//   2. Require ≥ 4 path components from root (the canonical cache layout has
//      AT LEAST: <root>/opencode/{packages|node_modules}/<leaf> = 3 segments,
//      so any LEGITIMATE cache lives at least one segment deeper. This rejects
//      XDG_CACHE_HOME='/' which produces '/opencode/node_modules/opencode-swarm'
//      (3 segments) while accepting XDG_CACHE_HOME='/var/cache' (5+ segments)
//      AND tmpdir-based test paths on every CI platform.
//   3. Require a recognized leaf name ('opencode-swarm', 'opencode-swarm@latest',
//      or an anchored version-pinned shape 'opencode-swarm@<semver>' — issue #2236 RC3).
//   4. Require the canonical OpenCode plugin structure as the parent chain:
//      .../opencode/{packages|node_modules}/<leaf>. This prevents any pattern
//      that happens to have a recognized leaf but isn't the actual cache.
/**
 * Count path components BELOW the filesystem root, platform-agnostically.
 *
 * `path.resolve()` prefixes a drive letter on Windows (e.g. `C:\`), which a
 * plain `resolved.split(path.sep).filter(Boolean)` would count as an extra
 * segment — inflating a POSIX-style `/opencode/opencode-swarm` (2 real
 * components) to 3 on Windows and silently defeating a "too shallow" depth
 * floor there (Windows-only merge-queue CI failure, PR #1831). Stripping
 * `path.parse().root` (which is `/` on POSIX and e.g. `C:\` on Windows) makes
 * both platforms count the same real components. On POSIX this returns exactly
 * what the old filter produced (the leading empty segment was already dropped),
 * so it is behavior-preserving there.
 */
function segmentDepthBelowRoot(resolved: string): number {
	const { root } = path.parse(resolved);
	return resolved
		.slice(root.length)
		.split(path.sep)
		.filter((s) => s.length > 0).length;
}

// Issue #675 hardening — round 3 (depth-based guard replaces home-containment
// after critic's cross-platform CI regression finding).
export function isSafeCachePath(p: string): boolean {
	const resolved = path.resolve(p);
	const home = path.resolve(os.homedir());
	// 1. Catastrophic-path floor.
	if (resolved === '/' || resolved === home || resolved.length <= home.length) {
		return false;
	}
	// 2. Require ≥ 4 path components below the filesystem root. This rejects
	// pathological XDG_CACHE_HOME='/' (3 components) while accepting any
	// legitimate cache layout including non-default XDG_CACHE_HOME=/var/cache
	// and tmpdir paths — cross-platform (drive letter excluded, see helper).
	if (segmentDepthBelowRoot(resolved) < 4) {
		return false;
	}
	// 3. Must end in a known cache leaf: the two static literals, or an
	// anchored version-pinned shape `opencode-swarm@<semver>` (issue #2236
	// RC3 — a version-pinned cache dir like `opencode-swarm@7.143.1` was
	// previously refused even if it had been discovered). `resolved` here is
	// already `path.resolve()`d and, at every delete call site, already
	// `safeRealpathSync()`d, so `path.basename` structurally forecloses `..`
	// and path separators before this pattern ever sees the string. This is
	// deliberately NOT a `startsWith('opencode-swarm@')` prefix test — that
	// would admit `opencode-swarm@../../..`. Every other containment check
	// below (segment depth, parent, grandparent) is unchanged.
	const leaf = path.basename(resolved);
	if (
		leaf !== 'opencode-swarm@latest' &&
		leaf !== 'opencode-swarm' &&
		!VERSION_PINNED_LEAF.test(leaf)
	) {
		return false;
	}
	// 4. Must match the canonical .../opencode/{packages|node_modules}/<leaf> shape.
	const parent = path.basename(path.dirname(resolved));
	if (parent !== 'packages' && parent !== 'node_modules') {
		return false;
	}
	const grandparent = path.basename(path.dirname(path.dirname(resolved)));
	if (grandparent !== 'opencode') {
		return false;
	}
	return true;
}

/**
 * Safety guard for lock file deletion. Lock files have different basenames
 * and directory structure than cache directories, requiring separate validation
 * logic. While both functions share defense-in-depth principles, they are kept
 * separate rather than extracted to a parameterized helper because the
 * validation rules differ significantly:
 * - Cache paths verify: parent ∈ {packages, node_modules}, grandparent === 'opencode'
 * - Lock file paths verify: parent === 'opencode', grandparent !== 'opencode'
 * This separation maintains clarity and avoids over-parameterization.
 *
 * This function mirrors isSafeCachePath()'s defense-in-depth: minimum segment
 * depth, recognized basename, parent directory must be 'opencode', and
 * grandparent structure validation to prevent misconfigured nested paths.
 */
export function isSafeLockFilePath(p: string): boolean {
	const resolved = path.resolve(p);
	const home = path.resolve(os.homedir());
	if (resolved === '/' || resolved === home || resolved.length <= home.length) {
		return false;
	}
	if (segmentDepthBelowRoot(resolved) < 4) {
		return false;
	}
	const leaf = path.basename(resolved);
	if (
		leaf !== 'bun.lock' &&
		leaf !== 'bun.lockb' &&
		leaf !== 'package-lock.json'
	) {
		return false;
	}
	const parent = path.basename(path.dirname(resolved));
	if (parent !== 'opencode') {
		return false;
	}
	// Verify grandparent to ensure the path structure is correct and prevent
	// misconfigured nested paths like opencode/opencode/filename.
	const grandparent = path.basename(path.dirname(path.dirname(resolved)));
	if (grandparent === 'opencode') {
		return false;
	}
	return true;
}

/**
 * Safety guard for the `uninstall --clean` deletion of PROMPTS_DIR
 * (`<CONFIG_DIR>/opencode-swarm`, a DIRECTORY removed recursively).
 *
 * This is a SEPARATE guard from isSafeCachePath — it is NOT reused because
 * isSafeCachePath's layer-4 requires parent ∈ {packages, node_modules} and
 * grandparent === 'opencode', which the prompts directory (parent basename is
 * the config dir's basename, typically 'opencode') does not satisfy, so
 * isSafeCachePath would false-REJECT a legitimate PROMPTS_DIR.
 *
 * Defense in depth:
 *   1. Canonicalize via safeRealpathSync (realpathSync with ENOENT→fallback)
 *      so the path a symlinked leaf actually resolves to is what we validate.
 *   2. Refuse root, home, or shorter-than-home paths.
 *   3. Require ≥ 3 non-empty segments (rejects pathological
 *      XDG_CONFIG_HOME='/' which yields '/opencode/opencode-swarm', 2 segments).
 *   4. Require basename === 'opencode-swarm' AND the parent directory's
 *      basename to equal the config dir's basename (canonical layout is
 *      `<CONFIG_DIR>/opencode-swarm`).
 */
export function isSafePromptsDir(p: string): boolean {
	const canonical = safeRealpathSync(p, p);
	if (canonical === null) {
		return false;
	}
	const resolved = path.resolve(canonical);
	const home = path.resolve(os.homedir());
	if (resolved === '/' || resolved === home || resolved.length <= home.length) {
		return false;
	}
	if (segmentDepthBelowRoot(resolved) < 3) {
		return false;
	}
	if (path.basename(resolved) !== 'opencode-swarm') {
		return false;
	}
	if (path.basename(path.dirname(resolved)) !== path.basename(CONFIG_DIR)) {
		return false;
	}
	return true;
}

/**
 * Safety guard for the `uninstall --clean` deletion of PLUGIN_CONFIG_PATH
 * (`<CONFIG_DIR>/opencode-swarm.json`, a FILE removed with unlinkSync).
 *
 * File-oriented sibling of isSafePromptsDir. isSafePromptsDir would
 * false-REJECT this path because the leaf here is the `.json` FILE, not the
 * `opencode-swarm` directory — hence a dedicated guard.
 *
 * Defense in depth: canonicalize via safeRealpathSync; refuse root/home/
 * shorter-than-home; require basename === 'opencode-swarm.json' AND the
 * parent directory's basename to equal the config dir's basename.
 */
export function isSafePluginConfigPath(p: string): boolean {
	const canonical = safeRealpathSync(p, p);
	if (canonical === null) {
		return false;
	}
	const resolved = path.resolve(canonical);
	const home = path.resolve(os.homedir());
	if (resolved === '/' || resolved === home || resolved.length <= home.length) {
		return false;
	}
	// Depth floor (parity with isSafePromptsDir): reject a pathological
	// XDG_CONFIG_HOME='/' which yields '/opencode/opencode-swarm.json'
	// (2 components below root). Cross-platform via segmentDepthBelowRoot.
	if (segmentDepthBelowRoot(resolved) < 3) {
		return false;
	}
	if (path.basename(resolved) !== 'opencode-swarm.json') {
		return false;
	}
	if (path.basename(path.dirname(resolved)) !== path.basename(CONFIG_DIR)) {
		return false;
	}
	return true;
}

interface OpenCodeConfig {
	plugin?: string[];
	agent?: Record<string, unknown>;
	[key: string]: unknown;
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function loadJson<T>(filepath: string): T | null {
	try {
		const content = fs.readFileSync(filepath, 'utf-8');
		// Strip comments for JSONC support
		const stripped = content
			.replace(
				/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
				(match, comment) => (comment ? '' : match),
			)
			.replace(/,(\s*[}\]])/g, '$1');
		return JSON.parse(stripped) as T;
	} catch {
		return null;
	}
}

function saveJson(filepath: string, data: unknown): void {
	fs.writeFileSync(filepath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function writeProjectConfigIfMissing(cwd: string): void {
	void cwd;
}

async function install(): Promise<number> {
	console.log('🐝 Installing OpenCode Swarm...\n');

	// Ensure config directory exists
	ensureDir(CONFIG_DIR);
	ensureDir(PROMPTS_DIR);

	// Load or create OpenCode config
	// Migration: if opencode.json doesn't exist but config.json does (old installer bug), use config.json as starting state
	const LEGACY_CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
	let opencodeConfig = loadJson<OpenCodeConfig>(OPENCODE_CONFIG_PATH);
	if (!opencodeConfig) {
		const legacyConfig = loadJson<OpenCodeConfig>(LEGACY_CONFIG_PATH);
		if (legacyConfig) {
			console.log(
				'⚠ Migrating existing config from config.json to opencode.json...',
			);
			opencodeConfig = legacyConfig;
		} else {
			opencodeConfig = {};
		}
	}

	// Add plugin to OpenCode config (note: 'plugin' not 'plugins')
	if (!opencodeConfig.plugin) {
		opencodeConfig.plugin = [];
	}

	const pluginName = 'opencode-swarm';

	// Remove any existing entries for this plugin
	opencodeConfig.plugin = opencodeConfig.plugin.filter(
		(p) => p !== pluginName && !p.startsWith(`${pluginName}@`),
	);

	// Add fresh entry
	opencodeConfig.plugin.push(pluginName);

	// Disable OpenCode's default agents to avoid conflicts.
	// Use merge semantics to preserve any custom settings (e.g. model) the user
	// may have configured — only enforce disable:true, don't wipe other keys.
	// Safely handle edge cases where agent.explore/general might be non-objects
	// (null, false, string, etc.) to avoid data corruption from spread operator.
	if (!opencodeConfig.agent) {
		opencodeConfig.agent = {};
	}
	opencodeConfig.agent.explore = {
		...(typeof opencodeConfig.agent.explore === 'object' &&
		opencodeConfig.agent.explore !== null
			? (opencodeConfig.agent.explore as Record<string, unknown>)
			: {}),
		disable: true,
	};
	opencodeConfig.agent.general = {
		...(typeof opencodeConfig.agent.general === 'object' &&
		opencodeConfig.agent.general !== null
			? (opencodeConfig.agent.general as Record<string, unknown>)
			: {}),
		disable: true,
	};

	saveJson(OPENCODE_CONFIG_PATH, opencodeConfig);
	console.log('✓ Added opencode-swarm to OpenCode plugins');
	console.log('✓ Disabled default OpenCode agents (explore, general)');

	// Evict the opencode plugin cache so the next startup pulls the latest version
	// from npm. opencode's Npm.add() is cache-first with no staleness check — once
	// the directory exists it is returned verbatim on every subsequent start,
	// ignoring all npm updates. Clearing it here ensures `bunx opencode-swarm install`
	// actually upgrades the running version, not just the config registration.
	const evicted = evictPluginCaches();
	if (evicted.cleared.length > 0) {
		console.log(
			`✓ Cleared opencode plugin cache (next start will fetch latest): ${evicted.cleared.join(', ')}`,
		);
	}
	for (const failed of evicted.failed) {
		console.warn(
			`⚠ Could not clear opencode plugin cache — you may need to delete it manually:\n  ${failed}`,
		);
	}
	const lockEvicted = evictLockFiles();
	if (lockEvicted.cleared.length > 0) {
		console.log(
			`✓ Cleared opencode lock file(s) (next start will fetch latest): ${lockEvicted.cleared.join(', ')}`,
		);
	}
	for (const failed of lockEvicted.failed) {
		console.warn(
			`⚠ Could not clear opencode lock file — you may need to delete it manually:\n  ${failed}`,
		);
	}

	// Create default plugin config if not exists
	if (!fs.existsSync(PLUGIN_CONFIG_PATH)) {
		const defaultConfig = {
			// Must match PluginConfigSchema in src/config/schema.ts
			// v6.14: free OpenCode Zen models; v6.73+ switched to big-pickle with gpt-5-nano fallback; architect inherits OpenCode UI selection
			// v6.85+: Multi-level fallback chains - only big-pickle and gpt-5-nano are consistently available in free tier
			// General Council agents (council_generalist, council_skeptic, council_domain_expert)
			// derive their models from reviewer/critic/sme entries above. No separate config
			// entries are needed; if you want to override per-council-agent, set
			// temperature/variant on council_generalist / council_skeptic / council_domain_expert.
			agents: { ...DEFAULT_AGENT_CONFIGS },
			max_iterations: 5,
		};
		saveJson(PLUGIN_CONFIG_PATH, defaultConfig);
		console.log('✓ Created default plugin config at:', PLUGIN_CONFIG_PATH);
	} else {
		console.log('✓ Plugin config already exists at:', PLUGIN_CONFIG_PATH);
	}

	// Create project-level config if not exists
	writeProjectConfigIfMissing(process.cwd());

	console.log('\n📁 Configuration files:');
	console.log(`   OpenCode config: ${OPENCODE_CONFIG_PATH}`);
	console.log(`   Plugin config:   ${PLUGIN_CONFIG_PATH}`);
	console.log(`   Custom prompts:  ${PROMPTS_DIR}/`);

	console.log('\n🚀 Installation complete!');
	console.log('\nNext steps:');
	console.log('1. Run "opencode" in your project directory');
	console.log(
		'2. Ask the Architect anything — it coordinates all other agents automatically',
	);
	console.log(
		'3. Run /swarm diagnose inside OpenCode to confirm the plugin loaded',
	);
	console.log('   (also try: /swarm agents  /swarm config)');

	console.log('\n💡 Model configuration:');
	console.log(`   Global config: ${PLUGIN_CONFIG_PATH}`);
	console.log(
		'   Project override: .opencode/opencode-swarm.json  (create in your project root)',
	);
	console.log(
		'   On first OpenCode startup, .swarm/config.example.json will be written to your project root',
	);
	console.log('   — use it as a reference for customizing model assignments.');

	return 0;
}

/**
 * Cache-only refresh: deletes opencode's cached copy of opencode-swarm@latest so
 * the next opencode startup re-fetches from npm. Lighter than `install` — does
 * not touch opencode.json, plugin config, or custom prompts.
 *
 * Motivation: opencode's Npm.add() is cache-first with no staleness check on
 * `@latest`-tagged plugins (see comment in install()). Users who never re-run
 * `install` silently keep running an old version forever (issue #675).
 */
async function update(): Promise<number> {
	console.log('🐝 Refreshing OpenCode Swarm plugin cache...\n');
	// Issue #2236 RC3 item 3: the running plugin version was never reported
	// by `update`, making it impossible to tell which version issued the
	// refresh (or, together with the "was vX.Y.Z" lines below, whether the
	// refresh actually moved the user off a stale version).
	console.log(`opencode-swarm ${version}`);
	// Issue #2236 RC3 item 1: getPluginCachePaths() only ever returns the
	// fixed opencode-swarm@latest / opencode-swarm literals, so a
	// version-pinned OpenCode host cache (e.g. opencode-swarm@7.143.1, the
	// reporter's actual stale directory) is invisible unless discovered here
	// explicitly and merged in.
	const discoveredCachePaths = discoverVersionPinnedCachePaths();
	const result = evictPluginCaches(discoveredCachePaths);
	const lockResult = evictLockFiles();
	if (result.cleared.length > 0) {
		for (const cleared of result.cleared) {
			const beforeVersion = result.clearedVersions[cleared];
			const versionSuffix =
				beforeVersion != null ? ` (was v${beforeVersion})` : '';
			console.log(`✓ Cleared: ${cleared}${versionSuffix}`);
		}
		console.log('\nRestart OpenCode to fetch the latest version from npm.');
	}
	if (lockResult.cleared.length > 0) {
		for (const cleared of lockResult.cleared) {
			console.log(`✓ Cleared lock file: ${cleared}`);
		}
	}
	if (lockResult.failed.length > 0) {
		for (const failed of lockResult.failed) {
			console.error(`✗ Could not clear lock file: ${failed}`);
		}
	}
	if (
		result.cleared.length === 0 &&
		result.failed.length === 0 &&
		lockResult.cleared.length === 0 &&
		lockResult.failed.length === 0
	) {
		console.log(
			'No cached plugin found. Restart OpenCode to fetch the latest version from npm.',
		);
		console.log('Checked locations:');
		for (const p of [...OPENCODE_PLUGIN_CACHE_PATHS, ...discoveredCachePaths]) {
			console.log(`  - ${p}`);
		}
		console.log('Lock files checked:');
		for (const p of OPENCODE_PLUGIN_LOCK_FILE_PATHS) {
			console.log(`  - ${p}`);
		}
	}
	if (result.failed.length > 0) {
		for (const failed of result.failed) {
			console.error(`✗ Could not clear: ${failed}`);
		}
	}
	if (result.failed.length > 0 || lockResult.failed.length > 0) {
		return 1;
	}
	return 0;
}

/**
 * Recursively delete every known opencode plugin cache location for
 * opencode-swarm. Returns paths actually cleared and paths that errored.
 * Skips paths that don't exist or fail the safety guard.
 *
 * `additionalPaths` lets a caller merge in dynamically-discovered cache
 * locations — e.g. `discoverVersionPinnedCachePaths()` for version-pinned
 * `opencode-swarm@<semver>` dirs (issue #2236 RC3) — without changing the
 * fixed, pure `OPENCODE_PLUGIN_CACHE_PATHS` list every caller shares.
 * Defaults to `[]` so existing callers (`install()`) are unaffected.
 */
export function evictPluginCaches(additionalPaths: readonly string[] = []): {
	cleared: string[];
	failed: string[];
	/** Version read from each cleared path's package.json BEFORE deletion,
	 * keyed by the canonical path that appears in `cleared`. `null` when the
	 * version could not be determined (missing/unreadable package.json). */
	clearedVersions: Record<string, string | null>;
} {
	const cleared: string[] = [];
	const failed: string[] = [];
	const clearedVersions: Record<string, string | null> = {};
	for (const cachePath of [
		...OPENCODE_PLUGIN_CACHE_PATHS,
		...additionalPaths,
	]) {
		if (!fs.existsSync(cachePath)) continue;
		// M6: canonicalize first, then validate AND delete the SAME canonical
		// string so there is no re-resolution gap on the final component
		// between the safety check and the syscall. This closes a final-
		// component symlink swap. NOTE (residual TOCTOU): an intermediate-
		// directory symlink swap performed by an attacker between this
		// realpath and the rmSync syscall is NOT closeable via the rmSync
		// string API, which takes a path rather than an already-opened fd.
		const canonical = safeRealpathSync(cachePath, cachePath);
		if (canonical === null || !fs.existsSync(canonical)) continue;
		if (!isSafeCachePath(canonical)) {
			failed.push(`${canonical} (refused: failed safety check)`);
			continue;
		}
		// Capture the installed version BEFORE deletion so callers (update())
		// can report what was actually cleared (issue #2236 RC3 item 3).
		const versionBeforeDelete = readCachePackageVersion(canonical);
		try {
			fs.rmSync(canonical, { recursive: true, force: true });
			// rmSync with `force: true` does not throw when the delete fails to
			// fully take (e.g. a file locked by another process on Windows, or a
			// permission-denied leaf inside the tree) — it silently no-ops
			// instead of throwing. Verify the postcondition rather than trusting
			// "no thrown error" (issue #2236 RC3 item 2: deletion was reported,
			// never verified).
			if (fs.existsSync(canonical)) {
				failed.push(
					`${canonical} (rmSync returned without error, but the path still exists)`,
				);
				continue;
			}
			cleared.push(canonical);
			clearedVersions[canonical] = versionBeforeDelete;
		} catch (err) {
			failed.push(
				`${canonical} (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}
	return { cleared, failed, clearedVersions };
}

/**
 * Delete every known opencode plugin lock file (bun.lock, bun.lockb,
 * package-lock.json). Returns paths actually cleared and paths that
 * errored. Skips paths that don't exist or fail the safety guard.
 *
 * Why: opencode runs `bun install` at startup; bun.lock pins the
 * installed plugin version. Deleting the lock forces re-resolution
 * from npm so users actually receive the @latest version after `update`.
 */
export function evictLockFiles(): { cleared: string[]; failed: string[] } {
	const cleared: string[] = [];
	const failed: string[] = [];
	for (const lockPath of OPENCODE_PLUGIN_LOCK_FILE_PATHS) {
		if (!fs.existsSync(lockPath)) continue;
		// M6: canonicalize first, then validate AND delete the SAME canonical
		// string so there is no re-resolution gap on the final component
		// between the safety check and the syscall. This closes a final-
		// component symlink swap. NOTE (residual TOCTOU): an intermediate-
		// directory symlink swap performed by an attacker between this
		// realpath and the unlinkSync syscall is NOT closeable via the
		// unlinkSync string API, which takes a path rather than an fd.
		const canonical = safeRealpathSync(lockPath, lockPath);
		if (canonical === null || !fs.existsSync(canonical)) continue;
		if (!isSafeLockFilePath(canonical)) {
			failed.push(`${canonical} (refused: failed safety check)`);
			continue;
		}
		try {
			fs.unlinkSync(canonical);
			// Verify the postcondition rather than trusting "unlinkSync didn't
			// throw" (issue #2236 RC3 item 2, same rationale as evictPluginCaches).
			if (fs.existsSync(canonical)) {
				failed.push(
					`${canonical} (unlinkSync returned without error, but the path still exists)`,
				);
				continue;
			}
			cleared.push(canonical);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === 'EISDIR') {
				failed.push(`${canonical} (path is a directory, not a file)`);
			} else {
				failed.push(
					`${canonical} (${err instanceof Error ? err.message : String(err)})`,
				);
			}
		}
	}
	return { cleared, failed };
}

async function uninstall(): Promise<number> {
	try {
		console.log('🐝 Uninstalling OpenCode Swarm...\n');

		// Load opencode config
		const opencodeConfig = loadJson<OpenCodeConfig>(OPENCODE_CONFIG_PATH);

		// If config is null
		if (!opencodeConfig) {
			// Check if the file exists
			if (fs.existsSync(OPENCODE_CONFIG_PATH)) {
				// It's malformed JSON
				console.log(
					`✗ Could not parse opencode config at: ${OPENCODE_CONFIG_PATH}`,
				);
				return 1;
			} else {
				// File doesn't exist
				console.log(`⚠ No opencode config found at: ${OPENCODE_CONFIG_PATH}`);
				console.log('Nothing to uninstall.');
				return 0;
			}
		}

		// If config has no plugin array or it's empty
		if (!opencodeConfig.plugin || opencodeConfig.plugin.length === 0) {
			console.log('⚠ opencode-swarm is not installed (no plugins configured).');
			return 0;
		}

		// Filter out 'opencode-swarm' and entries starting with 'opencode-swarm@'
		const pluginName = 'opencode-swarm';
		const filteredPlugins = opencodeConfig.plugin.filter(
			(p) => p !== pluginName && !p.startsWith(`${pluginName}@`),
		);

		// If array length didn't change (plugin wasn't found)
		if (filteredPlugins.length === opencodeConfig.plugin.length) {
			console.log('⚠ opencode-swarm is not installed.');
			return 0;
		}

		// Update config and save
		opencodeConfig.plugin = filteredPlugins;

		// Remove the disabled agent overrides
		if (opencodeConfig.agent) {
			delete opencodeConfig.agent.explore;
			delete opencodeConfig.agent.general;

			// If agent is now empty, delete it too
			if (Object.keys(opencodeConfig.agent).length === 0) {
				delete opencodeConfig.agent;
			}
		}

		// Save the updated config
		saveJson(OPENCODE_CONFIG_PATH, opencodeConfig);
		console.log('✓ Removed opencode-swarm from OpenCode plugins');
		console.log('✓ Re-enabled default OpenCode agents (explore, general)');

		// Check for --clean flag
		if (process.argv.includes('--clean')) {
			let cleaned = false;

			// If PLUGIN_CONFIG_PATH exists: canonicalize, safety-check, delete.
			if (fs.existsSync(PLUGIN_CONFIG_PATH)) {
				const canonical = safeRealpathSync(
					PLUGIN_CONFIG_PATH,
					PLUGIN_CONFIG_PATH,
				);
				if (canonical === null || !isSafePluginConfigPath(canonical)) {
					console.log(
						`✗ Refused to remove plugin config (failed safety check): ${canonical ?? PLUGIN_CONFIG_PATH}`,
					);
				} else {
					fs.unlinkSync(canonical);
					console.log(`✓ Removed plugin config: ${canonical}`);
					cleaned = true;
				}
			}

			// If PROMPTS_DIR exists: canonicalize, safety-check, delete recursively.
			if (fs.existsSync(PROMPTS_DIR)) {
				const canonical = safeRealpathSync(PROMPTS_DIR, PROMPTS_DIR);
				if (canonical === null || !isSafePromptsDir(canonical)) {
					console.log(
						`✗ Refused to remove custom prompts (failed safety check): ${canonical ?? PROMPTS_DIR}`,
					);
				} else {
					fs.rmSync(canonical, { recursive: true });
					console.log(`✓ Removed custom prompts: ${canonical}`);
					cleaned = true;
				}
			}

			// If neither exists
			if (!cleaned) {
				console.log('✓ No config files to clean up');
			}
		}

		console.log('\n✅ Uninstall complete!');
		return 0;
	} catch (error) {
		console.log(
			'✗ Uninstall failed: ' +
				(error instanceof Error ? error.message : String(error)),
		);
		return 1;
	}
}

function printHelp(): void {
	const commandList = VALID_COMMANDS.filter((cmd) => !cmd.includes(' '))
		.map((cmd) => `  ${cmd}`)
		.join('\n');
	console.log(`
opencode-swarm - Architect-centric agentic swarm plugin for OpenCode

Usage: bunx opencode-swarm [command] [OPTIONS]

Commands:
  install     Install and configure the plugin (default)
  update      Refresh OpenCode's plugin cache so the next start fetches latest from npm
  uninstall   Remove the plugin from OpenCode config
  run         Run a plugin command directly (for use outside OpenCode)

Options:
  --clean     Also remove config files and custom prompts (with uninstall)
  -h, --help  Show this help message

Run subcommands:
${commandList}

Configuration:
  Edit ~/.config/opencode/opencode-swarm.json to customize:
  - Model assignments per agent or category
  - Preset configurations (remote, hybrid)
  - Local inference endpoints (GPU/NPU URLs)
  - Max iterations and other settings

Custom Prompts:
  Place custom prompts in ~/.config/opencode/opencode-swarm/
  - {agent}.md       - Replace default prompt
  - {agent}_append.md - Append to default prompt

Examples:
  bunx opencode-swarm install
  bunx opencode-swarm update
  bunx opencode-swarm uninstall
  bunx opencode-swarm uninstall --clean
  bunx opencode-swarm --help
  bunx opencode-swarm run status
  bunx opencode-swarm run sync-plan
  bunx opencode-swarm run knowledge migrate
  bunx opencode-swarm run dark-matter
  bunx opencode-swarm run diagnose
  bunx opencode-swarm run evidence summary
`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.includes('-v') || args.includes('--version')) {
		console.log(`opencode-swarm ${version}`);
		process.exit(0);
	}

	if (args.includes('-h') || args.includes('--help')) {
		printHelp();
		process.exit(0);
	}

	// Default command is install
	const command = args[0] || 'install';

	if (command === 'install') {
		const exitCode = await install();
		process.exit(exitCode);
	} else if (command === 'update') {
		const exitCode = await update();
		process.exit(exitCode);
	} else if (command === 'uninstall') {
		const exitCode = await uninstall();
		process.exit(exitCode);
	} else if (command === 'run') {
		const exitCode = await run(args.slice(1));
		process.exit(exitCode);
	} else {
		console.error(`Unknown command: ${command}`);
		console.error('Run with --help for usage information');
		process.exit(1);
	}
}

// Guard against module-level side effects when imported by test files.
// In Bun's test worker, process.argv has only 2 elements, so slice(2) is
// empty and command defaults to 'install', which would overwrite the user's
// real opencode.json. import.meta.main is false when this module is imported,
// so main() only runs when the file is the actual CLI entry point.
if (import.meta.main) {
	main().catch((err) => {
		console.error('Fatal error:', err);
		process.exit(1);
	});
}

/**
 * Dispatch function for routing argv tokens to plugin command handlers.
 * Used by the "run" subcommand entry point.
 * Delegates to the unified COMMAND_REGISTRY via resolveCommand().
 */
export async function run(args: string[]): Promise<number> {
	const cwd = process.cwd();

	// Handle empty args
	if (!args || args.length === 0) {
		console.error(
			`Usage: bunx opencode-swarm run <command> [args]\nValid commands: ${VALID_COMMANDS.join(', ')}`,
		);
		return 1;
	}

	const resolved = resolveCommand(args);

	if (!resolved) {
		console.error(
			`Unknown command: ${args[0]}\nValid commands: ${VALID_COMMANDS.join(', ')}`,
		);
		return 1;
	}

	// Human-only / restricted commands are operator actions. The CLI is the
	// sanctioned human-terminal path, but agent Bash sessions are NOT TTYs —
	// refuse non-interactive invocation of mutating operator commands so a
	// shell-guardrail bypass (e.g. variable indirection) still meets a second
	// gate at the entry point (issue #2033 PR review, CC-2). Scripts that
	// genuinely need this path opt in with SWARM_ALLOW_HUMAN_ONLY_CLI=1.
	let policy = (resolved.entry as { toolPolicy?: string }).toolPolicy;
	if (!policy) {
		// Aliases carry no toolPolicy of their own — resolve the canonical
		// target's policy exactly as tool-policy.ts does (review finding: the
		// dash form `run memory-import` bypassed the gate otherwise).
		const aliasOf = (resolved.entry as { aliasOf?: string }).aliasOf;
		if (aliasOf) {
			const target = COMMAND_REGISTRY[
				aliasOf as keyof typeof COMMAND_REGISTRY
			] as { toolPolicy?: string } | undefined;
			policy = target?.toolPolicy;
		}
	}
	if (
		(policy === 'human-only' || policy === 'restricted') &&
		!process.stdout.isTTY &&
		process.env.SWARM_ALLOW_HUMAN_ONLY_CLI !== '1'
	) {
		console.error(
			`Refusing to run human-only command '${resolved.key}' from a non-interactive shell. ` +
				'Run it yourself in a terminal, or set SWARM_ALLOW_HUMAN_ONLY_CLI=1 if this is an explicitly approved automation.',
		);
		return 1;
	}

	const result = await resolved.entry.handler({
		directory: cwd,
		args: resolved.remainingArgs,
		sessionID: '',
		agents: {},
		source: 'cli',
		packageRoot: PACKAGE_ROOT,
	});

	console.log(result);
	return 0;
}
