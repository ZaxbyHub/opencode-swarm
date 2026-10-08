import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliChildEnv } from '../../helpers/cli-child-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const CLI_TIMEOUT_MS = 30_000;

async function runCLI(
	args: string[],
	env: Record<string, string>,
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

describe('CLI uninstall — cleanup preserving edge cases (#2579)', () => {
	let tempDir: string;
	let outsideDir: string;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('opencode-swarm-uninstall-2579-');
		outsideDir = canonicalMkdtemp('opencode-swarm-uninstall-outside-2579-');
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(outsideDir, { recursive: true, force: true });
	});

	function env(): Record<string, string> {
		return {
			XDG_CONFIG_HOME: tempDir,
			XDG_CACHE_HOME: join(tempDir, 'cache'),
		};
	}

	function paths() {
		const configDir = join(tempDir, 'opencode');
		return {
			host: join(configDir, 'opencode.json'),
			plugin: join(configDir, 'opencode-swarm.json'),
			prompts: join(configDir, 'opencode-swarm'),
			backup: join(configDir, 'opencode.swarm-install-backup.json'),
		};
	}

	async function writeLeftovers() {
		const owned = paths();
		await writeFile(owned.plugin, '{"preset":"remote"}\n', 'utf8');
		await mkdir(owned.prompts, { recursive: true });
		await writeFile(join(owned.prompts, 'custom.md'), '# custom\n', 'utf8');
		await writeFile(owned.backup, '{"plugin":["opencode-swarm"]}\n', 'utf8');
		return owned;
	}

	test('plain uninstall leaves plugin-owned leftovers untouched', async () => {
		const owned = await writeLeftovers();
		const originalHost = JSON.stringify({ plugin: ['other-plugin'] }, null, 2);
		await writeFile(owned.host, originalHost, 'utf8');

		const result = await runCLI(['uninstall'], env());

		expect(result.exitCode).toBe(0);
		expect(await readFile(owned.host, 'utf8')).toBe(originalHost);
		expect(existsSync(owned.plugin)).toBe(true);
		expect(existsSync(owned.prompts)).toBe(true);
		expect(existsSync(owned.backup)).toBe(true);
		expect(result.stdout).not.toContain('Removed plugin config');
	});

	test('absent-host clean distinguishes cleanup from a second no-op run', async () => {
		const owned = await writeLeftovers();

		const first = await runCLI(['uninstall', '--clean'], env());
		const second = await runCLI(['uninstall', '--clean'], env());

		expect(first.exitCode).toBe(0);
		expect(first.stdout).toContain('Removed plugin config');
		expect(first.stdout).not.toContain('Nothing to uninstall');
		expect(first.stdout).not.toContain('No config files to clean up');
		expect(second.exitCode).toBe(0);
		expect(second.stdout).toContain('Nothing to uninstall');
		expect(second.stdout).toContain('No config files to clean up');
		expect(second.stdout).not.toContain('Removed plugin config');
		expect(existsSync(owned.plugin)).toBe(false);
		expect(existsSync(owned.prompts)).toBe(false);
		expect(existsSync(owned.backup)).toBe(false);
	});

	test('wrong-type plugin field refuses without clean and preserves all bytes', async () => {
		const owned = await writeLeftovers();
		const originalHost =
			'{\n  "plugin": "opencode-swarm",\n  "keep": true\n}\n';
		await writeFile(owned.host, originalHost, 'utf8');

		const result = await runCLI(['uninstall'], env());

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('unexpected type');
		expect(await readFile(owned.host, 'utf8')).toBe(originalHost);
		expect(existsSync(owned.plugin)).toBe(true);
		expect(existsSync(owned.prompts)).toBe(true);
		expect(existsSync(owned.backup)).toBe(true);
	});

	test('wrong-type plugin field preserves host bytes while clean removes owned leftovers', async () => {
		const owned = await writeLeftovers();
		const originalHost =
			'{\n  "plugin": "opencode-swarm",\n  "keep": true\n}\n';
		await writeFile(owned.host, originalHost, 'utf8');

		const result = await runCLI(['uninstall', '--clean'], env());

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain('unexpected type');
		expect(await readFile(owned.host, 'utf8')).toBe(originalHost);
		expect(existsSync(owned.plugin)).toBe(false);
		expect(existsSync(owned.prompts)).toBe(false);
		expect(existsSync(owned.backup)).toBe(false);
	});

	test.each([
		['empty plugin array', '{\n  "plugin": []\n}\n'],
		['non-matching plugin array', '{\n  "plugin": ["other-plugin"]\n}\n'],
	])('%s clean removes leftovers without rewriting the host config', async (_label, originalHost) => {
		const owned = await writeLeftovers();
		await writeFile(owned.host, originalHost, 'utf8');

		const result = await runCLI(['uninstall', '--clean'], env());

		expect(result.exitCode).toBe(0);
		expect(await readFile(owned.host, 'utf8')).toBe(originalHost);
		expect(existsSync(owned.plugin)).toBe(false);
		expect(existsSync(owned.prompts)).toBe(false);
		expect(existsSync(owned.backup)).toBe(false);
	});

	test('malformed host config still cleans owned files, preserves bytes, and fails', async () => {
		const owned = await writeLeftovers();
		const originalHost = '{\n  "plugin": ["opencode-swarm"],\n';
		await writeFile(owned.host, originalHost, 'utf8');

		const result = await runCLI(['uninstall', '--clean'], env());

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Could not parse');
		expect(await readFile(owned.host, 'utf8')).toBe(originalHost);
		expect(existsSync(owned.plugin)).toBe(false);
		expect(existsSync(owned.prompts)).toBe(false);
		expect(existsSync(owned.backup)).toBe(false);
	});

	test('refuses cleanup when the plugin config resolves outside its safe target', async () => {
		const owned = paths();
		const outsideMarker = join(outsideDir, 'must-survive.txt');
		await writeFile(outsideMarker, 'do not remove\n', 'utf8');
		const linkType = process.platform === 'win32' ? 'junction' : 'dir';
		symlinkSync(outsideDir, owned.plugin, linkType);

		const result = await runCLI(['uninstall', '--clean'], env());

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Refused to remove plugin config');
		expect(result.stdout).not.toContain('No config files to clean up');
		expect(existsSync(owned.plugin)).toBe(true);
		expect(existsSync(outsideMarker)).toBe(true);
	});

	test('refuses same-basename outside links for every owned cleanup target', async () => {
		const owned = paths();
		const outsideConfigDir = join(outsideDir, 'opencode');
		const outsidePrompts = join(outsideConfigDir, 'opencode-swarm');
		const outsidePlugin = join(outsideConfigDir, 'opencode-swarm.json');
		const outsideBackup = join(
			outsideConfigDir,
			'opencode.swarm-install-backup.json',
		);
		await mkdir(outsidePrompts, { recursive: true });
		await writeFile(
			join(outsidePrompts, 'must-survive.md'),
			'# survive\n',
			'utf8',
		);
		await writeFile(outsidePlugin, 'plugin must survive\n', 'utf8');
		await writeFile(outsideBackup, 'backup must survive\n', 'utf8');

		const fallbackLinkType = process.platform === 'win32' ? 'junction' : 'dir';
		const linkFileOrFallbackDirectory = (
			targetFile: string,
			linkPath: string,
		): void => {
			try {
				symlinkSync(targetFile, linkPath, 'file');
			} catch {
				// Windows may disallow file symlinks without developer mode.
				// A directory junction still exercises the canonical-parent
				// refusal and keeps the external directory observable.
				symlinkSync(outsideConfigDir, linkPath, fallbackLinkType);
			}
		};
		linkFileOrFallbackDirectory(outsidePlugin, owned.plugin);
		linkFileOrFallbackDirectory(outsideBackup, owned.backup);
		try {
			symlinkSync(
				outsidePrompts,
				owned.prompts,
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		} catch {
			symlinkSync(outsideDir, owned.prompts, fallbackLinkType);
		}

		const result = await runCLI(['uninstall', '--clean'], env());

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Refused to remove plugin config');
		expect(result.stdout).toContain('Refused to remove custom prompts');
		expect(result.stdout).toContain('Refused to remove install backup');
		expect(result.stdout).not.toContain('No config files to clean up');
		expect(await readFile(outsidePlugin, 'utf8')).toBe('plugin must survive\n');
		expect(await readFile(outsideBackup, 'utf8')).toBe('backup must survive\n');
		expect(
			await readFile(join(outsidePrompts, 'must-survive.md'), 'utf8'),
		).toBe('# survive\n');
	});

	test('allows a configured-root directory link while preserving exact binding', async () => {
		const owned = await writeLeftovers();
		const configuredAlias = join(outsideDir, 'configured-alias');
		symlinkSync(
			tempDir,
			configuredAlias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		const result = await runCLI(['uninstall', '--clean'], {
			...env(),
			XDG_CONFIG_HOME: configuredAlias,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain('Refused to remove');
		expect(existsSync(owned.plugin)).toBe(false);
		expect(existsSync(owned.prompts)).toBe(false);
		expect(existsSync(owned.backup)).toBe(false);
	});
});
