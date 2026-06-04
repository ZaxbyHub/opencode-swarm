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
/**
 * Construct the plugin tool object: one handler per manifest entry, with
 * `swarm_command` overridden by its dependency-injected instance.
 *
 * The manifest's `swarm_command` handler is the static (no-DI) form used only
 * for derivation; the real instance needs the agent definition map, which is
 * only available at plugin-init time.
 */
export declare function buildPluginToolObject(agents: Record<string, AgentDefinition>): Record<string, ToolDefinition>;
