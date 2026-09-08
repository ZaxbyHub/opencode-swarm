/**
 * Tool registry for the read-only MCP verification surface (#2499).
 *
 * `buildMcpToolRegistry` composes the read-only tool set for ONE configured
 * project root. Descriptions are sourced from `TOOL_METADATA` — the same
 * registry the plugin host uses — so MCP tool names are a subset of
 * registered tool names with exact description parity (frozen by
 * repro/check-mcp-registry-capability-coverage.sh, C2).
 *
 * The write boundary is fail-closed (frozen by
 * repro/check-mcp-readonly-default-no-writes.sh, C6): every tool name is
 * validated against a write-capable denylist and a match THROWS — with or
 * without `allowWrite`. Phase 1 ships zero write tools; `allowWrite` is the
 * documented forward-compat seam for the #2500 write surface and adds
 * nothing today.
 */

import type { z } from 'zod';

import { TOOL_METADATA } from '../tools/tool-metadata.js';
import { knowledgeRecallAdapter, swarmMemoryRecallAdapter } from './adapters/knowledge-memory.js';
import { diffAdapter, planConflictCheckAdapter, symbolsAdapter } from './adapters/scope-repo.js';
import {
	evidenceCheckAdapter,
	placeholderScanAdapter,
	qualityBudgetAdapter,
	sastScanAdapter,
	syntaxCheckAdapter,
} from './adapters/verification.js';

/** Write-capable tool-name shapes. Mirrors the frozen C6 denylist. */
export const WRITE_TOOL_NAME_PATTERN =
	/write_|record_|submit_|repair_|prepare_|rebind_|invalidate_|authorize_|external_skill_(promote|reject|delete|revoke)|swarm_apply_patch|save_plan|update_task_status|declare_scope|set_qa_gates|knowledge_add|knowledge_remove|knowledge_archive|checkpoint|phase_complete|complete_pr_workflow|abort_pr_workflow|approve_plan_critic|swarm_memory_propose|swarm_memory_outcome|spec_write|lint_spec|skill_generate|skill_regenerate|skill_retire|skill_improve|skill_apply|run_stale_reconciliation|epic_record_divergence|lean_turbo_acquire_locks|lean_turbo_plan_lanes|lean_turbo_critic|lean_turbo_review|lean_turbo_run_phase|convene_general_council|swarm_command/;

export interface McpReadTool {
	/** Registered plugin tool name (a TOOL_METADATA key). */
	name: string;
	/** Exact TOOL_METADATA description (parity assigned at build time). */
	description: string;
	kind: 'read';
	/** Argument field names carrying file-path values (containment-checked). */
	pathFields: string[];
	/** MCP input schema (mirrors the registered tool's zod args). */
	inputSchema: z.ZodObject<z.ZodRawShape>;
	execute(args: Record<string, unknown>, root: string): Promise<unknown>;
}

export interface McpToolRegistry {
	tools: McpReadTool[];
}

export interface BuildMcpToolRegistryOptions {
	/** The single configured project root (one server = one root). */
	root: string;
	/** Alias for `root` (accepted for harness compatibility). */
	directory?: string;
	/**
	 * Forward-compat seam for the #2500 explicitly-authorized write surface.
	 * Phase 1 has no write tools, so this flag never adds anything; the
	 * write-name denylist stays fail-closed either way.
	 */
	allowWrite?: boolean;
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
];

export function buildMcpToolRegistry(
	options: BuildMcpToolRegistryOptions,
): McpToolRegistry {
	const root = options.root || options.directory || '';
	if (!root) {
		throw new Error('buildMcpToolRegistry: a project root is required');
	}
	const tools: McpToolRegistry['tools'] = [];
	for (const adapter of READ_ADAPTERS) {
		const metadata = TOOL_METADATA[adapter.name as keyof typeof TOOL_METADATA];
		if (!metadata) {
			throw new Error(
				`buildMcpToolRegistry: ${adapter.name} is not a registered tool (TOOL_METADATA parity violated)`,
			);
		}
		if (WRITE_TOOL_NAME_PATTERN.test(adapter.name)) {
			// Fail-closed write boundary: denylist matches throw even with
			// allowWrite (Phase 1 ships no write tools at all).
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
	return { tools };
}
