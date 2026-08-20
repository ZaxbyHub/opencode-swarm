// Bundled at build time from the plugin's own package.json — keeps the
// exported `version` field in lockstep with releases instead of a stale
// hardcoded literal (issue #1662: it had drifted to '4.5.0' three major
// versions behind).
import packageJson from '../../package.json' with { type: 'json' };
import type { ExecutionProfile } from '../config/plan-schema';
import { readSwarmFileAsync } from '../hooks/utils';
import { loadPlanJsonOnly } from '../plan/manager';

/**
 * Structured export data.
 */
export interface ExportData {
	version: string;
	exported: string;
	plan: unknown; // structured Plan object if available, else markdown string
	context: string | null;
	/** The plan's execution_profile, if set. Consumers must honour locked profiles. */
	execution_profile?: ExecutionProfile | null;
}

/**
 * Get export data from the swarm directory.
 * Returns structured data for GUI, background flows, or commands.
 */
export async function getExportData(directory: string): Promise<ExportData> {
	const planStructured = await loadPlanJsonOnly(directory);
	const planContent = await readSwarmFileAsync(directory, 'plan.md');
	const contextContent = await readSwarmFileAsync(directory, 'context.md');

	return {
		version: packageJson.version,
		exported: new Date().toISOString(),
		plan: planStructured || planContent, // structured Plan object if available, else markdown
		context: contextContent,
		execution_profile: planStructured?.execution_profile ?? null,
	};
}

/**
 * Format export data as markdown with JSON code block for command output.
 */
export function formatExportMarkdown(exportData: ExportData): string {
	const lines = [
		'## Swarm Export',
		'',
		'```json',
		JSON.stringify(exportData, null, 2),
		'```',
	];

	return lines.join('\n');
}

/**
 * Handle export command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export async function handleExportCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const exportData = await getExportData(directory);
	return formatExportMarkdown(exportData);
}
