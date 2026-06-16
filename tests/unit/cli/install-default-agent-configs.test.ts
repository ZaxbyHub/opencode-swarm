import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ALL_SUBAGENT_NAMES,
	DEFAULT_AGENT_CONFIGS,
	ORCHESTRATOR_NAME,
} from '../../../src/config/constants';
import { loadPluginConfig } from '../../../src/config/loader';

const CLI_PATH = join(import.meta.dir, '../../../src/cli/index.ts');

// On Windows, bun.cmd must be used instead of 'bun'
const BUN_BINARY = process.platform === 'win32' ? 'bun.cmd' : 'bun';

async function runCLI(
	args: string[],
	env: Record<string, string> = {},
	cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([BUN_BINARY, 'run', CLI_PATH, ...args], {
		env: { ...process.env, ...env },
		cwd: cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { exitCode, stdout, stderr };
}

describe('DEFAULT_AGENT_CONFIGS', () => {
	describe('structure', () => {
		test('each entry has model and fallback_models properties', () => {
			for (const [agent, config] of Object.entries(DEFAULT_AGENT_CONFIGS)) {
				expect(typeof config.model).toBe('string');
				expect(config.model.length).toBeGreaterThan(0);
				expect(Array.isArray(config.fallback_models)).toBe(true);
				expect(config.fallback_models.length).toBeGreaterThan(0);
				for (const fallback of config.fallback_models) {
					expect(typeof fallback).toBe('string');
					expect(fallback.length).toBeGreaterThan(0);
				}
			}
		});

		// Note: The same model may appear in both model and fallback_models by design
		// (e.g. big-pickle as primary and gpt-5-nano with big-pickle as fallback).
		// This is intentional - big-pickle is a reliable fallback target.
	});

	describe('coverage', () => {
		const EXPECTED_AGENTS = new Set([
			'coder',
			'reviewer',
			'test_engineer',
			'explorer',
			'sme',
			'critic',
			'docs',
			'designer',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_architecture_supervisor',
			'critic_oversight',
			'curator_init',
			'curator_phase',
			'skill_improver',
			'spec_writer',
		]);

		test('contains all expected pipeline/QA/support agents (17 entries)', () => {
			const actualKeys = new Set(Object.keys(DEFAULT_AGENT_CONFIGS));
			for (const agent of EXPECTED_AGENTS) {
				expect(actualKeys).toContain(agent);
			}
			expect(Object.keys(DEFAULT_AGENT_CONFIGS)).toHaveLength(17);
		});

		test('does NOT contain architect (orchestrator has no DEFAULT_AGENT_CONFIGS entry)', () => {
			expect(DEFAULT_AGENT_CONFIGS).not.toHaveProperty(ORCHESTRATOR_NAME);
		});

		test('does NOT contain council agents (they derive from reviewer/critic/sme)', () => {
			expect(DEFAULT_AGENT_CONFIGS).not.toHaveProperty('council_generalist');
			expect(DEFAULT_AGENT_CONFIGS).not.toHaveProperty('council_skeptic');
			expect(DEFAULT_AGENT_CONFIGS).not.toHaveProperty('council_domain_expert');
		});
	});

	describe('model values are valid opencode model IDs', () => {
		test('all model strings start with "opencode/" prefix', () => {
			for (const [, config] of Object.entries(DEFAULT_AGENT_CONFIGS)) {
				expect(config.model.startsWith('opencode/')).toBe(true);
				for (const fallback of config.fallback_models) {
					expect(fallback.startsWith('opencode/')).toBe(true);
				}
			}
		});
	});
});

describe('writeProjectConfigIfMissing', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-project-config-'));
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('creates .opencode/opencode-swarm.json in cwd', async () => {
		const result = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result.exitCode).toBe(0);

		const configPath = join(tempDir, '.opencode', 'opencode-swarm.json');
		expect(existsSync(configPath)).toBe(true);
	});

	test('file contains empty agents object (not populated from DEFAULT_AGENT_CONFIGS)', async () => {
		await runCLI(['install'], { XDG_CONFIG_HOME: tempDir }, tempDir);

		const configPath = join(tempDir, '.opencode', 'opencode-swarm.json');
		const parsed = JSON.parse(await readFile(configPath, 'utf-8'));

		expect(parsed).toHaveProperty('agents');
		expect(typeof parsed.agents).toBe('object');
		expect(Object.keys(parsed.agents).length).toBe(0);
	});

	test('file does not contain default_agent (inherits from global config / schema defaults)', async () => {
		await runCLI(['install'], { XDG_CONFIG_HOME: tempDir }, tempDir);

		const configPath = join(tempDir, '.opencode', 'opencode-swarm.json');
		const parsed = JSON.parse(await readFile(configPath, 'utf-8'));

		expect(parsed).not.toHaveProperty('default_agent');
	});

	test('does NOT overwrite existing project config', async () => {
		// Pre-create an existing project config
		const opencodeDir = join(tempDir, '.opencode');
		await mkdir(opencodeDir, { recursive: true });
		const configPath = join(opencodeDir, 'opencode-swarm.json');
		const originalContent = {
			agents: { coder: { model: 'custom/model', fallback_models: [] } },
			default_agent: 'custom-agent',
			custom: true,
		};
		await writeFile(configPath, JSON.stringify(originalContent, null, 2));

		// Run install (which calls writeProjectConfigIfMissing)
		const result = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result.exitCode).toBe(0);

		// Config should be unchanged
		const parsed = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(parsed).toEqual(originalContent);
	});

	// Cross-platform error trigger: a regular file at the path where .opencode/
	// would be created causes mkdirSync to fail on both POSIX (EEXIST) and
	// Windows (EEXIST/ENOTDIR). The try/catch in writeProjectConfigIfMissing
	// must surface this as a warning, not abort the install.
	//
	// Note: XDG_CONFIG_HOME here is incidental — it only points the install
	// command at the test's tempDir. The test exercises the writeProjectConfigIfMissing
	// try/catch regardless of which env var (XDG_CONFIG_HOME on POSIX, APPDATA
	// on Windows) the production CLI uses internally. The actual production
	// env var resolution is the installer's job, not this test's job.
	test('does NOT abort install when .opencode path is blocked by a regular file', async () => {
		// Pre-create a regular file at the path where .opencode/ would be created
		const blockedPath = join(tempDir, '.opencode');
		await writeFile(blockedPath, 'blocked');

		const result = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result.exitCode).toBe(0);

		const combined = result.stdout + result.stderr;
		expect(combined).toContain('Could not create project config');

		const configPath = join(tempDir, '.opencode', 'opencode-swarm.json');
		expect(existsSync(configPath)).toBe(false);
	});

	test('creates fresh config when project config does not exist', async () => {
		await runCLI(['install'], { XDG_CONFIG_HOME: tempDir }, tempDir);

		const configPath = join(tempDir, '.opencode', 'opencode-swarm.json');
		expect(existsSync(configPath)).toBe(true);

		const parsed = JSON.parse(await readFile(configPath, 'utf-8'));
		expect(parsed).toEqual({ agents: {} });
	});
});

describe('install() uses DEFAULT_AGENT_CONFIGS', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-install-'));
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('install creates plugin config with agents from DEFAULT_AGENT_CONFIGS', async () => {
		const result = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result.exitCode).toBe(0);

		const pluginConfigPath = join(tempDir, 'opencode', 'opencode-swarm.json');
		expect(existsSync(pluginConfigPath)).toBe(true);

		const pluginConfig = JSON.parse(await readFile(pluginConfigPath, 'utf-8'));

		// Plugin config should have agents populated from DEFAULT_AGENT_CONFIGS
		expect(pluginConfig).toHaveProperty('agents');
		expect(typeof pluginConfig.agents).toBe('object');

		// Verify agent entries match DEFAULT_AGENT_CONFIGS structure
		for (const [agent, expectedConfig] of Object.entries(
			DEFAULT_AGENT_CONFIGS,
		)) {
			expect(pluginConfig.agents).toHaveProperty(agent);
			expect(pluginConfig.agents[agent].model).toBe(expectedConfig.model);
			expect(pluginConfig.agents[agent].fallback_models).toEqual(
				expectedConfig.fallback_models,
			);
		}
	});

	test('install does not overwrite plugin config if it already exists', async () => {
		const pluginConfigPath = join(tempDir, 'opencode', 'opencode-swarm.json');
		const originalPluginConfig = {
			agents: {
				coder: {
					model: 'custom/coder-model',
					fallback_models: ['custom/fallback'],
				},
			},
			max_iterations: 99,
			custom_field: true,
		};
		await writeFile(
			pluginConfigPath,
			JSON.stringify(originalPluginConfig, null, 2),
		);

		const result = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result.exitCode).toBe(0);

		const updated = JSON.parse(await readFile(pluginConfigPath, 'utf-8'));
		// Original config preserved
		expect(updated.custom_field).toBe(true);
		expect(updated.max_iterations).toBe(99);
		expect(updated.agents.coder.model).toBe('custom/coder-model');
	});

	test('install creates project config with empty agents and no default_agent', async () => {
		const result = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result.exitCode).toBe(0);

		const projectConfigPath = join(tempDir, '.opencode', 'opencode-swarm.json');
		expect(existsSync(projectConfigPath)).toBe(true);

		const projectConfig = JSON.parse(
			await readFile(projectConfigPath, 'utf-8'),
		);

		expect(projectConfig).toEqual({ agents: {} });
	});
});

describe('global config survives install', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-global-config-'));
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('custom models in global config are preserved after install', async () => {
		// Pre-populate global plugin config with a custom model
		const globalPluginConfigPath = join(
			tempDir,
			'opencode',
			'opencode-swarm.json',
		);
		const customGlobalConfig = {
			agents: {
				coder: {
					model: 'my-custom/model',
					fallback_models: ['my-custom/fallback'],
				},
			},
		};
		await writeFile(
			globalPluginConfigPath,
			JSON.stringify(customGlobalConfig, null, 2),
		);

		// Run install — should create minimal project config without clobbering global
		const result = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result.exitCode).toBe(0);

		// Project config must be minimal
		const projectConfigPath = join(tempDir, '.opencode', 'opencode-swarm.json');
		const projectConfig = JSON.parse(
			await readFile(projectConfigPath, 'utf-8'),
		);
		expect(projectConfig).toEqual({ agents: {} });

		// Loader must resolve global custom model, not the schema default.
		// Set XDG_CONFIG_HOME so getUserConfigDir() points to our temp dir.
		const origXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = tempDir;
		try {
			const resolved = loadPluginConfig(tempDir);
			expect(resolved.agents?.coder?.model).toBe('my-custom/model');
			expect(resolved.agents?.coder?.fallback_models).toEqual([
				'my-custom/fallback',
			]);
		} finally {
			if (origXdg === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = origXdg;
			}
		}
	});
});

describe('backward compatibility', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'opencode-swarm-backward-compat-'));
		await mkdir(join(tempDir, 'opencode'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('existing opencode.json plugin entries are preserved on reinstall', async () => {
		// Pre-existing config
		const opencodeJsonPath = join(tempDir, 'opencode', 'opencode.json');
		await writeFile(
			opencodeJsonPath,
			JSON.stringify({ plugin: ['other-plugin'], theme: 'dark' }, null, 2),
		);

		const result = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result.exitCode).toBe(0);

		const updated = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		// Original plugin entries preserved
		expect(updated.plugin).toContain('other-plugin');
		// opencode-swarm added
		expect(updated.plugin).toContain('opencode-swarm');
		// Original theme preserved
		expect(updated.theme).toBe('dark');
	});

	test('install is idempotent — running twice does not corrupt configs', async () => {
		const opencodeJsonPath = join(tempDir, 'opencode', 'opencode.json');
		const pluginConfigPath = join(tempDir, 'opencode', 'opencode-swarm.json');
		const projectConfigPath = join(tempDir, '.opencode', 'opencode-swarm.json');

		// First install
		const result1 = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result1.exitCode).toBe(0);

		const config1 = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		const pluginConfig1 = JSON.parse(await readFile(pluginConfigPath, 'utf-8'));

		// Second install
		const result2 = await runCLI(
			['install'],
			{ XDG_CONFIG_HOME: tempDir },
			tempDir,
		);
		expect(result2.exitCode).toBe(0);

		const config2 = JSON.parse(await readFile(opencodeJsonPath, 'utf-8'));
		const pluginConfig2 = JSON.parse(await readFile(pluginConfigPath, 'utf-8'));
		const projectConfig2 = JSON.parse(
			await readFile(projectConfigPath, 'utf-8'),
		);

		// opencode.json: plugin list should be identical (no duplicates)
		expect(config2.plugin).toEqual(config1.plugin);

		// Plugin config should be identical
		expect(pluginConfig2).toEqual(pluginConfig1);

		// Project config should still exist with minimal starter content
		expect(projectConfig2).toEqual({ agents: {} });
	});
});
