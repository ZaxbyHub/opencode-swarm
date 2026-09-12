/**
 * Tool registry for the MCP verification surface (#2499, #2500).
 *
 * `buildMcpToolRegistry` composes the read-only tool set for ONE configured
 * project root. Descriptions are sourced from `TOOL_METADATA` — the same
 * registry the plugin host uses — so MCP tool names are a subset of
 * registered tool names with exact description parity (frozen by
 * repro/check-mcp-registry-capability-coverage.sh, C2).
 *
 * The write boundary is fail-closed: a write is present only when the caller
 * supplies both the startup capability flag and an exact reviewed tool name.
 * The positive allowlist below is checked again here (rather than trusting the
 * CLI) so direct programmatic callers cannot widen the MCP surface.
 */

import type { z } from 'zod';

import { TOOL_METADATA } from '../tools/tool-metadata.js';
import { knowledgeAddAdapter } from './adapters/knowledge-add.js';
import {
	knowledgeRecallAdapter,
	swarmMemoryRecallAdapter,
} from './adapters/knowledge-memory.js';
import { receiptStatusAdapter } from './adapters/receipt-status.js';
import {
	diffAdapter,
	planConflictCheckAdapter,
	symbolsAdapter,
} from './adapters/scope-repo.js';
import { scopeValidationAdapter } from './adapters/scope-validation.js';
import {
	evidenceCheckAdapter,
	placeholderScanAdapter,
	qualityBudgetAdapter,
	sastScanAdapter,
	syntaxCheckAdapter,
} from './adapters/verification.js';
import type { KnowledgeAddAdapterRuntime } from './write-receipts.js';

/** Write-capable tool-name shapes. Mirrors the frozen C6 denylist. */
export const WRITE_TOOL_NAME_PATTERN =
	/write_|record_|submit_|repair_|prepare_|rebind_|invalidate_|authorize_|external_skill_(promote|reject|delete|revoke)|swarm_apply_patch|save_plan|update_task_status|declare_scope|set_qa_gates|knowledge_add|knowledge_remove|knowledge_archive|checkpoint|phase_complete|complete_pr_workflow|abort_pr_workflow|approve_plan_critic|swarm_memory_propose|swarm_memory_outcome|spec_write|lint_spec|skill_generate|skill_regenerate|skill_retire|skill_improve|skill_apply|run_stale_reconciliation|epic_record_divergence|lean_turbo_acquire_locks|lean_turbo_plan_lanes|lean_turbo_critic|lean_turbo_review|lean_turbo_run_phase|convene_general_council|swarm_command/;

export interface McpReadTool {
	/** Registered plugin tool name (a TOOL_METADATA key). */
	name: string;
	/** Exact TOOL_METADATA description (parity assigned at build time). */
	description?: string;
	kind: 'read';
	/** Argument field names carrying file-path values (containment-checked). */
	pathFields: string[];
	/** MCP input schema (mirrors the registered tool's zod args). */
	inputSchema: z.ZodObject<z.ZodRawShape>;
	execute(args: Record<string, unknown>, root: string): Promise<unknown>;
}

export interface McpWriteTool {
	/** Registered plugin tool name (a TOOL_METADATA key). */
	name: string;
	/** Exact TOOL_METADATA description (parity assigned at build time). */
	description?: string;
	kind: 'write';
	/** Argument field names carrying file-path values (containment-checked). */
	pathFields: string[];
	/** MCP input schema (mirrors the reviewed tool's zod args). */
	inputSchema: z.ZodObject<z.ZodRawShape>;
	execute(
		args: Record<string, unknown>,
		root: string,
		runtime?: KnowledgeAddAdapterRuntime,
	): Promise<unknown>;
}

export type McpTool = McpReadTool | McpWriteTool;

export interface McpToolRegistry {
	tools: McpTool[];
}

export interface BuildMcpToolRegistryOptions {
	/** The single configured project root (one server = one root). */
	root: string;
	/** Alias for `root` (accepted for harness compatibility). */
	directory?: string;
	/** Startup capability gate. This flag alone never registers a write. */
	allowWrite?: boolean;
	/** Exact reviewed write names authorized for this server instance. */
	writeTools?: string[];
}

/** The only MCP write adapter reviewed and shipped by #2500. */
export const REVIEWED_MCP_WRITE_TOOLS = ['knowledge_add'] as const;

const REVIEWED_MCP_WRITE_TOOL_SET = new Set<string>(REVIEWED_MCP_WRITE_TOOLS);

function validateWritePolicy(
	allowWrite: boolean | undefined,
	writeTools: string[] | undefined,
): string[] {
	if (writeTools === undefined) return [];
	if (!Array.isArray(writeTools)) {
		throw new Error('MCP write policy must be an array');
	}
	if (!allowWrite && writeTools.length > 0) {
		throw new Error(
			'MCP write tools require the explicit allowWrite startup capability',
		);
	}
	const seen = new Set<string>();
	for (const name of writeTools) {
		if (
			typeof name !== 'string' ||
			name.length === 0 ||
			!REVIEWED_MCP_WRITE_TOOL_SET.has(name)
		) {
			throw new Error(
				`unknown or unauthorized MCP write tool: ${String(name)}`,
			);
		}
		if (seen.has(name)) {
			throw new Error(`duplicate MCP write tool: ${name}`);
		}
		seen.add(name);
	}
	return writeTools;
}

const READ_ADAPTERS: McpReadTool[] = [
	knowledgeRecallAdapter,
	swarmMemoryRecallAdapter,
	evidenceCheckAdapter,
	syntaxCheckAdapter,
	placeholderScanAdapter,
	sastScanAdapter,
	qualityBudgetAdapter,
	planConflictCheckAdapter,
	diffAdapter,
	symbolsAdapter,
	scopeValidationAdapter,
	receiptStatusAdapter,
];

export function buildMcpToolRegistry(
	options: BuildMcpToolRegistryOptions,
): McpToolRegistry {
	const root = options.root || options.directory || '';
	if (!root) {
		throw new Error('buildMcpToolRegistry: a project root is required');
	}
	const requestedWrites = validateWritePolicy(
		options.allowWrite,
		options.writeTools,
	);
	const tools: McpToolRegistry['tools'] = [];
	for (const adapter of READ_ADAPTERS) {
		const metadata = TOOL_METADATA[adapter.name as keyof typeof TOOL_METADATA];
		if (!metadata) {
			throw new Error(
				`buildMcpToolRegistry: ${adapter.name} is not a registered tool (TOOL_METADATA parity violated)`,
			);
		}
		if (WRITE_TOOL_NAME_PATTERN.test(adapter.name)) {
			// Fail-closed read boundary: write-shaped names are forbidden in
			// this adapter set. The separately composed reviewed write adapter
			// is gated by the positive policy below.
			throw new Error(
				`buildMcpToolRegistry: refusing to register write-capable tool ${adapter.name} on the read-only MCP surface`,
			);
		}
		if (adapter.kind !== 'read') {
			throw new Error(
				`buildMcpToolRegistry: only read tools are registrable (got ${adapter.kind} for ${adapter.name})`,
			);
		}
		tools.push({
			name: adapter.name,
			// Exact-parity description sourced from the registered metadata.
			description: metadata.description,
			kind: 'read',
			pathFields: adapter.pathFields,
			inputSchema: adapter.inputSchema,
			execute: adapter.execute,
		});
	}
	if (requestedWrites.includes('knowledge_add')) {
		const metadata = TOOL_METADATA.knowledge_add;
		if (!metadata) {
			throw new Error(
				'buildMcpToolRegistry: knowledge_add is not a registered tool (TOOL_METADATA parity violated)',
			);
		}
		if (WRITE_TOOL_NAME_PATTERN.test(knowledgeAddAdapter.name) === false) {
			throw new Error(
				'buildMcpToolRegistry: reviewed knowledge_add adapter is not classified as write-capable',
			);
		}
		if (knowledgeAddAdapter.kind !== 'write') {
			throw new Error(
				'buildMcpToolRegistry: knowledge_add adapter must be write-capable',
			);
		}
		tools.push({
			name: knowledgeAddAdapter.name,
			description: metadata.description,
			kind: 'write',
			pathFields: knowledgeAddAdapter.pathFields,
			inputSchema: knowledgeAddAdapter.inputSchema,
			execute: knowledgeAddAdapter.execute,
		});
	}
	return { tools };
}
