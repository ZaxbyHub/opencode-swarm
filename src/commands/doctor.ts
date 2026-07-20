import { loadPluginConfigWithMeta } from '../config/loader';
import {
	type ConfigDoctorResult,
	detectStraySwarmDirs,
	readDoctorArtifact,
	removeStraySwarmDir,
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
 * Strip C0 control characters (including `\r`, `\n`, and ESC `\x1b`) and DEL,
 * collapsing each run to a single space. `removedKeys`/`warnings` are rendered
 * to a terminal in many call paths, not just as markdown — an unstripped ESC
 * lets an attacker-controlled config key smuggle ANSI escape sequences (e.g.
 * `\x1b[2J\x1b[31mFAKE\x1b[0m`) to clear the screen or spoof output, on top of
 * the markdown-structure risks newlines pose.
 */
function stripControlChars(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to strip them
	return s.replace(/[\x00-\x1f\x7f]+/g, ' ');
}

/**
 * Neutralize a string before it is interpolated INSIDE a backtick code span
 * (`` `${...}` ``) in rendered command output. `removedKeys` carries raw
 * config key names sourced from the project/user config file
 * (`stripUnrecognizedKeys` in `../config/loader`) — an attacker-controlled
 * `.opencode/opencode-swarm.json` could embed a backtick (breaking out of the
 * code span) on top of the control-character risks `stripControlChars`
 * handles. CommonMark renders every other character literally inside a code
 * span, and backslash escapes are NOT interpreted there — escaping e.g. `*`
 * would show a literal backslash to the user.
 */
function sanitizeForMarkdownCodeSpan(s: string): string {
	return stripControlChars(s).replace(/`/g, "'");
}

/**
 * Neutralize a string before it is interpolated as plain (non-code-span)
 * markdown text, as `warnings` is. Unlike `sanitizeForMarkdownCodeSpan`,
 * backslash-escaping IS interpreted outside a code span, so it is the
 * correct way to neutralize emphasis/link/table metacharacters here without
 * altering the visible text.
 */
function sanitizeForMarkdownText(s: string): string {
	return stripControlChars(s).replace(/([\\`*_[\]|])/g, '\\$1');
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
	// The --fix flag is accepted here because this handler serves human-initiated
	// chat commands, which have broader access than agent-initiated commands.
	// The tool-policy layer (src/commands/tool-policy.ts) blocks --fix for
	// agent-initiated commands.
	const enableAutoFix = args.includes('--fix') || args.includes('-f');

	const meta = loadPluginConfigWithMeta(directory);
	const config = meta.config;
	const result = runConfigDoctor(config, directory);

	// If auto-fix is requested and there are auto-fixable issues, apply fixes
	// before formatting — but do NOT return early; stray .swarm detection
	// must always run regardless of --fix (see Issue #922).
	let output: string;
	if (enableAutoFix && result.hasAutoFixableIssues) {
		// Lazy load to avoid circular dependency
		const { runConfigDoctorWithFixes } = await import(
			'../services/config-doctor'
		);
		// The interactive `--fix` command is an explicit, confirmed user action, so
		// it opts into lossy fixes (e.g. trimming an over-length fallback_models
		// array). The passive startup autofix path never does (issue #1886).
		const fixResult = await runConfigDoctorWithFixes(directory, config, true, {
			applyLossy: true,
		});
		output = formatDoctorMarkdown(fixResult.result);
	} else {
		const lastRun = readDoctorArtifact(directory);
		let markdown = formatDoctorMarkdown(result);
		if (lastRun) {
			markdown =
				`Last run: ${lastRun.timestamp}, ${lastRun.findingsCount} findings (${lastRun.autoFixableCount} auto-fixable)\n\n` +
				markdown;
		}
		output = markdown;
	}

	// Surface recovery metadata (FR-004) — when the loader had to drop keys or
	// fall back to defaults, the user must be able to discover that here.
	if (meta.recovery !== 'none') {
		const lines: string[] = ['\n---\n\n## Config Recovery (FR-004)\n\n'];
		lines.push(`- **Recovery applied**: \`${meta.recovery}\``);
		if (meta.removedKeys.length > 0) {
			lines.push(`- **Removed keys (${meta.removedKeys.length})**:`);
			for (const k of meta.removedKeys)
				lines.push(`  - \`${sanitizeForMarkdownCodeSpan(k)}\``);
		}
		if (meta.warnings.length > 0) {
			lines.push(`- **Recovery warnings (${meta.warnings.length})**:`);
			for (const w of meta.warnings)
				lines.push(`  - ${sanitizeForMarkdownText(w)}`);
		}
		output += `${lines.join('\n')}\n`;
	}

	// Check for stray .swarm directories
	const strayDirs = detectStraySwarmDirs(directory);
	if (strayDirs.length > 0) {
		if (enableAutoFix) {
			// Auto-clean stray directories
			let fixOutput = '\n---\n\n## Stray .swarm Directories\n\n';
			let removed = 0;
			let failed = 0;

			for (const finding of strayDirs) {
				const cleanupResult = removeStraySwarmDir(directory, finding.path);
				if (cleanupResult.success) {
					removed++;
				} else {
					failed++;
					fixOutput += `- \`${finding.path}\`: ${cleanupResult.message}\n`;
				}
			}

			fixOutput += `\nCleaned up ${removed} stray director${removed === 1 ? 'y' : 'ies'}.`;
			if (failed > 0) {
				fixOutput += ` ${failed} could not be removed.`;
			}
			output += fixOutput;
		} else {
			output += '\n---\n\n## Stray .swarm Directories\n\n';
			output += `Found ${strayDirs.length} stray .swarm director${strayDirs.length === 1 ? 'y' : 'ies'} in subdirectories:\n\n`;
			for (const finding of strayDirs) {
				const contentsPreview =
					finding.contents.length > 5
						? `${finding.contents.slice(0, 5).join(', ')}, ...`
						: finding.contents.join(', ');
				output += `- \`${finding.path}\` (${finding.totalEntries} entries: ${contentsPreview})\n`;
			}
			output += '\nThese are likely from a prior bug (Issue #922). ';
			output += 'Re-run with `--fix` to auto-clean.\n';
		}
	}

	return output;
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
