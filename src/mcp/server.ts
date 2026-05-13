import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as tools from '../tools/index.js';
import { TOOL_NAME_SET } from '../tools/tool-names.js';
import type { ToolContext } from '@opencode-ai/plugin';

/**
 * Creates and configures an MCP server instance.
 */
export async function createMcpServer(projectRoot: string) {
	const server = new McpServer({
		name: 'gemini-swarm',
		version: '7.18.2',
	});

	// Register tools from the swarm toolkit
	for (const [name, toolObj] of Object.entries(tools)) {
		// Only register tools that are in the canonical TOOL_NAME_SET
		if (!TOOL_NAME_SET.has(name as any)) continue;

		// Basic validation that it's a tool object
		if (!toolObj || typeof (toolObj as any).execute !== 'function') continue;

		const t = toolObj as any;

		server.tool(
			name,
			t.description || 'No description provided',
			t.args || {},
			async (args: any) => {
				const ctx: ToolContext = {
					directory: projectRoot,
				} as any;

				try {
					const result = await t.execute(args, ctx);

					// Swarm tools usually return a string or {output: string}
					let text: string;
					if (typeof result === 'string') {
						text = result;
					} else if (result && typeof result === 'object' && 'output' in result) {
						text = String(result.output);
					} else {
						text = JSON.stringify(result, null, 2);
					}

					return {
						content: [{ type: 'text' as const, text }],
					};
				} catch (error) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						isError: true,
					};
				}
			},
		);
	}

	return server;
}

/**
 * Starts the MCP server using StdioServerTransport.
 */
export async function startMcpServer(projectRoot: string) {
	const server = await createMcpServer(projectRoot);
	const transport = new StdioServerTransport();

	// Handle cleanup
	const cleanup = async () => {
		try {
			await server.close();
		} catch (err) {
			console.error('Error closing MCP server:', err);
		} finally {
			process.exit(0);
		}
	};

	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);

	await server.connect(transport);
	
	// Keep the process alive until terminated
	return new Promise(() => {});
}
