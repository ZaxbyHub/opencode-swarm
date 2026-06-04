/**
 * Tool Doctor Service
 *
 * Validates that every tool assigned in AGENT_TOOL_MAP is a registered tool name.
 *
 * As of #507, registration is DERIVED from the single registration-data source
 * (tool-metadata) and the handler set is compile-time-guaranteed to match it
 * (`manifest.ts satisfies Record<ToolName, () => ToolDefinition>`), so the set of
 * registered tools is exactly TOOL_NAME_SET. This service therefore validates
 * against TOOL_NAME_SET (handler-free) rather than importing the handler-bearing
 * manifest — that keeps tool-doctor (and the `../services` barrel that re-exports
 * it) out of the tool-module import graph, avoiding init cycles (#507 CI finding).
 * The handler-level coherence is enforced by the compile-time `satisfies` plus the
 * standalone CI script `scripts/check-tool-registration.ts`.
 *
 * Also validates:
 * - AGENT_TOOL_MAP alignment: tools assigned to agents are registered tool names
 * - Class 3 tool binary readiness: external binaries needed by lint tools are available
 */
import type { ConfigDoctorResult, ConfigFinding } from './config-doctor';
/** Result of tool registration coherence check */
export type ToolDoctorResult = ConfigDoctorResult;
/**
 * Check AGENT_TOOL_MAP alignment with registered tools
 *
 * Verifies that every tool listed in AGENT_TOOL_MAP is a registered tool name
 * (a member of the manifest-derived registered set passed in). A missing
 * registration means the agent's system prompt would instruct the model to call
 * a tool that opencode never exposes to the runtime, which silently breaks the
 * agent's workflow (this is how the council feature shipped broken in 6.66.0 —
 * submit_council_verdicts and declare_council_criteria were in
 * AGENT_TOOL_MAP.architect but never registered). Findings are emitted at
 * severity 'error' so `config doctor` / `/swarm preflight` treats this class of
 * drift as fatal rather than advisory.
 */
export declare function checkAgentToolMapAlignment(registeredKeys: Set<string>): ConfigFinding[];
/**
 * Run tool registration coherence check
 *
 * Verifies that every entry in TOOL_NAMES has a corresponding key
 * in the plugin's tool: {} block in src/index.ts.
 */
/**
 * Returns a structured advisory string for any missing Class 3 binaries.
 * Intended for injection into the architect's first system prompt.
 * Returns null if all binaries are available.
 */
export declare function getBinaryReadinessAdvisory(): string | null;
export declare function runToolDoctor(_directory: string, _pluginRoot?: string): ToolDoctorResult;
