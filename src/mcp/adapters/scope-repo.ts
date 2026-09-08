/**
 * Scope/repo adapters for the read-only MCP surface (#2499).
 *
 * `plan_conflict_check` validates declared-scope disjointness (the
 * scope-validation capability) via `executePlanConflictCheck` — the same
 * exported core the registered tool calls; it reads `.swarm/plan.json` and
 * `.swarm/scopes/` fail-open and writes nothing. `diff` and `symbols` go
 * through the registered production tools (pure reads; `diff` guards
 * non-git roots).
 */

import { z } from 'zod';
import {
	executePlanConflictCheck,
	plan_conflict_check_args,
} from '../../tools/plan-conflict-check.js';
import { diff as diffTool } from '../../tools/diff.js';
import { symbols as symbolsTool } from '../../tools/symbols.js';
import type { McpReadTool } from '../registry.js';
import { mcpToolContext, safeParseJson } from './verification.js';

const planConflictCheckSchema = z.object({
	task_ids: plan_conflict_check_args.task_ids,
	use_cochange: plan_conflict_check_args.use_cochange,
	phase_id: plan_conflict_check_args.phase_id,
});

const diffSchema = z.object({
	base: z
		.string()
		.optional()
		.describe('Base ref to diff against (default: HEAD)'),
	paths: z
		.array(z.string())
		.optional()
		.describe('Optional file paths to restrict diff scope'),
	summaryOnly: z
		.boolean()
		.optional()
		.describe('Return only the file list summary'),
});

const symbolsSchema = z.object({
	file: z.string().optional().describe('Specific file to extract symbols from'),
	workspace: z
		.string()
		.optional()
		.describe('Workspace-relative directory to search'),
	name: z.string().optional().describe('Symbol name pattern to search'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe('Max results'),
});

export const planConflictCheckAdapter: McpReadTool = {
	name: 'plan_conflict_check',
	description:
		'read-only advisory check (#1656): compute a pairwise file-conflict matrix for N proposed parallel task groups using declared scopes and optional git co-change; returns a verdict (all_disjoint / conflicts_present / unknown_scopes), per-pair evidence, and a suggested serialization order. Writes nothing — the execution gate independently recomputes the verdict inline at dispatch time via the same helper. Call BEFORE attempting parallel dispatch to confirm disjointness.',
	kind: 'read',
	pathFields: [],
	inputSchema: planConflictCheckSchema,
	execute: (rawArgs, root) =>
		executePlanConflictCheck(planConflictCheckSchema.parse(rawArgs), root),
};

export const diffAdapter: McpReadTool = {
	name: 'diff',
	description:
		'Analyze git diff for changed files, exports, interfaces, and function signatures. Returns structured output with contract change detection.',
	kind: 'read',
	pathFields: ['paths'],
	inputSchema: diffSchema,
	execute: async (rawArgs, root) => {
		const args = diffSchema.parse(rawArgs);
		try {
			const result = await diffTool.execute(args, mcpToolContext(root));
			return typeof result === 'string' ? safeParseJson(result) : result;
		} catch (error) {
			// Non-git working trees make `git diff` throw; degrade read-only
			// instead of surfacing a stack error (#2499 R6).
			const message =
				error instanceof Error ? error.message : 'git diff unavailable';
			if (/not a git|enoent|fatal|repository/i.test(message)) {
				return {
					available: false,
					reason: 'not_a_git_worktree',
					files: [],
					message: 'The configured root is not a git working tree.',
				};
			}
			throw error;
		}
	},
};

export const symbolsAdapter: McpReadTool = {
	name: 'symbols',
	description:
		'Extract and search code symbols (functions, classes, methods, interfaces) across the repository using tree-sitter. Use for understanding code structure and finding definitions.',
	kind: 'read',
	pathFields: ['file', 'workspace'],
	inputSchema: symbolsSchema,
	execute: async (rawArgs, root) => {
		const args = symbolsSchema.parse(rawArgs);
		const result = await symbolsTool.execute(args, mcpToolContext(root));
		return typeof result === 'string' ? safeParseJson(result) : result;
	},
};
