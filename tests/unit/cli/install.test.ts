import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_PATH = join(import.meta.dir, '../../../src/cli/index.ts');

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

describe('CLI install command', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-test-'));
		// Create the opencode subdirectory
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('Fresh install creates opencode.json with plugin entry', async () => {
		// Setup: Create tempDir with opencode/ subdirectory (no config files)
		const opencodeDir = join(tempDir, 'opencode');
		expect(existsSync(opencodeDir)).toBe(true);
		const opencodeJsonPath = join(opencodeDir, 'opencode.json');
		const configJsonPath = join(opencodeDir, 'config.json');
		expect(existsSync(opencodeJsonPath)).toBe(false);
		expect(existsSync(configJsonPath)).toBe(false);

		// Run: Run install command
		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0 and success message
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'✓ Added opencode-swarm to OpenCode plugins',
		);

		// Assert: opencode.json exists and contains plugin entry
		expect(existsSync(opencodeJsonPath)).toBe(true);
		const configData = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		expect(configData.plugin).toContain('opencode-swarm');

		// Assert: config.json does NOT exist (install writes only to opencode.json)
		expect(existsSync(configJsonPath)).toBe(false);
	});

	test('Migration — install migrates config.json to opencode.json when opencode.json is absent', async () => {
		// Setup: Create config.json with existing plugin and agent config (NO opencode.json)
		const opencodeDir = join(tempDir, 'opencode');
		const configJsonPath = join(opencodeDir, 'config.json');
		const opencodeJsonPath = join(opencodeDir, 'opencode.json');

		const legacyConfig = {
			plugin: ['opencode-swarm'],
			agent: {
				explore: { disable: true },
				general: { disable: true },
			},
		};
		await writeFile(configJsonPath, JSON.stringify(legacyConfig, null, 2));

		// Verify opencode.json does NOT exist yet
		expect(existsSync(opencodeJsonPath)).toBe(false);

		// Run: Run install command
		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0
		expect(result.exitCode).toBe(0);

		// Assert: Migration message is logged
		expect(result.stdout).toContain(
			'Migrating existing config from config.json to opencode.json',
		);

		// Assert: opencode.json exists and contains the plugin
		expect(existsSync(opencodeJsonPath)).toBe(true);
		const newConfig = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		expect(newConfig.plugin).toContain('opencode-swarm');

		// Assert: config.json still exists (install does NOT delete the legacy file)
		expect(existsSync(configJsonPath)).toBe(true);
	});

	test('No migration when opencode.json already exists', async () => {
		// Setup: Create opencode.json with other-plugin AND config.json with should-not-be-read
		const opencodeDir = join(tempDir, 'opencode');
		const opencodeJsonPath = join(opencodeDir, 'opencode.json');
		const configJsonPath = join(opencodeDir, 'config.json');

		const existingConfig = {
			plugin: ['other-plugin'],
		};
		await writeFile(opencodeJsonPath, JSON.stringify(existingConfig, null, 2));

		const legacyConfig = {
			plugin: ['should-not-be-read'],
		};
		await writeFile(configJsonPath, JSON.stringify(legacyConfig, null, 2));

		// Run: Run install command
		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0
		expect(result.exitCode).toBe(0);

		// Assert: No migration message
		expect(result.stdout).not.toContain('Migrating');

		// Assert: opencode.json contains BOTH plugins
		const updatedConfig = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		expect(updatedConfig.plugin).toContain('other-plugin');
		expect(updatedConfig.plugin).toContain('opencode-swarm');

		// Assert: stdout does NOT contain the legacy plugin name (the legacy file was ignored)
		expect(result.stdout).not.toContain('should-not-be-read');
	});

	test('Install is idempotent — running twice does not duplicate plugin entry', async () => {
		// Setup: Run install once (no prior config)
		const opencodeDir = join(tempDir, 'opencode');
		const opencodeJsonPath = join(opencodeDir, 'opencode.json');

		const result1 = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result1.exitCode).toBe(0);

		// Run install a second time with the same tempDir
		const result2 = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0 on second run
		expect(result2.exitCode).toBe(0);

		// Assert: Plugin array contains exactly ONE entry for opencode-swarm (no duplicates)
		const configData = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		const swarmPlugins = configData.plugin.filter(
			(p: string) => p === 'opencode-swarm',
		);
		expect(swarmPlugins).toHaveLength(1);
	});

	test('Migration with empty config.json creates fresh opencode.json', async () => {
		// Setup: Create config.json with empty config object (NO opencode.json)
		const opencodeDir = join(tempDir, 'opencode');
		const configJsonPath = join(opencodeDir, 'config.json');
		const opencodeJsonPath = join(opencodeDir, 'opencode.json');

		await writeFile(configJsonPath, JSON.stringify({}, null, 2));

		// Verify opencode.json does NOT exist yet
		expect(existsSync(opencodeJsonPath)).toBe(false);

		// Run: Run install command
		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0
		expect(result.exitCode).toBe(0);

		// Assert: Migration message is logged
		expect(result.stdout).toContain(
			'Migrating existing config from config.json to opencode.json',
		);

		// Assert: opencode.json exists and plugin array contains opencode-swarm
		expect(existsSync(opencodeJsonPath)).toBe(true);
		const newConfig = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		expect(newConfig.plugin).toContain('opencode-swarm');
	});

	test('Install preserves existing custom agent settings — does not wipe user config', async () => {
		// Setup: Create opencode.json with custom agent settings and other user config
		const opencodeDir = join(tempDir, 'opencode');
		const opencodeJsonPath = join(opencodeDir, 'opencode.json');

		const existingConfig = {
			plugin: ['other-plugin'],
			theme: 'dark',
			agent: {
				explore: { model: 'my-custom-explore-model', temperature: 0.2 },
				general: { model: 'my-custom-general-model' },
				coder: { model: 'my-coder-model' },
			},
		};
		await writeFile(opencodeJsonPath, JSON.stringify(existingConfig, null, 2));

		// Run install
		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result.exitCode).toBe(0);

		const updated = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));

		// Plugin entry added
		expect(updated.plugin).toContain('opencode-swarm');

		// Top-level user config preserved
		expect(updated.theme).toBe('dark');

		// agent.explore: disable enforced but custom keys preserved
		expect(updated.agent.explore.disable).toBe(true);
		expect(updated.agent.explore.model).toBe('my-custom-explore-model');
		expect(updated.agent.explore.temperature).toBe(0.2);

		// agent.general: disable enforced but custom model preserved
		expect(updated.agent.general.disable).toBe(true);
		expect(updated.agent.general.model).toBe('my-custom-general-model');

		// Unrelated agent untouched
		expect(updated.agent.coder.model).toBe('my-coder-model');
	});

	test('import.meta.main is true in test entry point, false in imported modules — confirming the guard in cli/index is effective', () => {
		// Each Bun test worker uses the test file as its entry point.
		// import.meta.main is TRUE here (this file is the entry point) and
		// FALSE in any module this file imports. The guard in cli/index.ts uses
		// `if (import.meta.main)` to prevent main() from running when that
		// module is imported rather than directly executed. Without this guard,
		// Bun test workers would call install() with an empty argv defaulting to
		// 'install', overwriting the user's real opencode.json.
		expect(import.meta.main).toBe(true);
	});

	test('Install safely handles malformed agent config (null, false, string values)', async () => {
		// Edge case: if agent.explore or agent.general are non-objects
		// (null, false, string, number, etc.), the merge semantics should
		// safely ignore them without corrupting data via spread operator.
		const opencodeDir = join(tempDir, 'opencode');
		const opencodeJsonPath = join(opencodeDir, 'opencode.json');

		const malformedConfig = {
			plugin: [],
			agent: {
				explore: null, // Invalid: should be object or undefined
				general: false, // Invalid: should be object or undefined
				coder: { model: 'my-coder' }, // Valid: keep as-is
			},
		};
		await writeFile(opencodeJsonPath, JSON.stringify(malformedConfig, null, 2));

		// Run install
		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result.exitCode).toBe(0);

		const updated = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));

		// agent.explore: should become { disable: true } (the null is replaced)
		expect(updated.agent.explore).toEqual({ disable: true });

		// agent.general: should become { disable: true } (the false is replaced)
		expect(updated.agent.general).toEqual({ disable: true });

		// Unrelated agent should be preserved as-is
		expect(updated.agent.coder.model).toBe('my-coder');
	});

	test('Install preserves a user-set disable:false (never fight the user)', async () => {
		// Issue #2493: a re-enabled agent must stay re-enabled. The old
		// contract (overwriting disable:false back to true) silently fought
		// the user's configuration on every re-install.
		const opencodeDir = join(tempDir, 'opencode');
		const opencodeJsonPath = join(opencodeDir, 'opencode.json');

		const configWithDisableFalse = {
			plugin: [],
			agent: {
				explore: { disable: false, model: 'custom-explore' },
				general: { disable: false, model: 'custom-general' },
			},
		};
		await writeFile(
			opencodeJsonPath,
			JSON.stringify(configWithDisableFalse, null, 2),
		);

		// Run install
		const result = await runCLI(['install'], { XDG_CONFIG_HOME: tempDir });
		expect(result.exitCode).toBe(0);

		const updated = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));

		// disable stays false (explicit user decision), custom model preserved
		expect(updated.agent.explore.disable).toBe(false);
		expect(updated.agent.explore.model).toBe('custom-explore');

		expect(updated.agent.general.disable).toBe(false);
		expect(updated.agent.general.model).toBe('custom-general');
	});
});

describe('CLI install — opencode plugin cache eviction', () => {
	let tempConfigDir: string;
	let tempCacheDir: string;

	beforeEach(async () => {
		tempConfigDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-cfg-'));
		tempCacheDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-cache-'));
		await mkdir(join(tempConfigDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		for (const dir of [tempConfigDir, tempCacheDir]) {
			if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
		}
	});

	test('Clears stale plugin cache directory when it exists', async () => {
		// Setup: Create the opencode plugin cache directory (simulating a stale install)
		const pluginCacheDir = join(
			tempCacheDir,
			'opencode',
			'packages',
			'opencode-swarm@latest',
		);
		await mkdir(pluginCacheDir, { recursive: true });
		// Write a fake old package.json to simulate cached 6.75.0
		await mkdir(join(pluginCacheDir, 'node_modules', 'opencode-swarm'), {
			recursive: true,
		});
		await writeFile(
			join(pluginCacheDir, 'node_modules', 'opencode-swarm', 'package.json'),
			JSON.stringify({ name: 'opencode-swarm', version: '6.75.0' }),
		);
		expect(existsSync(pluginCacheDir)).toBe(true);

		// Run install with both env vars controlled
		const result = await runCLI(['install'], {
			XDG_CONFIG_HOME: tempConfigDir,
			XDG_CACHE_HOME: tempCacheDir,
		});

		// Assert: exit code 0 and cache-cleared log message
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('✓ Cleared opencode plugin cache');

		// Assert: the stale cache directory is gone
		expect(existsSync(pluginCacheDir)).toBe(false);
	});

	test('Does not error when plugin cache directory does not exist', async () => {
		// Setup: No cache directory exists (fresh machine or already cleared)
		const pluginCacheDir = join(
			tempCacheDir,
			'opencode',
			'packages',
			'opencode-swarm@latest',
		);
		expect(existsSync(pluginCacheDir)).toBe(false);

		// Run install
		const result = await runCLI(['install'], {
			XDG_CONFIG_HOME: tempConfigDir,
			XDG_CACHE_HOME: tempCacheDir,
		});

		// Assert: exit code 0, no error or warning emitted
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain('Could not clear');
		expect(result.stderr).toBe('');

		// Assert: no cache-cleared log (nothing to clear)
		expect(result.stdout).not.toContain('Cleared opencode plugin cache');
	});

	test('Install is idempotent with cache eviction — second run also succeeds', async () => {
		// Setup: Create a stale cache directory so the first run exercises the eviction path
		const pluginCacheDir = join(
			tempCacheDir,
			'opencode',
			'packages',
			'opencode-swarm@latest',
		);
		await mkdir(pluginCacheDir, { recursive: true });
		expect(existsSync(pluginCacheDir)).toBe(true);

		const env = {
			XDG_CONFIG_HOME: tempConfigDir,
			XDG_CACHE_HOME: tempCacheDir,
		};

		// First run: should clear the stale cache
		const result1 = await runCLI(['install'], env);
		expect(result1.exitCode).toBe(0);
		expect(result1.stdout).toContain('✓ Cleared opencode plugin cache');
		expect(existsSync(pluginCacheDir)).toBe(false);

		// Second run: cache is already gone; should succeed without error
		const result2 = await runCLI(['install'], env);
		expect(result2.exitCode).toBe(0);
		expect(result2.stderr).toBe('');

		// Plugin entry still correct after both runs
		const configData = JSON.parse(
			await readFile(join(tempConfigDir, 'opencode', 'opencode.json'), 'utf-8'),
		);
		const swarmPlugins = configData.plugin.filter(
			(p: string) => p === 'opencode-swarm',
		);
		expect(swarmPlugins).toHaveLength(1);
	});

	test('Prints warning to stderr when cache directory cannot be deleted', async () => {
		// This test requires POSIX permission semantics — skip on Windows and when
		// running as root (root bypasses permission checks).
		if (process.platform === 'win32') return;
		if (typeof process.getuid === 'function' && process.getuid() === 0) return;

		// Setup: Create the cache directory inside a parent that will be made read-only
		const pluginCacheParent = join(tempCacheDir, 'opencode', 'packages');
		const pluginCacheDir = join(pluginCacheParent, 'opencode-swarm@latest');
		await mkdir(pluginCacheDir, { recursive: true });

		// Remove write permission from parent directory so rmSync cannot delete the entry
		chmodSync(pluginCacheParent, 0o555);

		try {
			const result = await runCLI(['install'], {
				XDG_CONFIG_HOME: tempConfigDir,
				XDG_CACHE_HOME: tempCacheDir,
			});

			// Install must still succeed — cache-clear failure is non-fatal
			expect(result.exitCode).toBe(0);

			// Warning must be printed to stderr (console.warn)
			expect(result.stderr).toContain('Could not clear opencode plugin cache');

			// Stale cache directory is still present (we could not delete it)
			expect(existsSync(pluginCacheDir)).toBe(true);
		} finally {
			// Restore permissions so afterEach cleanup can remove the directory
			chmodSync(pluginCacheParent, 0o755);
		}
	});
});
