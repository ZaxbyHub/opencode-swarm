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
import { validateProjectDirectory } from '../utils/path-security.js';

export interface McpServeArgs {
	root: string;
	allowWrite: boolean;
}

export function parseMcpServeArgs(
	argv: string[],
): McpServeArgs | { error: string } {
	let root = '';
	let allowWrite = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--dir') {
			root = argv[i + 1] ?? '';
			i += 1;
		} else if (arg.startsWith('--dir=')) {
			root = arg.slice('--dir='.length);
		} else if (arg === '--allow-write') {
			// Recognized forward-compat seam (#2500): never errors, adds no
			// write tools in Phase 1 (the registry denylist stays fail-closed).
			allowWrite = true;
		} else {
			return { error: `unknown argument: ${arg}` };
		}
	}
	if (!root) {
		return { error: 'mcp serve requires --dir <project-root>' };
	}
	return { root, allowWrite };
}

/** Resolve + fail-closed validate the configured project root. */
export function resolveMcpRoot(
	input: string,
): { root: string } | { error: string } {
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
	return { root: resolved };
}

export async function handleMcpCommand(argv: string[]): Promise<number> {
	if (argv[0] !== 'serve') {
		console.error(
			'Usage: opencode-swarm mcp serve --dir <project-root> [--allow-write]',
		);
		return argv.length === 0 ? 1 : 1;
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
		// Dynamic import: keeps the SDK out of the CLI entry chunk.
		const { runMcpServer } = await import('../mcp/server.js');
		return await runMcpServer({
			root: rootResult.root,
			allowWrite: parsed.allowWrite,
		});
	} catch (error) {
		console.error(
			`mcp serve: failed to start: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
}
