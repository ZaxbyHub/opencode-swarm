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
import { TOOL_MANIFEST } from './manifest';
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
): Record<string, ToolDefinition> {
	const tools: Record<string, ToolDefinition> = {};
	const knowledgeEnabled = config?.knowledge?.enabled !== false;
	const knowledgeTools = new Set([
		'knowledge_add',
		'knowledge_recall',
		'knowledge_remove',
		'knowledge_query',
		'knowledge_ack',
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
	tools.swarm_command = createSwarmCommandTool(agents);
	return tools;
}
