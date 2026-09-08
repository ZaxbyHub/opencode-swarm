/**
 * MCP stdio server for the read-only verification surface (#2499).
 *
 * One server instance = one configured project root. Every tool call is
 * containment-checked (path arguments must resolve inside the canonical
 * root, including symlink/junction escapes), executed through the registered
 * production implementations, and the response is redacted-then-bounded by
 * the response pipeline before it leaves the server.
 */

import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	isCanonicalPathWithinRoot,
	validateTargetWithinRoot,
} from '../utils/path-security.js';
import { buildMcpToolRegistry } from './registry.js';
import { applyResponsePipeline } from './pipeline.js';

const SERVER_NAME = 'opencode-swarm';

/** Containment rejection carried as a tool-level error result. */
export class McpContainmentError extends Error {
	constructor(
		readonly field: string,
		readonly value: string,
		readonly root: string,
	) {
		super(
			`path rejected by containment: field ${field} value ${value} resolves outside the configured root ${root}`,
		);
		this.name = 'McpContainmentError';
	}
}

function validatePathValue(
	field: string,
	value: string,
	root: string,
): void {
	if (typeof value !== 'string' || value === '') return;
	if (path.isAbsolute(value) || /^[A-Za-z]:[/\\]/.test(value)) {
		// Absolute argument: acceptable only when it stays inside the root,
		// lexically AND canonically (symlink/junction escape rejected).
		const resolved = path.resolve(value);
		const relative = path.relative(root, resolved);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new McpContainmentError(field, value, root);
		}
		if (!isCanonicalPathWithinRoot(resolved, root)) {
			throw new McpContainmentError(field, value, root);
		}
		return;
	}
	// Relative argument: the write-tool containment contract resolves against
	// the root and rejects traversal/control chars/symlink escapes itself.
	const reason = validateTargetWithinRoot(value, root);
	if (reason !== null) {
		throw new McpContainmentError(field, value, root);
	}
	const resolved = path.resolve(root, value);
	if (!isCanonicalPathWithinRoot(resolved, root)) {
		// Symlink/junction escape: lexically inside, canonically outside.
		throw new McpContainmentError(field, value, root);
	}
}

/** Walk a declared path field's value shape and validate every path. */
export function validatePathField(
	field: string,
	value: unknown,
	root: string,
): void {
	if (value === undefined || value === null) return;
	if (typeof value === 'string') {
		validatePathValue(field, value, root);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string') {
				validatePathValue(field, item, root);
			} else if (item && typeof item === 'object') {
				const obj = item as Record<string, unknown>;
				if (typeof obj.path === 'string') {
					validatePathValue(`${field}[].path`, obj.path, root);
				} else if (typeof obj.file === 'string') {
					validatePathValue(`${field}[].file`, obj.file, root);
				}
			}
		}
		return;
	}
	if (typeof value === 'object' && typeof (value as { file?: unknown }).file === 'string') {
		validatePathValue(`${field}.file`, (value as { file: string }).file, root);
	}
}

export interface RunMcpServerOptions {
	root: string;
	allowWrite?: boolean;
	/** Test seam: inject transports instead of stdio (InMemoryTransport pair). */
	transport?: { connect(server: unknown): Promise<void> } | undefined;
	version?: string;
}

/**
 * Build the MCP server (tools registered, containment + pipeline wired).
 * Exported for unit tests that drive the server over in-memory transports.
 */
export function createMcpServer(options: RunMcpServerOptions): McpServer {
	const root = options.root;
	const registry = buildMcpToolRegistry({
		root,
		allowWrite: options.allowWrite,
	});
	const server = new McpServer({
		name: SERVER_NAME,
		version: options.version ?? '0.0.0',
	});
	for (const tool of registry.tools) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
			},
			async (args: Record<string, unknown>) => {
				for (const field of tool.pathFields) {
					validatePathField(field, args[field], root);
				}
				try {
					const raw = await tool.execute(args, root);
					const { serialized } = applyResponsePipeline(raw);
					return {
						content: [{ type: 'text' as const, text: serialized }],
					};
				} catch (error) {
					if (error instanceof McpContainmentError) {
						return {
							content: [{ type: 'text' as const, text: error.message }],
							isError: true,
						};
					}
					const message =
						error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: 'text' as const, text: `error: ${message}` }],
						isError: true,
					};
				}
			},
		);
	}
	return server;
}

/** Serve the read-only verification surface over stdio until stdin closes. */
export async function runMcpServer(
	options: RunMcpServerOptions,
): Promise<number> {
	const server = createMcpServer(options);
	const transport =
		options.transport !== undefined
			? options.transport
			: new StdioServerTransport();
	// The SDK's connect signature takes a Transport; the test seam's looser
	// shape is funneled through unchanged.
	await server.connect(
		transport as unknown as Parameters<McpServer['connect']>[0],
	);
	if (options.transport === undefined) {
		// Stdio mode: hold the process open while the transport reads stdin.
		// The normal shutdown path is the client closing stdin (EOF), which
		// closes the transport and empties the event loop so the process exits
		// without this promise ever settling.
		await new Promise<void>(() => {});
	}
	return 0;
}
