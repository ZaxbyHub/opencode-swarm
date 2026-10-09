import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliChildEnv } from '../../helpers/cli-child-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const CLI_TIMEOUT_MS = 30_000;

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const childEnv = cliChildEnv(env);
	delete childEnv.OPENCODE_CONFIG_DIR;
	const proc = Bun.spawn([process.execPath, 'run', CLI_PATH, ...args], {
		cwd: REPO_ROOT,
		env: childEnv,
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

describe('CLI uninstall — cleanup regression (#2579)', () => {
	let tempDir: string;
	let env: Record<string, string>;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-uninstall-2579-');
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
		env = {
			XDG_CONFIG_HOME: tempDir,
			XDG_CACHE_HOME: join(tempDir, 'cache'),
		};
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeAbsentConfigLeftovers(): Promise<{
		pluginConfigPath: string;
		promptsDir: string;
		backupPath: string;
	}> {
		// Before the fix, uninstall returned at the missing-host-config branch
		// before reaching the explicit --clean cleanup operations.
		const configDir = join(tempDir, 'opencode');
		const hostConfigPath = join(configDir, 'opencode.json');
		const pluginConfigPath = join(configDir, 'opencode-swarm.json');
		const promptsDir = join(configDir, 'opencode-swarm');
		const backupPath = join(configDir, 'opencode.swarm-install-backup.json');
		await writeFile(pluginConfigPath, '{"preset":"remote"}\n', 'utf8');
		await mkdir(promptsDir, { recursive: true });
		await writeFile(join(promptsDir, 'architect.md'), '# custom\n', 'utf8');
		await writeFile(backupPath, '{"plugin":["opencode-swarm"]}\n', 'utf8');
		expect(existsSync(hostConfigPath)).toBe(false);
		return { pluginConfigPath, promptsDir, backupPath };
	}

	test('clean removes plugin-owned leftovers without a host config', async () => {
		const { pluginConfigPath, promptsDir, backupPath } =
			await writeAbsentConfigLeftovers();

		const first = await runCLI(['uninstall', '--clean'], env);
		expect(first.exitCode).toBe(0);
		expect(first.stderr).toBe('');
		expect(existsSync(pluginConfigPath)).toBe(false);
		expect(existsSync(promptsDir)).toBe(false);
		expect(existsSync(backupPath)).toBe(false);
		expect(first.stdout).toContain('Removed plugin config');
		expect(first.stdout).toContain('Removed custom prompts');
		expect(first.stdout).toContain('Removed install backup');
	});

	test('a repeated absent-config clean is idempotent and reports no false removal', async () => {
		const { pluginConfigPath, promptsDir, backupPath } =
			await writeAbsentConfigLeftovers();
		const first = await runCLI(['uninstall', '--clean'], env);
		const second = await runCLI(['uninstall', '--clean'], env);

		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		expect(existsSync(pluginConfigPath)).toBe(false);
		expect(existsSync(promptsDir)).toBe(false);
		expect(existsSync(backupPath)).toBe(false);
		expect(second.stdout).not.toContain('Removed plugin config');
		expect(second.stdout).not.toContain('Removed custom prompts');
		expect(second.stdout).not.toContain('Removed install backup');
	});

	test('existing-host uninstall preserves unrelated settings and removes only swarm overrides', async () => {
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const original = {
			plugin: ['opencode-swarm', 'other-plugin', 'opencode-swarm@1.0.0'],
			settings: { keep: true },
			agent: {
				explore: { disable: true },
				general: { disable: true },
				custom: { model: 'custom-model' },
			},
		};
		await writeFile(configPath, JSON.stringify(original, null, 2), 'utf8');

		const result = await runCLI(['uninstall'], env);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Removed opencode-swarm');
		const updated = JSON.parse(await readFile(configPath, 'utf8')) as {
			plugin: string[];
			settings: { keep: boolean };
			agent: { custom: { model: string } };
		};
		expect(updated.plugin).toEqual(['other-plugin']);
		expect(updated.settings).toEqual({ keep: true });
		expect(updated.agent).toEqual({ custom: { model: 'custom-model' } });
	});
});
