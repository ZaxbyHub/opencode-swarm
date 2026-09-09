/**
 * Verification adapters for the read-only MCP surface (#2499).
 *
 * Each adapter calls the SAME registered production implementation the
 * in-session tool uses — the persistence-free compute cores exported by the
 * tool modules (`computeSyntaxCheck`, `computePlaceholderScan`,
 * `computeSastScan`, `computeQualityBudget`) and the registered
 * `evidence_check` tool (a pure filesystem read). No parallel
 * reimplementation of any verification logic lives here.
 */

import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { evidence_check } from '../../tools/evidence-check.js';
import { computePlaceholderScan } from '../../tools/placeholder-scan.js';
import { computeQualityBudget } from '../../tools/quality-budget.js';
import { computeSastScan } from '../../tools/sast-scan.js';
import { computeSyntaxCheck } from '../../tools/syntax-check.js';
import type { McpReadTool } from '../registry.js';

/** Synthetic tool context pinning the MCP server's single configured root. */
export function mcpToolContext(root: string): ToolContext {
	return { directory: root } as ToolContext;
}

export function safeParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}

const syntaxCheckSchema = z.object({
	changed_files: z
		.array(
			z.object({
				path: z.string().describe('Repository-relative file path'),
				additions: z.number().describe('Added line count from the diff'),
			}),
		)
		.describe('Files to check (from diff gate)'),
	mode: z
		.enum(['changed', 'all'])
		.optional()
		.describe(
			"Check mode: 'changed' checks only additions > 0 entries; 'all' checks every entry",
		),
	languages: z
		.array(z.string())
		.optional()
		.describe('Restrict to specific languages'),
});

const placeholderScanSchema = z.object({
	changed_files: z
		.array(z.string())
		.describe('Repository-relative file paths to scan'),
});

const sastScanSchema = z.object({
	changed_files: z
		.array(z.string())
		.describe('Repository-relative file paths to scan'),
	severity_threshold: z
		.enum(['low', 'medium', 'high', 'critical'])
		.optional()
		.describe('Minimum severity to report (default: medium)'),
});

const qualityBudgetSchema = z.object({
	changed_files: z
		.array(z.string())
		.describe('Repository-relative file paths to analyze'),
});

const evidenceCheckSchema = z.object({
	required_types: z
		.string()
		.optional()
		.describe(
			'Comma-separated evidence types required per task (default: "reviewer,test_engineer")',
		),
});

export const syntaxCheckAdapter: McpReadTool = {
	name: 'syntax_check',
	description:
		'Check syntax of source files using tree-sitter parsers. Supports JS/TS, Python, Go, Rust, Java, C/C++, C#, PHP, Ruby. Returns JSON with syntax errors found per file.',
	kind: 'read',
	pathFields: ['changed_files'],
	inputSchema: syntaxCheckSchema,
	execute: (rawArgs, root) =>
		computeSyntaxCheck(syntaxCheckSchema.parse(rawArgs), root),
};

export const placeholderScanAdapter: McpReadTool = {
	name: 'placeholder_scan',
	description:
		'Scan changed files for placeholder content: TODO/FIXME comments, stub implementations, and placeholder markers that indicate unfinished work.',
	kind: 'read',
	pathFields: ['changed_files'],
	inputSchema: placeholderScanSchema,
	execute: (rawArgs, root) =>
		computePlaceholderScan(
			{ changed_files: placeholderScanSchema.parse(rawArgs).changed_files },
			root,
		),
};

export const sastScanAdapter: McpReadTool = {
	name: 'sast_scan',
	description: 'static analysis security scan',
	kind: 'read',
	pathFields: ['changed_files'],
	inputSchema: sastScanSchema,
	execute: (rawArgs, root) => {
		const args = sastScanSchema.parse(rawArgs);
		// Structural offline guard (#2499 R3): the MCP surface never spawns the
		// Semgrep subprocess — only the built-in pattern rules run.
		return computeSastScan(
			{
				changed_files: args.changed_files,
				severity_threshold: args.severity_threshold,
				offline_only: true,
			},
			root,
		);
	},
};

export const qualityBudgetAdapter: McpReadTool = {
	name: 'quality_budget',
	description:
		'check quality budgets (complexity, API surface, duplication, test ratio) for changed files',
	kind: 'read',
	pathFields: ['changed_files'],
	inputSchema: qualityBudgetSchema,
	execute: (rawArgs, root) =>
		computeQualityBudget(
			{ changed_files: qualityBudgetSchema.parse(rawArgs).changed_files },
			root,
		),
};

export const evidenceCheckAdapter: McpReadTool = {
	name: 'evidence_check',
	description:
		'Verify completed tasks in the plan have required evidence. Reads .swarm/plan.md for completed tasks and .swarm/evidence/ for evidence files. Returns JSON with completeness ratio and gaps for tasks missing required evidence types.',
	kind: 'read',
	pathFields: [],
	inputSchema: evidenceCheckSchema,
	execute: async (rawArgs, root) => {
		const args = evidenceCheckSchema.parse(rawArgs);
		// Registered production path: the evidence_check tool is a pure
		// filesystem read (no host state, no persistence).
		const result = await evidence_check.execute(args, mcpToolContext(root));
		return typeof result === 'string' ? safeParseJson(result) : result;
	},
};
