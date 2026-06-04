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

import { isCommandAvailable } from '../build/discovery';
import { AGENT_TOOL_MAP } from '../config/constants';
import { TOOL_NAME_SET, TOOL_NAMES } from '../tools/tool-names';
import type { ConfigDoctorResult, ConfigFinding } from './config-doctor';

/** Binaries checked for Class 3 tool readiness */
const BINARY_CHECKLIST = [
	{ binary: 'ruff', language: 'Python' },
	{ binary: 'cargo', language: 'Rust (via clippy)' },
	{ binary: 'golangci-lint', language: 'Go' },
	{ binary: 'mvn', language: 'Java (Maven)' },
	{ binary: 'gradle', language: 'Java (Gradle)' },
	{ binary: 'dotnet', language: '.NET' },
	{ binary: 'swift', language: 'Swift' },
	{ binary: 'swiftlint', language: 'Swift (linting)' },
	{ binary: 'dart', language: 'Dart' },
	{ binary: 'flutter', language: 'Flutter/Dart' },
	{ binary: 'biome', language: 'JS/TS (already in project)' },
	{ binary: 'eslint', language: 'JS/TS' },
] as const;

/** Result of tool registration coherence check */
export type ToolDoctorResult = ConfigDoctorResult;

/**
 * The set of registered tool names. Equals the plugin tool object's keys by
 * construction (the manifest's handler set is compile-time-equal to the metadata
 * keys, and TOOL_NAME_SET derives from those keys). Handler-free on purpose.
 */
function getRegisteredToolKeys(): Set<string> {
	return new Set<string>(TOOL_NAME_SET);
}

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
export function checkAgentToolMapAlignment(
	registeredKeys: Set<string>,
): ConfigFinding[] {
	const findings: ConfigFinding[] = [];

	for (const [agentName, tools] of Object.entries(AGENT_TOOL_MAP)) {
		for (const toolName of tools) {
			if (!registeredKeys.has(toolName)) {
				findings.push({
					id: `agent-tool-map-mismatch-${agentName}-${toolName}`,
					title: 'AGENT_TOOL_MAP alignment gap',
					description: `Tool "${toolName}" is assigned to agent "${agentName}" in AGENT_TOOL_MAP but is not a registered tool name. The agent will not be able to use this tool.`,
					severity: 'error',
					path: `AGENT_TOOL_MAP.${agentName}`,
					currentValue: toolName,
					autoFixable: false,
				});
			}
		}
	}

	return findings;
}

/**
 * Check Class 3 tool binary readiness
 *
 * Verifies that external binaries needed by certain lint tools are
 * available on PATH. Missing binaries are reported as informational
 * warnings - they don't block the tool doctor but indicate which
 * language-specific linting capabilities may be unavailable.
 */
function checkBinaryReadiness(): ConfigFinding[] {
	const findings: ConfigFinding[] = [];

	for (const { binary, language } of BINARY_CHECKLIST) {
		if (!isCommandAvailable(binary)) {
			findings.push({
				id: `missing-binary-${binary}`,
				title: 'Class 3 tool binary not found',
				description: `Binary "${binary}" is not available on PATH. ${language} linting will not be available. Install ${binary} to enable ${language} language support.`,
				severity: 'warn',
				path: `toolchain.${binary}`,
				currentValue: undefined,
				autoFixable: false,
			});
		}
	}

	return findings;
}

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
export function getBinaryReadinessAdvisory(): string | null {
	const findings = checkBinaryReadiness();
	if (findings.length === 0) return null;
	const lines = findings.map(
		(f) =>
			`- MISSING BINARY: ${f.currentValue ?? f.path?.split('.')[1] ?? 'unknown'} — ${f.description}`,
	);
	return [
		'[PRE-FLIGHT ADVISORY] The following Class 3 tool binaries were not found on PATH at session start.',
		'These tools will soft-skip at invocation. Plan tasks accordingly.',
		...lines,
	].join('\n');
}

export function runToolDoctor(
	_directory: string,
	_pluginRoot?: string,
): ToolDoctorResult {
	const findings: ConfigFinding[] = [];

	// Registered keys are derived from the single-source manifest (works in dev
	// AND production dist — it is a module import, not a source-file parse).
	const registeredKeys = getRegisteredToolKeys();

	// Check each tool name for registration
	for (const toolName of TOOL_NAMES) {
		if (!registeredKeys.has(toolName)) {
			findings.push({
				id: `missing-tool-registration-${toolName}`,
				title: 'Missing tool registration',
				description: `Tool "${toolName}" is defined in TOOL_NAMES but is not present in the plugin tool object derived from TOOL_MANIFEST. This means the tool will not be available at runtime.`,
				severity: 'error',
				path: `tool.${toolName}`,
				currentValue: undefined,
				autoFixable: false,
			});
		}
	}

	// Check AGENT_TOOL_MAP alignment
	findings.push(...checkAgentToolMapAlignment(registeredKeys));

	// Check Class 3 tool binary readiness
	findings.push(...checkBinaryReadiness());

	// Count by severity
	const summary = {
		info: findings.filter((f) => f.severity === 'info').length,
		warn: findings.filter((f) => f.severity === 'warn').length,
		error: findings.filter((f) => f.severity === 'error').length,
	};

	// Check if any auto-fixable issues exist
	const hasAutoFixableIssues = false; // Tool registration requires manual fix

	return {
		findings,
		summary,
		hasAutoFixableIssues,
		timestamp: Date.now(),
		configSource: 'src/tools/manifest.ts',
	};
}
