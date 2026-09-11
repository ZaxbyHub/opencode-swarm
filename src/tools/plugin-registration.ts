/**
 * Builds the plugin's `tool: {}` object from the single-source-of-truth
 * {@link TOOL_MANIFEST}. This is the ONLY place the OpenCode plugin tool object
 * is assembled, so registration drift between the manifest and the plugin is
 * structurally impossible.
 *
 * Extracted into its own module (rather than inlined in src/index.ts) so the
 * registration tests and `tool-doctor` can assert against the real object
 * instead of regex-parsing source text.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import type { AgentDefinition } from '../agents/index.js';
import type { PluginConfig } from '../config/index.js';
import type { EvaluationModelDispatcher } from '../evaluation/model-dispatcher.js';
import { withStartupFirstToolTracking } from '../observability/startup-contract.js';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import type { ReviewAgentModelRegistry } from '../review/runtime.js';
import { createLeanTurboCriticTool } from './lean-turbo-critic.js';
import { createLeanTurboReviewTool } from './lean-turbo-review.js';
import { createLeanTurboRunPhaseTool } from './lean-turbo-run-phase.js';
import { TOOL_MANIFEST } from './manifest';
import { createPhaseCompleteTool } from './phase-complete.js';
import { createRunPhaseReviewTool } from './run-phase-review.js';
import { createSwarmCommandTool } from './swarm-command';

/**
 * Construct the plugin tool object: one handler per manifest entry, with
 * `swarm_command` overridden by its dependency-injected instance.
 *
 * The manifest's `swarm_command` handler is the static (no-DI) form used only
 * for derivation; the real instance needs the agent definition map, which is
 * only available at plugin-init time.
 *
 * Knowledge tools are conditionally excluded when config.knowledge.enabled = false.
 */
export function buildPluginToolObject(
	agents: Record<string, AgentDefinition>,
	config?: PluginConfig,
	evaluationModelDispatcher?: EvaluationModelDispatcher,
	reviewModelDispatcher?: ReviewModelDispatcher,
	generatedAgentNames: Iterable<string> = Object.keys(agents),
	reviewAgentModelRegistry?: ReviewAgentModelRegistry,
	getActiveAgentName?: (sessionID: string) => string | undefined,
): Record<string, ToolDefinition> {
	const tools: Record<string, ToolDefinition> = {};
	const reviewAgentNames = Object.freeze([...generatedAgentNames]);
	const knowledgeEnabled = config?.knowledge?.enabled !== false;
	const knowledgeTools = new Set([
		'knowledge_add',
		'knowledge_recall',
		'knowledge_remove',
		'knowledge_query',
		'knowledge_receipt',
		'knowledge_archive',
	]);

	for (const [name, handler] of Object.entries(TOOL_MANIFEST)) {
		// Skip knowledge tools if knowledge is disabled
		if (!knowledgeEnabled && knowledgeTools.has(name)) {
			continue;
		}
		// Each manifest value is a lazy thunk — resolve it here, at call time.
		tools[name] = handler();
	}
	tools.swarm_command = createSwarmCommandTool(
		agents,
		evaluationModelDispatcher,
		reviewModelDispatcher,
		config?.auto_review,
		reviewAgentModelRegistry,
		getActiveAgentName,
	);
	tools.phase_complete = createPhaseCompleteTool({
		reviewModelDispatcher,
		generatedAgentNames: reviewAgentNames,
		reviewAgentModelRegistry,
		getActiveAgentName,
	});
	tools.run_phase_review = createRunPhaseReviewTool(
		reviewModelDispatcher,
		reviewAgentNames,
		reviewAgentModelRegistry,
		getActiveAgentName,
	);
	tools.lean_turbo_review = createLeanTurboReviewTool(
		reviewModelDispatcher,
		reviewAgentNames,
		reviewAgentModelRegistry,
		getActiveAgentName,
	);
	tools.lean_turbo_critic = createLeanTurboCriticTool(
		reviewModelDispatcher,
		reviewAgentNames,
		reviewAgentModelRegistry,
		getActiveAgentName,
	);
	tools.lean_turbo_run_phase = createLeanTurboRunPhaseTool(reviewAgentNames);
	// Startup latency contract (#2670): observe the FIRST tool execute per
	// process with the tool name in scope. The wrap BUILDS A COPY of each
	// definition ({ ...def, execute }) — the shared module-level tool
	// definitions (the src/tools barrel exports and the manifest thunks)
	// are never mutated, so repeated boots wrap pristine executes instead
	// of stacking wrappers, and definition-level conventions (e.g.
	// execute arity) stay intact on the originals. The fixed-arity
	// observation wrapper returns the wrapped execute's own result
	// untouched and records the first-tool interval when the invocation
	// settles — no behavior change on any path.
	const tracked: Record<string, ToolDefinition> = {};
	for (const [name, def] of Object.entries(tools)) {
		const execute = (def as { execute?: unknown }).execute;
		if (typeof execute === 'function') {
			tracked[name] = {
				...def,
				execute: withStartupFirstToolTracking(
					name,
					execute as (args: unknown, ctx: unknown) => unknown,
				),
			} as ToolDefinition;
		} else {
			tracked[name] = def;
		}
	}
	return tracked;
}
