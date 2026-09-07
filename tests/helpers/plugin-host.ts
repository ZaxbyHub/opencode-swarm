import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import OpenCodeSwarmPlugin from '../../src/index';
import { canonicalMkdtemp } from './tmpdir';

function ctxFor(directory: string, client: unknown = {}) {
	return {
		client,
		project: {} as unknown,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as unknown,
	};
}

/**
 * Create a throwaway project directory for a real-plugin-host boot. The
 * `.opencode/` subdir carries the config the plugin loader reads.
 */
export function createPluginHostProject(prefix: string): string {
	const directory = canonicalMkdtemp(prefix);
	mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	return directory;
}

export interface BootedPluginHost {
	/** The hooks object returned by the plugin's server() — the REGISTERED host hooks. */
	hooks: Record<string, (...args: unknown[]) => Promise<unknown>>;
	tool: Record<
		string,
		{ execute: (args: unknown, dir: string, ctx: unknown) => Promise<unknown> }
	>;
	directory: string;
}

/**
 * Boot the REAL plugin (src/index.ts server()) against a fresh temp project
 * directory and return its registered hooks. This is the fixture for driving
 * host-hook surfaces through the registered production path rather than by
 * calling hook factories directly (issue #2533; reused by #2585's
 * interrupt/restart/compaction scenarios).
 *
 * `configOverrides` is shallow-merged over `{ version_check: false }` at the
 * top level (a nested key like `hooks` replaces that key wholesale), then
 * written to the project's `.opencode/opencode-swarm.json`. The config loader
 * itself deep-merges this project config over the user-level config; tests
 * that care about a flag must set it explicitly.
 */
export async function bootSwarmPluginHost(
	directory: string,
	configOverrides: Record<string, unknown> = {},
	client: unknown = {},
): Promise<BootedPluginHost> {
	writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ version_check: false, ...configOverrides }, null, 2),
	);
	const result = await (
		OpenCodeSwarmPlugin as unknown as {
			server: (
				ctx: ReturnType<typeof ctxFor>,
			) => Promise<Record<string, unknown>>;
		}
	).server(ctxFor(directory, client));
	return {
		hooks: result as unknown as Record<
			string,
			(...args: unknown[]) => Promise<unknown>
		>,
		tool: (result.tool ?? {}) as Record<
			string,
			{
				execute: (args: unknown, dir: string, ctx: unknown) => Promise<unknown>;
			}
		>,
		directory,
	};
}
