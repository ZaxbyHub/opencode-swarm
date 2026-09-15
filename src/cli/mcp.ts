/**
 * `swarm mcp serve` CLI handler (#2499).
 *
 * Starts the read-only MCP verification server over stdio for ONE
 * configured project root. This is a long-running CLI-only entry — it is
 * deliberately NOT a `/swarm` registry command, because a stdio server must
 * own the process stdin/stdout that an in-session command cannot.
 *
 * The MCP server module is DYNAMICALLY imported so the official SDK lands
 * in a split chunk of the CLI bundle rather than growing the
 * `dist/cli/index.js` entry (2.4 MB packaging cap), and the plugin bundle
 * (`dist/index.js`) never imports it at all (init-bounded, invariant 1/2).
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RunMcpServerOptions } from '../mcp/server.js';
import { validateProjectDirectory } from '../utils/path-security.js';
import { resolveProjectRootDecision } from '../utils/project-boundary.js';

export interface McpServeArgs {
	root: string;
	allowWrite: boolean;
	/** Explicitly requested, reviewed write tools. Omitted for read-only startup. */
	writeTools?: string[];
}

/**
 * MCP writes are a closed set at the CLI boundary. Keep this list deliberately
 * local to the CLI entry so parsing the CLI does not pull the MCP registry and
 * the SDK into the CLI's main chunk; the registry repeats the same allowlist at
 * the dynamic-server boundary.
 */
const REVIEWED_WRITE_TOOLS = new Set(['knowledge_add']);

export function parseMcpServeArgs(
	argv: string[],
): McpServeArgs | { error: string } {
	let root = '';
	let allowWrite = false;
	let writeTools: string[] | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dir') {
			root = argv[i + 1] ?? '';
			i += 1;
		} else if (arg.startsWith('--dir=')) {
			root = arg.slice('--dir='.length);
		} else if (arg === '--allow-write') {
			allowWrite = true;
		} else if (arg === '--write-tool') {
			const requested = argv[i + 1];
			if (
				requested === undefined ||
				requested === '' ||
				requested.startsWith('--')
			) {
				return { error: '--write-tool requires a reviewed tool name' };
			}
			i += 1;
			if (!REVIEWED_WRITE_TOOLS.has(requested)) {
				return { error: `unknown or unauthorized write tool: ${requested}` };
			}
			if (writeTools?.includes(requested)) {
				return { error: `duplicate --write-tool: ${requested}` };
			}
			if (!writeTools) writeTools = [];
			writeTools.push(requested);
		} else if (arg.startsWith('--write-tool=')) {
			const requested = arg.slice('--write-tool='.length);
			if (!requested) {
				return { error: '--write-tool requires a reviewed tool name' };
			}
			if (!REVIEWED_WRITE_TOOLS.has(requested)) {
				return { error: `unknown or unauthorized write tool: ${requested}` };
			}
			if (writeTools?.includes(requested)) {
				return { error: `duplicate --write-tool: ${requested}` };
			}
			if (!writeTools) writeTools = [];
			writeTools.push(requested);
		} else {
			return { error: `unknown argument: ${arg}` };
		}
	}
	if (!root) {
		return { error: 'mcp serve requires --dir <project-root>' };
	}
	if (writeTools && !allowWrite) {
		return { error: '--write-tool requires --allow-write' };
	}
	return writeTools ? { root, allowWrite, writeTools } : { root, allowWrite };
}

/** Resolve + fail-closed validate the configured project root. */
export function resolveMcpRoot(
	input: string,
): { root: string; redirectedFrom?: string } | { error: string } {
	const resolved = path.isAbsolute(input)
		? path.normalize(input)
		: path.resolve(process.cwd(), input);
	try {
		validateProjectDirectory(resolved);
	} catch (error) {
		return {
			error: `invalid --dir: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		return { error: `invalid --dir: not an existing directory: ${resolved}` };
	}
	// Project-root ownership (#2679): apply the same boundary policy as plugin
	// bootstrap. An ordinary child of a project root that owns `.swarm/` state
	// resolves to the parent (with a startup line naming the served root);
	// indeterminable ownership fails closed instead of writing state somewhere
	// unverifiable.
	const decision = resolveProjectRootDecision(resolved);
	if (decision.kind === 'fail-closed') {
		return {
			error: `invalid --dir: cannot verify project root for "${resolved}" — ${decision.reason}`,
		};
	}
	if (decision.kind === 'redirect') {
		// biome-ignore lint/suspicious/noConsole: operator must see which project root the MCP server actually serves after the #2679 redirect
		console.log(
			`[opencode-swarm] mcp serve: --dir "${resolved}" is an ordinary subdirectory — serving the owning project root "${decision.owningRoot}" (state and config live there).`,
		);
		return { root: decision.owningRoot, redirectedFrom: resolved };
	}
	return { root: resolved };
}

type McpServerRunner = (options: RunMcpServerOptions) => Promise<number>;

/** Internal transport seam for CLI-to-server wiring tests. */
export const _internals: { runMcpServer: McpServerRunner } = {
	runMcpServer: async (options) => {
		// Dynamic import keeps the SDK out of the CLI entry chunk.
		const { runMcpServer } = await import('../mcp/server.js');
		return runMcpServer(options);
	},
};

export async function handleMcpCommand(argv: string[]): Promise<number> {
	if (argv[0] !== 'serve') {
		console.error(
			'Usage: opencode-swarm mcp serve --dir <project-root> [--allow-write] [--write-tool knowledge_add]',
		);
		return 1;
	}
	const parsed = parseMcpServeArgs(argv.slice(1));
	if ('error' in parsed) {
		console.error(`mcp serve: ${parsed.error}`);
		return 1;
	}
	const rootResult = resolveMcpRoot(parsed.root);
	if ('error' in rootResult) {
		console.error(`mcp serve: ${rootResult.error}`);
		return 1;
	}
	try {
		return await _internals.runMcpServer({
			root: rootResult.root,
			allowWrite: parsed.allowWrite,
			...(parsed.writeTools ? { writeTools: parsed.writeTools } : {}),
		});
	} catch (error) {
		console.error(
			`mcp serve: failed to start: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
}
