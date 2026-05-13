import * as path from 'node:path';
import { startMcpServer } from '../mcp/server.js';

/**
 * CLI handler for the 'mcp' command.
 * Parses arguments and starts the MCP server.
 */
export async function handleMcpCommand(args: string[]): Promise<number> {
	let directory = process.cwd();

	// Parse --directory flag
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--directory' && i + 1 < args.length) {
			directory = path.resolve(args[i + 1]);
			break;
		}
	}

	try {
		console.error(`🐝 Starting MCP server in ${directory}...`);
		await startMcpServer(directory);
		return 0;
	} catch (error) {
		console.error('✗ Failed to start MCP server:', error);
		return 1;
	}
}
