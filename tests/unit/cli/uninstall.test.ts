import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliChildEnv } from '../../helpers/cli-child-env';

const CLI_PATH = join(import.meta.dir, '../../../src/cli/index.ts');

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
		env: cliChildEnv(env),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

describe('CLI uninstall command', () => {
	let tempDir: string;
	let originalXDGConfig: string | undefined;

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

	test('Uninstall removes plugin from opencode.json', async () => {
		// Setup: Create opencode.json with plugin and agent overrides
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const configData = {
			plugin: ['opencode-swarm'],
			agent: {
				explore: { disable: true },
				general: { disable: true },
			},
		};
		await writeFile(configPath, JSON.stringify(configData, null, 2));

		// Run: Run uninstall command
		const result = await runCLI(['uninstall'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0 and success messages
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Removed opencode-swarm');
		expect(result.stdout).toContain('Re-enabled default OpenCode agents');

		// Assert: Verify opencode.json was updated
		const updatedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(updatedConfig.plugin).not.toContain('opencode-swarm');
		expect(updatedConfig.agent).toBeUndefined();
	});

	test('Uninstall with --clean removes config files', async () => {
		// Setup: Create opencode.json with plugin
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const configData = {
			plugin: ['opencode-swarm'],
			agent: {
				explore: { disable: true },
				general: { disable: true },
			},
		};
		await writeFile(configPath, JSON.stringify(configData, null, 2));

		// Setup: Create plugin config and prompts directory
		const pluginConfigPath = join(tempDir, 'opencode', 'opencode-swarm.json');
		const pluginConfigData = { preset: 'remote', swarm_mode: 'remote' };
		await writeFile(
			pluginConfigPath,
			JSON.stringify(pluginConfigData, null, 2),
		);

		const promptsDir = join(tempDir, 'opencode', 'opencode-swarm');
		await mkdir(promptsDir, { recursive: true });
		await writeFile(
			join(promptsDir, 'architect.md'),
			'# Custom Architect Prompt',
		);

		// Run: Run uninstall with --clean flag
		const result = await runCLI(['uninstall', '--clean'], {
			XDG_CONFIG_HOME: tempDir,
		});

		// Assert: Exit code 0 and success messages
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Removed opencode-swarm');
		expect(result.stdout).toContain('Removed plugin config');
		expect(result.stdout).toContain('Removed custom prompts');

		// Assert: Verify all files were deleted
		expect(existsSync(pluginConfigPath)).toBe(false);
		expect(existsSync(promptsDir)).toBe(false);

		// Assert: Verify opencode.json still exists but plugin was removed
		const updatedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(updatedConfig.plugin).not.toContain('opencode-swarm');
	});

	test('Uninstall when plugin not present (idempotent)', async () => {
		// Setup: Create opencode.json with other plugin only
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const configData = {
			plugin: ['other-plugin'],
		};
		await writeFile(configPath, JSON.stringify(configData, null, 2));

		// Run: Run uninstall command
		const result = await runCLI(['uninstall'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0 and not installed message
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('not installed');

		// Assert: Verify opencode.json was not changed
		const updatedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(updatedConfig.plugin).toEqual(['other-plugin']);
	});

	test('Uninstall with missing opencode.json (no config file exists)', async () => {
		// Setup: Create opencode dir but NO opencode.json
		const opencodeDir = join(tempDir, 'opencode');
		expect(existsSync(opencodeDir)).toBe(true);
		const configPath = join(opencodeDir, 'opencode.json');
		expect(existsSync(configPath)).toBe(false);

		// Run: Run uninstall command
		const result = await runCLI(['uninstall'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0 and no config found message
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('No opencode config found');
		expect(result.stdout).toContain('Nothing to uninstall');
	});

	test('Uninstall with malformed opencode.json', async () => {
		// Setup: Create opencode.json with invalid JSON
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		await writeFile(configPath, 'this is not valid json{{{');

		// Run: Run uninstall command
		const result = await runCLI(['uninstall'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 1 and parse error message
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Could not parse');
	});

	test('Uninstall with empty/missing plugin array', async () => {
		// Setup: Create opencode.json with no plugin field
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const configData = {
			other_key: true,
		};
		await writeFile(configPath, JSON.stringify(configData, null, 2));

		// Run: Run uninstall command
		const result = await runCLI(['uninstall'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0 and no plugins message
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('no plugins configured');

		// Assert: Verify opencode.json was not changed
		const updatedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(updatedConfig).toEqual(configData);
	});

	test('--clean with missing config files (silently succeeds)', async () => {
		// Setup: Create opencode.json with plugin but no extra files
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const configData = {
			plugin: ['opencode-swarm'],
			agent: {
				explore: { disable: true },
				general: { disable: true },
			},
		};
		await writeFile(configPath, JSON.stringify(configData, null, 2));

		// Ensure plugin config and prompts dir don't exist
		const pluginConfigPath = join(tempDir, 'opencode', 'opencode-swarm.json');
		const promptsDir = join(tempDir, 'opencode', 'opencode-swarm');
		expect(existsSync(pluginConfigPath)).toBe(false);
		expect(existsSync(promptsDir)).toBe(false);

		// Run: Run uninstall with --clean flag
		const result = await runCLI(['uninstall', '--clean'], {
			XDG_CONFIG_HOME: tempDir,
		});

		// Assert: Exit code 0 and no config files message
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('No config files to clean up');

		// Assert: Verify opencode.json was updated correctly
		const updatedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(updatedConfig.plugin).not.toContain('opencode-swarm');
	});

	test('Uninstall handles JSONC comments correctly', async () => {
		// Setup: Create opencode.json with comments (JSONC format)
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const configData = `{
            // This is a comment
            "plugin": ["opencode-swarm"], // inline comment
            "agent": {
                "explore": { "disable": true },
                "general": { "disable": true }
            }
        }`;
		await writeFile(configPath, configData);

		// Run: Run uninstall command
		const result = await runCLI(['uninstall'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0 and success messages
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Removed opencode-swarm');

		// Assert: Verify opencode.json was updated correctly (comments stripped)
		const updatedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(updatedConfig.plugin).not.toContain('opencode-swarm');
		expect(updatedConfig.agent).toBeUndefined();
	});

	test('Uninstall removes multiple plugin versions correctly', async () => {
		// Setup: Create opencode.json with multiple plugin versions
		const configPath = join(tempDir, 'opencode', 'opencode.json');
		const configData = {
			plugin: [
				'opencode-swarm',
				'opencode-swarm@1.0.0',
				'opencode-swarm@2.0.0',
				'other-plugin',
			],
			agent: {
				explore: { disable: true },
				general: { disable: true },
			},
		};
		await writeFile(configPath, JSON.stringify(configData, null, 2));

		// Run: Run uninstall command
		const result = await runCLI(['uninstall'], { XDG_CONFIG_HOME: tempDir });

		// Assert: Exit code 0 and success messages
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Removed opencode-swarm');

		// Assert: Verify all opencode-swarm entries were removed
		const updatedConfig = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(updatedConfig.plugin).toEqual(['other-plugin']);
		expect(updatedConfig.agent).toBeUndefined();
	});
});
