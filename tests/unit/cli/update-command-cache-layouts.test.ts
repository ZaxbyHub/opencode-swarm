import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeCachePath } from '../../../src/cli/index.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const CLI_TIMEOUT_MS = 30_000;

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, 'run', CLI_PATH, ...args], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: CLI_TIMEOUT_MS,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
		} catch {}
	}
}

describe('CLI update cache layouts', () => {
	let tempDir: string;
	let xdgCacheHome: string;
	let xdgConfigHome: string;
	let cachePaths: string[];

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-update-layouts-');
		xdgCacheHome = join(tempDir, 'cache');
		xdgConfigHome = join(tempDir, 'config');
		cachePaths = [
			join(xdgCacheHome, 'opencode', 'packages', 'opencode-swarm@latest'),
			join(xdgCacheHome, 'opencode', 'packages', 'opencode-swarm'),
			join(xdgConfigHome, 'opencode', 'node_modules', 'opencode-swarm'),
			join(xdgCacheHome, 'opencode', 'node_modules', 'opencode-swarm'),
		];
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test('clears all four supported cache layouts', async () => {
		for (const cachePath of cachePaths) {
			await mkdir(cachePath, { recursive: true });
		}

		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		for (const cachePath of cachePaths) {
			expect(existsSync(cachePath)).toBe(false);
		}
		expect(result.stdout.match(/✓ Cleared/g)?.length).toBeGreaterThanOrEqual(4);
	});

	test('lists all four supported cache layouts when none exists', async () => {
		const result = await runCLI(['update'], {
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_CONFIG_HOME: xdgConfigHome,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('No cached plugin found');
		expect(result.stdout).toMatch(/packages[\\/]opencode-swarm@latest/);
		expect(result.stdout).toMatch(/packages[\\/]opencode-swarm(?:\r?\n|$)/);
		expect(result.stdout).toMatch(
			/config[\\/]opencode[\\/]node_modules[\\/]opencode-swarm/,
		);
		expect(result.stdout).toMatch(
			/cache[\\/]opencode[\\/]node_modules[\\/]opencode-swarm/,
		);
	});

	test('accepts the legacy bare packages-style cache path', () => {
		expect(
			isSafeCachePath(
				'/Users/testuser/Library/Caches/opencode/packages/opencode-swarm',
			),
		).toBe(true);
	});
});
