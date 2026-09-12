/** Read-only MCP status probe for explicitly-authorized knowledge writes. */

import type { McpReadTool } from '../registry.js';
import {
	readWriteReceiptStatus,
	writeReceiptStatusInput,
} from '../write-receipts.js';

export const receiptStatusAdapter: McpReadTool = {
	name: 'knowledge_receipt_status',
	kind: 'read',
	pathFields: [],
	inputSchema: writeReceiptStatusInput,
	execute: async (rawArgs, root) => {
		const args = writeReceiptStatusInput.parse(rawArgs);
		return readWriteReceiptStatus(root, args.idempotency_key);
	},
};
