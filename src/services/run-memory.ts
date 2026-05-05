/**
 * Run Memory Service
 *
 * Provides append-only per-task outcome logging for tracking task execution
 * results across swarm sessions. Used to avoid repeating known failure patterns.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { validateDirectory } from '../utils/path-security';

/**
 * Represents a single task execution outcome entry
 */
export interface RunMemoryEntry {
	/** ISO timestamp when the entry was recorded */
	timestamp: string;
	/** Plan.json task ID (e.g. "3.2") */
	taskId: string;
	/** SHA256 hash of taskId + sorted file targets, first 8 chars */
	taskFingerprint: string;
	/** Which agent executed the task (e.g. "coder") */
	agent: string;
	/** Outcome of the task execution */
	outcome: 'pass' | 'fail' | 'retry' | 'skip';
	/** 1-indexed attempt number */
	attemptNumber: number;
	/** One-line failure reason (only for fail/retry outcomes) */
	failureReason?: string;
	/** Files that were modified during this attempt */
	filesModified?: string[];
	/** Wall-clock time in milliseconds */
	durationMs?: number;
}

/**
 * File name for run memory storage
 */
const RUN_MEMORY_FILENAME = 'run-memory.jsonl';

/**
 * Maximum tokens for summary output
 */
const MAX_SUMMARY_TOKENS = 500;

/**
 * Generate a task fingerprint from taskId and file targets
 *
 * @param taskId - The task identifier
 * @param fileTargets - Array of file paths that were targeted
 * @returns First 8 characters of SHA256 hash
 */
export function generateTaskFingerprint(
	taskId: string,
	fileTargets: string[],
): string {
	const sortedFiles = [...fileTargets].sort().join(',');
	const hash = crypto
		.createHash('sha256')
		.update(taskId + sortedFiles)
		.digest('hex');
	return hash.slice(0, 8);
}

/**
 * Append a task outcome entry to the run memory log
 *
 * @param directory - The swarm workspace directory
 * @param entry - The outcome entry to record
 */
export async function recordOutcome(
	directory: string,
	entry: RunMemoryEntry,
): Promise<void> {
	validateDirectory(directory);
	const resolvedPath = validateSwarmPath(directory, RUN_MEMORY_FILENAME);
	const line = `${JSON.stringify(entry)}\n`;

	// True append-only write - do NOT read existing content
	await fs.appendFile(resolvedPath, line, { encoding: 'utf-8' });
}

/**
 * Get all entries for a specific task ID
 *
 * @param directory - The swarm workspace directory
 * @param taskId - The task identifier to filter by
 * @returns Array of matching entries
 */
export async function getTaskHistory(
	directory: string,
	taskId: string,
): Promise<RunMemoryEntry[]> {
	validateDirectory(directory);
	const content = await readSwarmFileAsync(directory, RUN_MEMORY_FILENAME);
	if (!content) {
		return [];
	}

	const entries: RunMemoryEntry[] = [];
	const lines = content.split('\n');

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as RunMemoryEntry;
			if (entry.taskId === taskId) {
				entries.push(entry);
			}
		} catch {
			// Skip malformed lines
		}
	}

	return entries;
}

/**
 * Get all failure and retry entries
 *
 * @param directory - The swarm workspace directory
 * @returns Array of fail/retry entries
 */
export async function getFailures(
	directory: string,
): Promise<RunMemoryEntry[]> {
	validateDirectory(directory);
	const content = await readSwarmFileAsync(directory, RUN_MEMORY_FILENAME);
	if (!content) {
		return [];
	}

	const entries: RunMemoryEntry[] = [];
	const lines = content.split('\n');

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as RunMemoryEntry;
			if (entry.outcome === 'fail' || entry.outcome === 'retry') {
				entries.push(entry);
			}
		} catch {
			// Skip malformed lines
		}
	}

	return entries;
}

/**
 * Group entries by taskId
 */
function groupByTaskId(
	entries: RunMemoryEntry[],
): Map<string, RunMemoryEntry[]> {
	const groups = new Map<string, RunMemoryEntry[]>();

	for (const entry of entries) {
		const existing = groups.get(entry.taskId) || [];
		existing.push(entry);
		groups.set(entry.taskId, existing);
	}

	return groups;
}

/**
 * Build a summary line for a single task
 */
function summarizeTask(
	taskId: string,
	entries: RunMemoryEntry[],
): string | null {
	// Filter to only fail/retry entries
	const failures = entries.filter(
		(e) => e.outcome === 'fail' || e.outcome === 'retry',
	);
	const passes = entries.filter((e) => e.outcome === 'pass');

	// Skip tasks with only passes
	if (failures.length === 0) {
		return null;
	}

	// Find the most recent failure
	failures.sort(
		(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
	);
	const lastFailure = failures[0];

	// Find the pass that followed (if any)
	passes.sort(
		(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
	);
	const lastPass = passes[0];

	const failCount = failures.length;

	if (lastPass) {
		// There's a passing attempt after failures
		const passAttempt = lastPass.attemptNumber;
		const failAttempt = lastFailure.attemptNumber;
		return `Task ${taskId}: FAILED attempt ${failAttempt} — ${lastFailure.failureReason || 'unknown'}. Passed on attempt ${passAttempt}.`;
	} else {
		// Still failing - no pass yet
		return `Task ${taskId}: FAILED ${failCount} times — last: ${lastFailure.failureReason || 'unknown'}. Still failing.`;
	}
}

/**
 * Generate a compact summary of task failures for context injection
 *
 * @param directory - The swarm workspace directory
 * @returns Formatted summary string (≤500 tokens) or null if no failures
 */
export async function getRunMemorySummary(
	directory: string,
): Promise<string | null> {
	validateDirectory(directory);
	const content = await readSwarmFileAsync(directory, RUN_MEMORY_FILENAME);
	if (!content) {
		return null;
	}

	const entries: RunMemoryEntry[] = [];
	const lines = content.split('\n');

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as RunMemoryEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	if (entries.length === 0) {
		return null;
	}

	// Group by taskId
	const groups = _internals.groupByTaskId(entries);

	// Build summaries for tasks with failures
	const summaries: string[] = [];
	for (const [taskId, taskEntries] of groups) {
		const summary = _internals.summarizeTask(taskId, taskEntries);
		if (summary) {
			summaries.push(summary);
		}
	}

	if (summaries.length === 0) {
		return null;
	}

	// Define prefix and suffix
	const prefix =
		'[FOR: architect, coder]\n## RUN MEMORY — Previous Task Outcomes\n';
	const suffix = '\nUse this data to avoid repeating known failure patterns.';

	// Start with summaries joined together
	let summaryText = summaries.join('\n');

	// Estimate tokens including prefix + content + suffix
	const estimateTokens = (text: string): number => {
		return Math.ceil(text.length * 0.33);
	};

	// Cap at MAX_SUMMARY_TOKENS - include prefix/suffix in token budget
	const totalText = prefix + summaryText + suffix;
	const estimatedTokens = estimateTokens(totalText);

	if (estimatedTokens > MAX_SUMMARY_TOKENS) {
		// Calculate available tokens for summary content
		const prefixTokens = estimateTokens(prefix);
		const suffixTokens = estimateTokens(suffix);
		const availableContentTokens =
			MAX_SUMMARY_TOKENS - prefixTokens - suffixTokens;

		if (availableContentTokens > 0) {
			// Calculate how many characters we can fit
			const maxContentChars = Math.floor(availableContentTokens / 0.33);
			// Truncate content
			summaryText = summaryText.slice(0, maxContentChars);
		} else {
			// Not enough room - use minimal content
			summaryText = '';
		}
	}

	return prefix + summaryText + suffix;
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	generateTaskFingerprint: typeof generateTaskFingerprint;
	recordOutcome: typeof recordOutcome;
	getTaskHistory: typeof getTaskHistory;
	getFailures: typeof getFailures;
	getRunMemorySummary: typeof getRunMemorySummary;
	groupByTaskId: typeof groupByTaskId;
	summarizeTask: typeof summarizeTask;
} = {
	generateTaskFingerprint,
	recordOutcome,
	getTaskHistory,
	getFailures,
	getRunMemorySummary,
	groupByTaskId,
	summarizeTask,
} as const;
