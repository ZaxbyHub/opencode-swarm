/**
 * Tool Output Summarizer Hook
 *
 * Intercepts oversized tool outputs in tool.execute.after,
 * stores the full content to .swarm/summaries/, and replaces
 * the output with a compact summary containing a retrieval ID.
 */

import type { SummaryConfig } from '../config/schema';
import { storeSummary } from '../summaries/manager';
import { createSummary, shouldSummarize } from '../summaries/summarizer';
import { warn } from '../utils';

/** Session-scoped counter for summary IDs. Resets on plugin reload. */
let nextSummaryId = 1;

/**
 * Reset the summary ID counter. Used for testing.
 */
export function resetSummaryIdCounter(): void {
	nextSummaryId = 1;
}

/**
 * Creates a tool.execute.after hook that summarizes oversized tool outputs.
 *
 * @param config - Summary configuration including enabled, thresholds, and limits
 * @param directory - Base directory for storing full outputs
 * @returns Async hook function for tool.execute.after
 */
export function createToolSummarizerHook(
	config: SummaryConfig,
	directory: string,
): (
	input: { tool: string; sessionID: string; callID: string },
	output: { title: string; output: string; metadata: unknown },
) => Promise<void> {
	// If summaries disabled, return no-op
	if (config.enabled === false) {
		return async () => {};
	}

	return async (input, output) => {
		// Skip non-string or empty outputs
		if (typeof output.output !== 'string' || output.output.length === 0) {
			return;
		}

		// Skip exempt tools (e.g. retrieve_summary, task) — summarizing their output
		// creates a retrieval loop where the summary itself gets summarized.
		const exemptTools = config.exempt_tools ?? [
			'retrieve_summary',
			'retrieve_lane_output',
			'task',
			'read',
		];
		if (exemptTools.includes(input.tool)) {
			return;
		}

		// Check if output exceeds threshold (with hysteresis)
		if (!shouldSummarize(output.output, config.threshold_bytes)) {
			return;
		}

		// Generate summary ID
		const summaryId = `S${nextSummaryId++}`;

		// Create summary text
		const summaryText = createSummary(
			output.output,
			input.tool,
			summaryId,
			config.max_summary_chars,
		);

		// Try to store and replace — fail-open on any error
		try {
			await storeSummary(
				directory,
				summaryId,
				output.output,
				summaryText,
				config.max_stored_bytes,
			);
			// Only replace output after successful storage
			output.output = summaryText;
		} catch (error) {
			// Graceful degradation: log warning and keep original output
			warn(
				`Tool output summarization failed for ${summaryId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			// Do NOT modify output.output — original is preserved
		}
	};
}
