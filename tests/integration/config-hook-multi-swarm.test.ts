import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenCodeSwarmPlugin from '../../src/index';

/**
 * Regression test (v7.3.5): plugin-side config hook must inject prefixed
 * primary architects into opencodeConfig.agent for a multi-swarm config.
 *
 * Prior bug (v7.3.x):
 *   - PluginConfigSchema applied .default("architect") to default_agent.
 *   - getAgentConfigs() then performed strict equality `agent.name === "architect"`.
 *   - In a multi-swarm config (no unprefixed `architect`), every *_architect
 *     was demoted to subagent and OpenCode's TUI/GUI showed only the native
 *     build/plan agents — "plugin loaded but no swarm architect agents".
 *
 * The fix removes the schema default, makes default_agent an optional string
 * with semantic resolution at agent-generation time, and treats the omitted
 * case as "every architect-role agent is primary".
 */
describe('plugin config hook — multi-swarm primary architect injection', () => {
	let tempDir: string;

	const ctxFor = (directory: string) => ({
		client: {} as unknown,
		project: {} as unknown,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as unknown,
	});

	beforeEach(async () => {
		// realpath wrapper to defang macOS /tmp -> /private/tmp symlink
		tempDir = realpathSync(
			await mkdtemp(path.join(tmpdir(), 'swarm-cfg-hook-')),
		);
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	async function bootPlugin(swarmConfig: Record<string, unknown>) {
		// loadPluginConfig reads from <directory>/.opencode/opencode-swarm.json
		const opencodeDir = path.join(tempDir, '.opencode');
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			path.join(opencodeDir, 'opencode-swarm.json'),
			JSON.stringify(swarmConfig, null, 2),
		);
		// New default export shape (post #735): { id, server }
		const result = await (
			OpenCodeSwarmPlugin as unknown as {
				server: (ctx: ReturnType<typeof ctxFor>) => Promise<unknown>;
			}
		).server(ctxFor(tempDir));
		return result as {
			agent?: Record<string, { mode?: string }>;
			config?: (oc: Record<string, unknown>) => Promise<void> | void;
		};
	}

	test('top-level agent map exposes prefixed primary architects (no default_agent)', async () => {
		const plugin = await bootPlugin({
			version_check: false,
			swarms: {
				local: { name: 'Local', agents: { coder: { model: 'm-local' } } },
				mega: { name: 'Mega', agents: { coder: { model: 'm-mega' } } },
				paid: { name: 'Paid', agents: { coder: { model: 'm-paid' } } },
				modelrelay: {
					name: 'Modelrelay',
					agents: { coder: { model: 'm-relay' } },
				},
			},
		});

		expect(plugin.agent).toBeDefined();
		const agents = plugin.agent as Record<string, { mode?: string }>;

		// Each *_architect must be primary.
		for (const name of [
			'local_architect',
			'mega_architect',
			'paid_architect',
			'modelrelay_architect',
		]) {
			expect(agents[name], `${name} should exist`).toBeDefined();
			expect(agents[name].mode, `${name} must be primary`).toBe('primary');
		}

		// At least one primary must exist (the regression-zeroing case).
		const primaries = Object.values(agents).filter((a) => a.mode === 'primary');
		expect(primaries.length).toBeGreaterThan(0);
	});

	test('config hook injects prefixed primary architects into opencodeConfig.agent', async () => {
		const plugin = await bootPlugin({
			version_check: false,
			swarms: {
				local: { name: 'Local', agents: { coder: { model: 'm-local' } } },
				mega: { name: 'Mega', agents: { coder: { model: 'm-mega' } } },
			},
		});

		expect(plugin.config).toBeTypeOf('function');
		const opencodeConfig: Record<string, unknown> = {};
		await plugin.config!(opencodeConfig);

		const injected = opencodeConfig.agent as
			| Record<string, { mode?: string }>
			| undefined;
		expect(injected).toBeDefined();
		expect(injected!['local_architect']).toBeDefined();
		expect(injected!['local_architect'].mode).toBe('primary');
		expect(injected!['mega_architect']).toBeDefined();
		expect(injected!['mega_architect'].mode).toBe('primary');
	});

	test('explicit default_agent: "local_architect" narrows primary to that one agent', async () => {
		const plugin = await bootPlugin({
			version_check: false,
			default_agent: 'local_architect',
			swarms: {
				local: { name: 'Local', agents: { coder: { model: 'm-local' } } },
				mega: { name: 'Mega', agents: { coder: { model: 'm-mega' } } },
			},
		});

		const agents = plugin.agent as Record<string, { mode?: string }>;
		expect(agents['local_architect'].mode).toBe('primary');
		expect(agents['mega_architect'].mode).toBe('subagent');
	});

	test('invariant: any non-empty generated agent set has at least one primary', async () => {
		// Sanity-check the diagnostic invariant against a config that previously
		// produced zero primaries (the v7.3.x bug).
		const plugin = await bootPlugin({
			version_check: false,
			swarms: {
				local: { name: 'Local', agents: { coder: { model: 'm-local' } } },
				mega: { name: 'Mega', agents: { coder: { model: 'm-mega' } } },
				paid: { name: 'Paid', agents: { coder: { model: 'm-paid' } } },
				modelrelay: {
					name: 'Modelrelay',
					agents: { coder: { model: 'm-relay' } },
				},
				lowtier: {
					name: 'Lowtier',
					agents: { coder: { model: 'm-low' } },
				},
			},
		});
		const agents = plugin.agent as Record<string, { mode?: string }>;
		expect(Object.keys(agents).length).toBeGreaterThan(0);
		const primaries = Object.values(agents).filter((a) => a.mode === 'primary');
		expect(primaries.length).toBeGreaterThan(0);
	});
});
