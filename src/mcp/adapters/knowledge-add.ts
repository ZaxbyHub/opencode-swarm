/**
 * Explicitly-authorized MCP knowledge_add adapter (#2500).
 *
 * This adapter owns only the MCP idempotency boundary. Validation,
 * actionability, deduplication, reinforcement, quarantine, and the atomic
 * knowledge transaction remain in the registered production knowledge_add
 * tool. The adapter passes a fixed server root and never accepts a
 * working-directory override.
 */

import { knowledge_add } from '../../tools/knowledge-add.js';
import {
	buildKnowledgeAddRequest,
	executeWithReceipt,
	type KnowledgeAddAdapterRuntime,
	knowledgeAddInput,
} from '../write-receipts.js';
import { mcpToolContext, safeParseJson } from './verification.js';

export interface McpKnowledgeAddWriteAdapter {
	name: 'knowledge_add';
	description: string;
	kind: 'write';
	pathFields: string[];
	inputSchema: typeof knowledgeAddInput;
	execute(
		rawArgs: unknown,
		root: string,
		runtime?: KnowledgeAddAdapterRuntime,
	): Promise<unknown>;
}

export async function executeKnowledgeAdd(
	rawArgs: unknown,
	root: string,
	runtime?: KnowledgeAddAdapterRuntime,
): Promise<unknown> {
	const { request, productionArgs } = buildKnowledgeAddRequest(
		root,
		rawArgs,
		runtime,
	);
	return executeWithReceipt(
		request,
		async () => {
			const result = await knowledge_add.execute(
				productionArgs,
				mcpToolContext(root),
			);
			return typeof result === 'string' ? safeParseJson(result) : result;
		},
		runtime?.hooks,
	);
}

export const knowledgeAddAdapter: McpKnowledgeAddWriteAdapter = {
	name: 'knowledge_add',
	description:
		'Store a new lesson in the knowledge base for future reference. This write is available only when the MCP server was started with explicit knowledge_add authorization.',
	kind: 'write',
	pathFields: [],
	inputSchema: knowledgeAddInput,
	execute: executeKnowledgeAdd,
};
