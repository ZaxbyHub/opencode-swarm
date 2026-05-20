/**
 * Tests for `bunx opencode-swarm update` (issue #675).
 *
 * The update subcommand performs a cache-only refresh of OpenCode's plugin
 * cache without touching opencode.json, plugin config, or custom prompts.
 * It exists because users who never re-run `install` silently keep running
 * a stale cached copy forever.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	evictLockFiles,
	isSafeCachePath,
	isSafeLockFilePath,
} from '../../../src/cli/index.js';

const CLI_PATH = join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'src',
	'cli',
	'index.ts',
);

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, 'run', CLI_PATH, ...args], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

describe('CLI update command', () => {
	let tempDir: string;
	let xdgCacheHome: string;
	let xdgConfigHome: string;
	let xdgCachePluginPath: string;
	let nodeModulesPluginPath: string;
	let xdgCacheNodeModulesPluginPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-update-'));
		xdgCacheHome = join(tempDir, 'cache');
		xdgConfigHome = join(tempDir, 'config');
		xdgCachePluginPath = join(
			xdgCacheHome,
			'opencode',
			'packages',
			'opencode-swarm@latest',
		);
		nodeModulesPluginPath = join(
			xdgConfigHome,
			'opencode',
			'node_modules',
			'opencode-swarm',
		);
		xdgCacheNodeModulesPluginPath = join(
			xdgCacheHome,
			'opencode',
			'node_modules',
			'opencode-swarm',
		);
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('clears XDG cache layout when present', async () => {
		await mkdir(xdgCachePluginPath, { recursive: true });
		await writeFile(
			join(xdgCachePluginPath, 'package.json'),
			'{"name":"stale"}',
		);

		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('✓ Cleared');
		expect(result.stdout).toContain('opencode-swarm@latest');
		expect(existsSync(xdgCachePluginPath)).toBe(false);
	});

	test('clears node_modules layout when present (Linux/devcontainer)', async () => {
		await mkdir(nodeModulesPluginPath, { recursive: true });
		await writeFile(
			join(nodeModulesPluginPath, 'package.json'),
			'{"name":"stale"}',
		);

		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('✓ Cleared');
		expect(result.stdout).toContain('node_modules');
		expect(existsSync(nodeModulesPluginPath)).toBe(false);
	});

	test('clears BOTH layouts when both are present', async () => {
		await mkdir(xdgCachePluginPath, { recursive: true });
		await mkdir(nodeModulesPluginPath, { recursive: true });

		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(existsSync(xdgCachePluginPath)).toBe(false);
		expect(existsSync(nodeModulesPluginPath)).toBe(false);
		// Both paths should appear in the cleared output
		expect(result.stdout.match(/✓ Cleared/g)?.length).toBeGreaterThanOrEqual(2);
	});

	test('reports nothing-to-do when no cache exists in either layout', async () => {
		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('No cached plugin found');
		expect(result.stdout).toContain('Checked locations:');
	});

	test('is idempotent — second run still exits 0', async () => {
		await mkdir(xdgCachePluginPath, { recursive: true });

		const first = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});
		expect(first.exitCode).toBe(0);
		expect(existsSync(xdgCachePluginPath)).toBe(false);

		const second = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});
		expect(second.exitCode).toBe(0);
		expect(second.stdout).toContain('No cached plugin found');
	});

	test('does not touch opencode.json or opencode-swarm.json', async () => {
		// Pre-create both cache layouts AND user config files; assert only the
		// cache directories are removed.
		await mkdir(xdgCachePluginPath, { recursive: true });
		const opencodeJson = join(xdgConfigHome, 'opencode', 'opencode.json');
		const pluginJson = join(xdgConfigHome, 'opencode', 'opencode-swarm.json');
		await mkdir(join(xdgConfigHome, 'opencode'), { recursive: true });
		const originalOpencode = '{"plugin":["something-else"]}\n';
		const originalPlugin = '{"agents":{"existing":{"model":"keep"}}}\n';
		await writeFile(opencodeJson, originalOpencode);
		await writeFile(pluginJson, originalPlugin);

		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(existsSync(xdgCachePluginPath)).toBe(false);
		expect(await Bun.file(opencodeJson).text()).toBe(originalOpencode);
		expect(await Bun.file(pluginJson).text()).toBe(originalPlugin);
	});

	test('--help lists update as a top-level command', async () => {
		const result = await runCLI(['--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('update');
		expect(result.stdout).toContain(
			"Refresh OpenCode's plugin cache so the next start fetches latest from npm",
		);
	});

	test('clears canonical XDG cache node_modules layout when present (OpenCode v20+)', async () => {
		await mkdir(xdgCacheNodeModulesPluginPath, { recursive: true });
		await writeFile(
			join(xdgCacheNodeModulesPluginPath, 'package.json'),
			'{"name":"stale-canonical"}',
		);

		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('✓ Cleared');
		// The canonical path includes both 'cache' and 'node_modules' segments
		expect(result.stdout).toContain('node_modules');
		expect(result.stdout).toMatch(
			/cache.*opencode.*node_modules.*opencode-swarm/,
		);
		expect(existsSync(xdgCacheNodeModulesPluginPath)).toBe(false);
	});

	test('clears ALL THREE layouts when all are present', async () => {
		await mkdir(xdgCachePluginPath, { recursive: true });
		await mkdir(nodeModulesPluginPath, { recursive: true });
		await mkdir(xdgCacheNodeModulesPluginPath, { recursive: true });

		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(existsSync(xdgCachePluginPath)).toBe(false);
		expect(existsSync(nodeModulesPluginPath)).toBe(false);
		expect(existsSync(xdgCacheNodeModulesPluginPath)).toBe(false);
		// All three paths should appear in the cleared output
		expect(result.stdout.match(/✓ Cleared/g)?.length).toBeGreaterThanOrEqual(3);
	});

	test('Checked locations output lists all three cache paths', async () => {
		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('No cached plugin found');
		expect(result.stdout).toContain('Checked locations:');
		// All three layouts should be enumerated. Use [\\/] to accept either
		// path separator (Windows uses \, POSIX uses /).
		expect(result.stdout).toMatch(/packages[\\/]opencode-swarm@latest/);
		expect(result.stdout).toMatch(
			/config[\\/]opencode[\\/]node_modules[\\/]opencode-swarm/,
		);
		expect(result.stdout).toMatch(
			/cache[\\/]opencode[\\/]node_modules[\\/]opencode-swarm/,
		);
	});

	test('refuses deletion when XDG_CACHE_HOME is pathologically set to /', async () => {
		// Adversarial: if a user (or a misconfigured environment) sets
		// XDG_CACHE_HOME='/', the resolved cache path becomes
		// '/opencode/node_modules/opencode-swarm' which has a recognized
		// leaf name but is OUTSIDE the user's home directory. The safety
		// guard must refuse this path. Issue #675 hardening.
		//
		// We do NOT create that directory (it's at root and we don't have
		// permission anyway). We only verify the CLI exits cleanly without
		// attempting to delete anything outside the user's control.
		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: '/',
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		// Either: (a) the path doesn't exist (existsSync gate trips first),
		// producing 'No cached plugin found' and exit 0; or (b) the path
		// exists somehow and isSafeCachePath refuses, producing
		// '✗ Could not clear: ... refused: failed safety check' and exit 1.
		// BOTH outcomes are SAFE — no catastrophic deletion occurred.
		expect(result.exitCode).toBeLessThanOrEqual(1);
		// Critically: the stdout/stderr must NOT contain '✓ Cleared:
		// /opencode/node_modules/opencode-swarm'. That would mean we
		// actually nuked a system path.
		expect(result.stdout).not.toMatch(
			/✓ Cleared:[\s]*[\\/]opencode[\\/]node_modules[\\/]opencode-swarm/,
		);
	});
});

describe('evictLockFiles', () => {
	let tempDir: string;
	let xdgCacheHome: string;
	let xdgConfigHome: string;
	const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-lock-'));
		xdgCacheHome = join(tempDir, 'cache');
		xdgConfigHome = join(tempDir, 'config');
		process.env.XDG_CACHE_HOME = xdgCacheHome;
		process.env.XDG_CONFIG_HOME = xdgConfigHome;
	});

	afterEach(async () => {
		if (originalXdgCacheHome === undefined) {
			delete process.env.XDG_CACHE_HOME;
		} else {
			process.env.XDG_CACHE_HOME = originalXdgCacheHome;
		}
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		}
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('deletes bun.lock file when it exists in ~/.cache/opencode/', async () => {
		// Note: evictLockFiles() reads OPENCODE_PLUGIN_LOCK_FILE_PATHS which is
		// captured at module-load time. We verify behavior via the CLI subprocess
		// since the env vars must be set before module import.
		const lockDir = join(xdgCacheHome, 'opencode');
		const lockPath = join(lockDir, 'bun.lock');
		await mkdir(lockDir, { recursive: true });
		await writeFile(lockPath, '{}');

		const proc = Bun.spawn([process.execPath, 'run', CLI_PATH, 'update'], {
			env: {
				...process.env,
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		expect(exitCode).toBe(0);
		expect(stdout).toContain('✓ Cleared lock file:');
		expect(stdout).toContain('bun.lock');
		expect(existsSync(lockPath)).toBe(false);
	});

	test('reports EISDIR when bun.lock is actually a directory', async () => {
		// If a path that should be a file is a directory, unlinkSync throws
		// EISDIR. The handler converts this to a friendly message.
		const lockDir = join(xdgCacheHome, 'opencode');
		const lockAsDir = join(lockDir, 'bun.lock');
		await mkdir(lockAsDir, { recursive: true });

		const proc = Bun.spawn([process.execPath, 'run', CLI_PATH, 'update'], {
			env: {
				...process.env,
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		// Lock file failure → exit 1
		expect(exitCode).toBe(1);
		expect(stderr).toContain('Could not clear lock file');
		expect(stderr).toContain('path is a directory');
	});

	test('no-cache-found path lists lock file paths in console output', async () => {
		// No cache, no lock files — should list both.
		const proc = Bun.spawn([process.execPath, 'run', CLI_PATH, 'update'], {
			env: {
				...process.env,
				XDG_CACHE_HOME: xdgCacheHome,
				XDG_CONFIG_HOME: xdgConfigHome,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		expect(exitCode).toBe(0);
		expect(stdout).toContain('No cached plugin found');
		expect(stdout).toContain('Checked locations:');
		expect(stdout).toContain('Lock files checked:');
		expect(stdout).toMatch(/cache[\\/]opencode[\\/]bun\.lock/);
		expect(stdout).toMatch(/cache[\\/]opencode[\\/]bun\.lockb/);
		expect(stdout).toMatch(/config[\\/]opencode[\\/]package-lock\.json/);
	});
});

describe('isSafeLockFilePath', () => {
	test('rejects /bun.lock (too shallow)', () => {
		expect(isSafeLockFilePath('/bun.lock')).toBe(false);
	});

	test('rejects ~/bun.lock (in home directly)', () => {
		const homeFile = join(process.env.HOME || '/home/user', 'bun.lock');
		expect(isSafeLockFilePath(homeFile)).toBe(false);
	});

	test('rejects /some/random/dir/bun.lock (parent not opencode)', () => {
		expect(isSafeLockFilePath('/some/random/dir/bun.lock')).toBe(false);
	});

	test('rejects ~/.cache/opencode/random.lock (wrong basename)', () => {
		const home = process.env.HOME || '/home/user';
		expect(
			isSafeLockFilePath(join(home, '.cache', 'opencode', 'random.lock')),
		).toBe(false);
	});

	test('accepts <tmpDir>/.cache/opencode/bun.lock when path is deep enough', async () => {
		// Use a real tmpDir (which is on Linux CI deep enough: /tmp/xxx/.cache/opencode/bun.lock).
		const tmp = await mkdtemp(join(tmpdir(), 'opencode-lock-safe-'));
		try {
			const lockPath = join(tmp, '.cache', 'opencode', 'bun.lock');
			expect(isSafeLockFilePath(lockPath)).toBe(true);
			// Also verify other recognized basenames:
			expect(
				isSafeLockFilePath(join(tmp, '.cache', 'opencode', 'bun.lockb')),
			).toBe(true);
			expect(
				isSafeLockFilePath(
					join(tmp, '.config', 'opencode', 'package-lock.json'),
				),
			).toBe(true);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});
});

describe('isSafeCachePath cross-platform path acceptance', () => {
	test('accepts a darwin-style ~/Library/Caches/opencode/node_modules/opencode-swarm path', () => {
		// String-only check: build the path manually. We do NOT create it on disk
		// because Library/Caches doesn't exist on Linux CI.
		const darwinPath =
			'/Users/testuser/Library/Caches/opencode/node_modules/opencode-swarm';
		expect(isSafeCachePath(darwinPath)).toBe(true);
	});

	test('accepts a Windows-style %LOCALAPPDATA%/opencode/node_modules/opencode-swarm path', () => {
		// Use forward slashes for cross-platform compatibility on Linux CI.
		// path.resolve will normalize. The key invariants are:
		// segments ≥ 4, leaf is opencode-swarm, parent is node_modules,
		// grandparent is opencode.
		const winPath =
			'/c/Users/testuser/AppData/Local/opencode/node_modules/opencode-swarm';
		expect(isSafeCachePath(winPath)).toBe(true);
	});

	test('accepts a darwin packages-style path', () => {
		const darwinPkg =
			'/Users/testuser/Library/Caches/opencode/packages/opencode-swarm@latest';
		expect(isSafeCachePath(darwinPkg)).toBe(true);
	});
});
