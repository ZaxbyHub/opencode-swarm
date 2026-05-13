import { loadPluginConfig } from '../config/loader';
import {
	type ConfigDoctorResult,
	runConfigDoctor,
} from '../services/config-doctor';
import { runToolDoctor } from '../services/tool-doctor';

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

/**
 * Handle /swarm config doctor command.
 * Maps to: config doctor service (runConfigDoctor)
 */
export async function handleDoctorCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const enableAutoFix = args.includes('--fix') || args.includes('-f');

	const config = loadPluginConfig(directory);
	const result = runConfigDoctor(config, directory);

	// If auto-fix is requested and there are auto-fixable issues
	if (enableAutoFix && result.hasAutoFixableIssues) {
		// Lazy load to avoid circular dependency
		const { runConfigDoctorWithFixes } = await import(
			'../services/config-doctor'
		);
		const fixResult = await runConfigDoctorWithFixes(directory, config, true);
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
