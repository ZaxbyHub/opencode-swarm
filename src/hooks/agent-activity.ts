/**
 * Agent Activity Tracking Hooks
 *
 * Tracks tool usage through tool.execute.before and tool.execute.after hooks.
 * Records timing, success/failure, and periodically flushes aggregated stats.
 */

import * as nodePath from 'node:path';
import type { PluginConfig } from '../config/schema';
import { atomicWriteFile } from '../evidence/task-file';
import type { ToolAggregate } from '../state';
import { swarmState } from '../state';
import { warn } from '../utils';
import { recordRealtimeLearningToolCall } from './realtime-learning-nudge';
import { readSwarmFileAsync } from './utils';

/**
 * Bounds on ToolAggregate.failureReasons (issue #2349 follow-up): the error
 * channel (`output.error`) was previously read only to answer a boolean
 * question and its value discarded. We now forward a sanitized reason, but
 * bounded — this repo requires bounded growth for any per-tool accumulator.
 */
const MAX_TOOL_FAILURE_REASONS = 5;
const MAX_TOOL_FAILURE_REASON_LENGTH = 200;

/**
 * Extracts a bounded, human-readable failure reason from a tool's `error`
 * output. Returns undefined when no usable reason can be derived (e.g. an
 * empty string or an object with no message), so callers never store an
 * empty/noise entry.
 */
function extractFailureReason(error: unknown): string | undefined {
	let raw: string | undefined;
	if (error instanceof Error) {
		raw = error.message;
	} else if (typeof error === 'string') {
		raw = error;
	} else if (error && typeof error === 'object') {
		const maybeMessage = (error as { message?: unknown }).message;
		raw = typeof maybeMessage === 'string' ? maybeMessage : undefined;
	}
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return trimmed.length > MAX_TOOL_FAILURE_REASON_LENGTH
		? `${trimmed.slice(0, MAX_TOOL_FAILURE_REASON_LENGTH)}...`
		: trimmed;
}

/**
 * Records `reason` onto `aggregate.failureReasons`, bounded to
 * MAX_TOOL_FAILURE_REASONS DISTINCT entries (issue #2349 follow-up). A
 * repeat of an already-recorded reason is a no-op — this is a small sample
 * of WHY a tool fails, not a full failure log.
 */
function recordFailureReason(aggregate: ToolAggregate, reason: string): void {
	if (!aggregate.failureReasons) {
		aggregate.failureReasons = [];
	}
	if (aggregate.failureReasons.includes(reason)) return;
	if (aggregate.failureReasons.length >= MAX_TOOL_FAILURE_REASONS) return;
	aggregate.failureReasons.push(reason);
}

/**
 * Creates agent activity tracking hooks
 * @param config Plugin configuration
 * @param directory Project directory path
 * @returns Tool before and after hook handlers
 */
export function createAgentActivityHooks(
	config: PluginConfig,
	directory: string,
): {
	toolBefore: (
		input: { tool: string; sessionID: string; callID: string },
		output: { args: unknown },
	) => Promise<void>;
	toolAfter: (
		input: { tool: string; sessionID: string; callID: string },
		output: {
			title?: string;
			output?: unknown;
			metadata?: unknown;
			error?: unknown;
			success?: boolean;
		},
	) => Promise<void>;
} {
	// If agent activity tracking is disabled, return no-op handlers
	if (config.hooks?.agent_activity === false) {
		return {
			toolBefore: async () => {},
			toolAfter: async () => {},
		};
	}

	return {
		/**
		 * Records the start of a tool call
		 */
		toolBefore: async (input) => {
			swarmState.activeToolCalls.set(input.callID, {
				tool: input.tool,
				sessionID: input.sessionID,
				callID: input.callID,
				startTime: Date.now(),
			});
		},

		/**
		 * Records the completion of a tool call and updates aggregates
		 */
		toolAfter: async (input, output) => {
			// Look up the start entry
			const entry = swarmState.activeToolCalls.get(input.callID);

			// If no entry found, return gracefully (orphaned after without before)
			if (!entry) return;

			// Delete the entry from activeToolCalls
			swarmState.activeToolCalls.delete(input.callID);

			// Compute duration
			const duration = Date.now() - entry.startTime;

			// Some tools succeed without populating output.output. Only count a failure when
			// the hook receives an explicit failure signal.
			const explicitSuccess =
				typeof output.success === 'boolean' ? output.success : undefined;
			const explicitFailure = explicitSuccess === false || !!output.error;
			const success = !explicitFailure;

			// Update toolAggregates
			const key = entry.tool;
			const existing: ToolAggregate = swarmState.toolAggregates.get(key) ?? {
				tool: key,
				count: 0,
				successCount: 0,
				failureCount: 0,
				totalDuration: 0,
			};

			existing.count++;
			if (success) {
				existing.successCount++;
			} else {
				existing.failureCount++;
				// Forward WHY the tool failed (bounded, deduplicated) instead of
				// discarding output.error after reading it only as a boolean
				// (issue #2349 follow-up).
				const reason = extractFailureReason(output.error);
				if (reason) recordFailureReason(existing, reason);
			}
			existing.totalDuration += duration;

			swarmState.toolAggregates.set(key, existing);
			recordRealtimeLearningToolCall(entry.sessionID);

			// Increment pending events counter
			swarmState.pendingEvents++;

			// If we have enough pending events, trigger flush (fire-and-forget)
			if (swarmState.pendingEvents >= 20) {
				flushActivityToFile(directory).catch((err) =>
					warn('Agent activity flush trigger failed:', err),
				);
			}
		},
	};
}

// Flush promise to ensure only one flush operation runs at a time
let flushPromise: Promise<void> | null = null;

/**
 * Flushes activity data to context.md file
 * Ensures only one flush operation runs at a time
 * @param directory Project directory path
 */
async function flushActivityToFile(directory: string): Promise<void> {
	if (flushPromise) {
		// Queue behind current flush
		flushPromise = flushPromise
			.then(() => doFlush(directory))
			.catch((err) => {
				warn('Queued agent activity flush failed:', err);
			});
		return flushPromise;
	}

	flushPromise = doFlush(directory);
	try {
		await flushPromise;
	} finally {
		flushPromise = null;
	}
}

/**
 * Actually performs the flush operation to update context.md
 * @param directory Project directory path
 */
async function doFlush(directory: string): Promise<void> {
	try {
		// Read existing context.md
		const content = await readSwarmFileAsync(directory, 'context.md');
		const existing = content ?? '';

		// Build the Agent Activity section
		const activitySection = renderActivitySection();

		// Replace or append the ## Agent Activity section
		const updated = replaceOrAppendSection(
			existing,
			'## Agent Activity',
			activitySection,
		);

		// Capture pending count before write (new events may arrive during I/O)
		const flushedCount = swarmState.pendingEvents;

		// Write back (atomic: write to temp then rename; invalidates the swarm
		// artifact cache after a successful rename so the next read-modify-write
		// of context.md — this function reads the same path at line ~151 — never
		// observes stale content, issue #1729)
		const path = nodePath.join(directory, '.swarm', 'context.md');
		await atomicWriteFile(path, updated);

		// Subtract flushed count (preserves events that arrived during write)
		swarmState.pendingEvents = Math.max(
			0,
			swarmState.pendingEvents - flushedCount,
		);
	} catch (error) {
		warn('Agent activity flush failed:', error);
		// Don't reset pendingEvents — will retry on next trigger
	}
}

/**
 * Renders the agent activity section as markdown
 * @returns Formatted markdown string
 */
function renderActivitySection(): string {
	const lines: string[] = ['## Agent Activity', ''];

	if (swarmState.toolAggregates.size === 0) {
		lines.push('No tool activity recorded yet.');
		return lines.join('\n');
	}

	// Table header
	lines.push('| Tool | Calls | Success | Failed | Avg Duration |');
	lines.push('|------|-------|---------|--------|--------------|');

	// Sort by call count descending
	const sorted = [...swarmState.toolAggregates.values()].sort(
		(a, b) => b.count - a.count,
	);

	for (const agg of sorted) {
		const avgDuration =
			agg.count > 0 ? Math.round(agg.totalDuration / agg.count) : 0;
		lines.push(
			`| ${agg.tool} | ${agg.count} | ${agg.successCount} | ${agg.failureCount} | ${avgDuration}ms |`,
		);
	}

	return lines.join('\n');
}

/**
 * Replaces or appends a section in markdown content
 * @param content Original markdown content
 * @param heading Section heading to replace
 * @param newSection New section content
 * @returns Updated markdown content
 */
function replaceOrAppendSection(
	content: string,
	heading: string,
	newSection: string,
): string {
	// Find the heading in the content
	const headingIndex = content.indexOf(heading);

	if (headingIndex === -1) {
		// Append at end with double newline separator
		return `${content.trimEnd()}\n\n${newSection}\n`;
	}

	// Find the next ## heading after this one (or end of content)
	const afterHeading = content.substring(headingIndex + heading.length);
	const nextHeadingMatch = afterHeading.match(/\n## /);

	if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
		// Replace from heading to next heading
		const endIndex = headingIndex + heading.length + nextHeadingMatch.index;
		return `${content.substring(0, headingIndex)}${newSection}\n${content.substring(endIndex + 1)}`;
	}

	// Replace from heading to end of file
	return `${content.substring(0, headingIndex)}${newSection}\n`;
}

// Export for testing purposes
export { flushActivityToFile as _flushForTesting };
