/**
 * Tool Doctor Service
 *
 * Validates that every tool name in TOOL_NAMES has a corresponding
 * registration in the plugin's tool: {} block in src/index.ts.
 *
 * Also validates:
 * - AGENT_TOOL_MAP alignment: tools assigned to agents are registered in the plugin
 * - Class 3 tool binary readiness: external binaries needed by lint tools are available
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCommandAvailable } from '../build/discovery';
import { AGENT_TOOL_MAP } from '../config/constants';
import { TOOL_NAMES } from '../tools/tool-names';
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
 * Extract tool keys from the plugin's tool: {} block in src/index.ts
 * Parses the file to find the tool block and returns its registered keys.
 */
function extractRegisteredToolKeys(indexPath: string): Set<string> {
	const registeredKeys = new Set<string>();

	try {
		const content = fs.readFileSync(indexPath, 'utf-8');

		// Find the tool: { ... } block
		// We need to parse the object literal to extract all keys
		const toolBlockMatch = content.match(
			/tool:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s,
		);
		if (!toolBlockMatch) {
			return registeredKeys;
		}

		const toolBlock = toolBlockMatch[1];

		// Parse keys from the tool block
		// Match patterns like: keyName, or keyName:, with optional value
		// Handles both: key, and key: value patterns
		const keyPattern = /^\s*(\w+)(?:\s*:|,)/gm;
		for (const match of toolBlock.matchAll(keyPattern)) {
			registeredKeys.add(match[1]);
		}
	} catch (_error) {
		// If we can't read/parse the file, return empty set
	}

	return registeredKeys;
}

/**
 * Check AGENT_TOOL_MAP alignment with registered tools
 *
 * Verifies that every tool listed in AGENT_TOOL_MAP is actually
 * registered in the plugin's tool: {} block. A missing registration
 * means the agent's system prompt will instruct the model to call a
 * tool that opencode never exposes to the runtime, which silently
 * breaks the agent's workflow (this is how the council feature shipped
 * broken in 6.66.0 — submit_council_verdicts and declare_council_criteria were
 * in AGENT_TOOL_MAP.architect but never registered). Findings are
 * emitted at severity 'error' so `config doctor` / `/swarm preflight`
 * treats this class of drift as fatal rather than advisory.
 */
function checkAgentToolMapAlignment(
	registeredKeys: Set<string>,
): ConfigFinding[] {
	const findings: ConfigFinding[] = [];

	for (const [agentName, tools] of Object.entries(AGENT_TOOL_MAP)) {
		for (const toolName of tools) {
			if (!registeredKeys.has(toolName)) {
				findings.push({
					id: `agent-tool-map-mismatch-${agentName}-${toolName}`,
					title: 'AGENT_TOOL_MAP alignment gap',
					description: `Tool "${toolName}" is assigned to agent "${agentName}" in AGENT_TOOL_MAP but is not registered in the plugin's tool: {} block. The agent will not be able to use this tool.`,
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
	pluginRoot?: string,
): ToolDoctorResult {
	const findings: ConfigFinding[] = [];

	// Resolve the plugin's own src/index.ts.
	// import.meta.dir is the plugin's services/ directory at runtime (src/services/ in dev,
	// dist/services/ in prod). Two levels up reaches the plugin root.
	const resolvedPluginRoot =
		pluginRoot ?? path.resolve(import.meta.dir, '..', '..');
	const indexPath = path.join(resolvedPluginRoot, 'src', 'index.ts');

	// If plugin source is not available (production npm install), return a single
	// informational finding rather than falsely reporting every tool as missing.
	if (!fs.existsSync(indexPath)) {
		return {
			findings: [
				{
					id: 'plugin-src-unavailable',
					title: 'Plugin source not available',
					description: `Tool registration check requires plugin source files. Expected: ${indexPath}. This check is available in development environments; in production npm installs, only compiled dist/ is present.`,
					severity: 'warn',
					path: indexPath,
					currentValue: undefined,
					autoFixable: false,
				},
			],
			summary: { info: 0, warn: 1, error: 0 },
			hasAutoFixableIssues: false,
			timestamp: Date.now(),
			configSource: indexPath,
		};
	}

	// Get registered tool keys from the plugin
	const registeredKeys = extractRegisteredToolKeys(indexPath);

	// Check each tool name for registration
	for (const toolName of TOOL_NAMES) {
		if (!registeredKeys.has(toolName)) {
			findings.push({
				id: `missing-tool-registration-${toolName}`,
				title: 'Missing tool registration',
				description: `Tool "${toolName}" is defined in TOOL_NAMES but is not registered in the plugin's tool: {} block. This means the tool will not be available at runtime.`,
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
		configSource: indexPath,
	};
}
