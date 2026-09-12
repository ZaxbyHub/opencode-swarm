/** Read-only MCP adapter for the inline shell-write scope advisory (#2500). */

import {
	evaluateScopeValidate,
	scopeValidateSchema,
} from '../../tools/scope-validate.js';
import type { McpReadTool } from '../registry.js';

export const scopeValidationAdapter: McpReadTool = {
	name: 'scope_validate',
	kind: 'read',
	pathFields: ['scope_files'],
	inputSchema: scopeValidateSchema,
	execute: async (rawArgs, root) =>
		evaluateScopeValidate(scopeValidateSchema.parse(rawArgs), root),
};
