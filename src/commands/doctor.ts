import { loadPluginConfig } from '../config/loader';
import {
	type ConfigDoctorResult,
	type ModelAvailability,
	runConfigDoctor,
} from '../services/config-doctor';
import { runToolDoctor } from '../services/tool-doctor';
import { withTimeout } from '../utils/timeout';

type ProviderModelClient = {
	config?: {
		providers?: (parameters?: { directory?: string }) => Promise<{
			data?: {
				providers?: Array<{
					id?: string;
					models?: Record<string, { id?: string }>;
				}>;
			};
			error?: unknown;
		}>;
	};
};

const MODEL_REGISTRY_TIMEOUT_MS = 3_000;
const MODEL_REGISTRY_SOURCE = 'OpenCode config.providers';

/**
 * Format tool doctor result as markdown for command output.
 *
 * Exported for unit testing of the BLOCKING footer enforcement path.
 */
export function formatToolDoctorMarkdown(result: ConfigDoctorResult): string {
	const lines = [
		'## Tool Doctor Report',
		'',
		`**Tool Registry**: ${result.configSource}`,
		'',
		'### Summary',
		`- **Info**: ${result.summary.info}`,
		`- **Warnings**: ${result.summary.warn}`,
		`- **Errors**: ${result.summary.error}`,
		'',
	];

	if (result.findings.length === 0) {
		lines.push('No issues found. All tools are properly registered!');
	} else {
		lines.push('### Findings', '');

		// Group findings by severity
		const errors = result.findings.filter((f) => f.severity === 'error');
		const warnings = result.findings.filter((f) => f.severity === 'warn');
		const infos = result.findings.filter((f) => f.severity === 'info');

		for (const finding of [...errors, ...warnings, ...infos]) {
			const icon =
				finding.severity === 'error'
					? '❌'
					: finding.severity === 'warn'
						? '⚠️'
						: 'ℹ️';
			lines.push(
				`${icon} **${finding.severity.toUpperCase()}**: ${finding.description}`,
			);
			if (finding.autoFixable) {
				lines.push(`   - 🔧 Auto-fixable`);
			}
			lines.push('');
		}

		// Surface error-severity findings as a block-release signal. The
		// AGENT_TOOL_MAP alignment check (the exact bug class that shipped
		// broken in 6.66.0) now emits at 'error'; this footer makes the
		// release-blocking intent machine-readable so CI and release tooling
		// can gate on the presence of `BLOCKING:` without parsing severity
		// counts individually.
		if (result.summary.error > 0) {
			lines.push('---', '');
			lines.push(
				`**BLOCKING**: ${result.summary.error} error-severity finding(s) must be resolved before release. ` +
					`AGENT_TOOL_MAP alignment errors mean an agent's system prompt instructs the model to call a tool that opencode has not registered — the agent's workflow will silently fail at runtime.`,
			);
			lines.push('');
		}
	}

	return lines.join('\n');
}

/**
 * Format config doctor result as markdown for command output.
 */
function formatDoctorMarkdown(result: ConfigDoctorResult): string {
	const lines = [
		'## Config Doctor Report',
		'',
		`**Config Source**: ${result.configSource}`,
		'',
		'### Summary',
		`- **Info**: ${result.summary.info}`,
		`- **Warnings**: ${result.summary.warn}`,
		`- **Errors**: ${result.summary.error}`,
		'',
	];

	if (result.findings.length === 0) {
		lines.push('No issues found. Your configuration looks good!');
	} else {
		lines.push('### Findings', '');

		// Group findings by severity
		const errors = result.findings.filter((f) => f.severity === 'error');
		const warnings = result.findings.filter((f) => f.severity === 'warn');
		const infos = result.findings.filter((f) => f.severity === 'info');

		for (const finding of [...errors, ...warnings, ...infos]) {
			const icon =
				finding.severity === 'error'
					? '❌'
					: finding.severity === 'warn'
						? '⚠️'
						: 'ℹ️';
			lines.push(
				`${icon} **${finding.severity.toUpperCase()}**: ${finding.description}`,
			);
			if (finding.autoFixable) {
				lines.push(`   - 🔧 Auto-fixable`);
			}
			lines.push('');
		}
	}

	if (result.hasAutoFixableIssues) {
		lines.push('---');
		lines.push('');
		lines.push(
			'Tip: Some issues can be auto-fixed. Run `/swarm config doctor --fix` to apply fixes.',
		);
	}

	return lines.join('\n');
}

function extractAvailableModelIds(
	response: Awaited<
		ReturnType<
			NonNullable<NonNullable<ProviderModelClient['config']>['providers']>
		>
	>['data'],
): Set<string> {
	const available = new Set<string>();
	if (response?.providers !== undefined && !Array.isArray(response.providers)) {
		throw new Error('provider registry returned malformed provider list');
	}
	for (const provider of response?.providers ?? []) {
		if (
			!provider ||
			typeof provider !== 'object' ||
			!provider.id ||
			!provider.models ||
			typeof provider.models !== 'object' ||
			Array.isArray(provider.models)
		) {
			continue;
		}
		for (const [modelKey, modelInfo] of Object.entries(provider.models)) {
			available.add(`${provider.id}/${modelKey}`);
			if (modelInfo && typeof modelInfo === 'object' && modelInfo.id) {
				available.add(`${provider.id}/${modelInfo.id}`);
			}
		}
	}
	return available;
}

export async function loadModelAvailability(
	directory: string,
	client: unknown,
	options: { timeoutMs?: number } = {},
): Promise<ModelAvailability | undefined> {
	const providerClient = client as ProviderModelClient | undefined;
	const providers = providerClient?.config?.providers;
	if (typeof providers !== 'function') {
		return undefined;
	}

	try {
		const response = await withTimeout(
			providers({ directory }),
			options.timeoutMs ?? MODEL_REGISTRY_TIMEOUT_MS,
			new Error(
				`OpenCode provider model registry lookup exceeded ${
					options.timeoutMs ?? MODEL_REGISTRY_TIMEOUT_MS
				}ms`,
			),
		);
		if (response.error) {
			return {
				availableModelIds: new Set<string>(),
				source: MODEL_REGISTRY_SOURCE,
				error:
					typeof response.error === 'string'
						? response.error
						: JSON.stringify(response.error),
			};
		}
		if (!response.data) {
			return {
				availableModelIds: new Set<string>(),
				source: MODEL_REGISTRY_SOURCE,
				error: 'provider registry returned no data',
			};
		}
		return {
			availableModelIds: extractAvailableModelIds(response.data),
			source: MODEL_REGISTRY_SOURCE,
		};
	} catch (error) {
		return {
			availableModelIds: new Set<string>(),
			source: MODEL_REGISTRY_SOURCE,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Handle /swarm config doctor command.
 * Maps to: config doctor service (runConfigDoctor)
 */
export async function handleDoctorCommand(
	directory: string,
	args: string[],
	options: { client?: unknown } = {},
): Promise<string> {
	const enableAutoFix = args.includes('--fix') || args.includes('-f');

	const config = loadPluginConfig(directory);
	const modelAvailability = await loadModelAvailability(
		directory,
		options.client,
	);
	const doctorOptions = { modelAvailability };
	const result = runConfigDoctor(config, directory, doctorOptions);

	// If auto-fix is requested and there are auto-fixable issues
	if (enableAutoFix && result.hasAutoFixableIssues) {
		// Lazy load to avoid circular dependency
		const { runConfigDoctorWithFixes } = await import(
			'../services/config-doctor'
		);
		const fixResult = await runConfigDoctorWithFixes(
			directory,
			config,
			true,
			doctorOptions,
		);
		return formatDoctorMarkdown(fixResult.result);
	}

	return formatDoctorMarkdown(result);
}

/**
 * Handle /swarm doctor tools command.
 * Maps to: tool doctor service (runToolDoctor)
 */
export async function handleDoctorToolsCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const result = runToolDoctor(directory);
	return formatToolDoctorMarkdown(result);
}
