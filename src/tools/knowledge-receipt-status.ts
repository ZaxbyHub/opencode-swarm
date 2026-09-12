/** Read-only status for an explicitly-authorized MCP knowledge write receipt. */

import {
	readWriteReceiptStatus,
	writeReceiptStatusInput,
} from '../mcp/write-receipts.js';
import { createSwarmTool } from './create-tool.js';

export const knowledge_receipt_status: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Read the bounded status of a knowledge_add receipt without exposing its payload',
		args: {
			idempotency_key: writeReceiptStatusInput.shape.idempotency_key,
		},
		execute: async (args: unknown, directory: string): Promise<string> =>
			JSON.stringify(
				await readWriteReceiptStatus(
					directory,
					writeReceiptStatusInput.parse(args).idempotency_key,
				),
			),
	});

export const _test_exports = {
	writeReceiptStatusInput,
};
