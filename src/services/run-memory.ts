/**
 * Run Memory Service
 *
 * Provides append-only per-task outcome logging for tracking task execution
 * results across swarm sessions. Used to avoid repeating known failure patterns.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { sanitizeContextText } from '../hooks/context-sanitizer.js';
import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils/logger.js';
import { validateWorkspaceRoot } from '../utils/path-security';

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
	/**
	 * Outcome of the task execution.
	 *
	 * PRODUCER COVERAGE (keep this note accurate — directive 2, no unwired code):
	 * - `pass` / `fail` are produced today by TWO call sites, deliberately split:
	 *   1. `plan/manager.updateTaskStatus` records the TERMINAL outcome after
	 *      savePlan succeeds — `completed` -> pass, `blocked` -> fail. It lives
	 *      there, not in the `update_task_status` tool, because the tool is only
	 *      one of two writers: the council APPROVE fast-path completes tasks via
	 *      `advanceTaskStateAndPersist` (src/state.ts) with no tool call.
	 *   2. `update_task_status` records a `fail` when a council or QA gate
	 *      BLOCKS a completion. That is a refusal, not a status transition, so
	 *      it never reaches updateTaskStatus and must be recorded at the tool.
	 * - `retry` has a CONSUMER (`summarizeTask` below treats it like `fail`) but
	 *   no producer. It is deliberately retained for the guardrails
	 *   transient-retry path (AGENTS.md invariant 9), which owns retry
	 *   accounting and is out of scope here. Do not add a `retry` producer from
	 *   the task-status path — a gate block is a real failure, not a retry.
	 * - `skip` has neither producer nor consumer (`summarizeTask` ignores it).
	 *   It is retained only so pre-existing `.swarm/run-memory.jsonl` lines
	 *   written by hand or by older builds still parse.
	 */
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
	validateWorkspaceRoot(directory);
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
	validateWorkspaceRoot(directory);
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
 * Input for {@link recordTaskAttempt}. `attemptNumber` and `taskFingerprint`
 * are derived, not supplied — callers know the task, not its history.
 */
export interface TaskAttemptInput {
	/** Plan.json task ID (e.g. "3.2") */
	taskId: string;
	/** Which agent executed the task (e.g. "coder") */
	agent: string;
	/** Outcome of this attempt */
	outcome: RunMemoryEntry['outcome'];
	/** One-line failure reason — required in practice for fail/retry to be useful */
	failureReason?: string;
	/** Plan `files_touched` for the task; feeds the fingerprint */
	fileTargets?: string[];
	/** Wall-clock time in milliseconds */
	durationMs?: number;
}

/**
 * Record one task attempt, deriving the attempt number from prior history.
 *
 * This is the single production producer for `.swarm/run-memory.jsonl`, which
 * `getRunMemorySummary` reads back for cross-turn failure-pattern avoidance.
 *
 * Advisory-only and fail-open by contract: run memory is context enrichment,
 * never a correctness gate, so a write failure must never surface to — or
 * abort — the caller's primary operation (a task status update). The work is
 * still awaited rather than fire-and-forget, so the entry is durable before the
 * caller returns and a test can observe it.
 *
 * @param directory - The swarm workspace directory
 * @param input - The attempt to record
 */
export async function recordTaskAttempt(
	directory: string,
	input: TaskAttemptInput,
): Promise<void> {
	try {
		// Attempt number is 1-indexed over every prior entry for this task,
		// regardless of outcome: attempt 2 follows attempt 1 whether attempt 1
		// failed a gate or passed. Read history here rather than inside
		// recordOutcome so recordOutcome stays a true append-only write.
		//
		// The read has its OWN catch: a transient history-read failure must not
		// discard the entry we were asked to record. Losing a real gate failure
		// (fail-closed on the data) is worse than an imprecise attempt number.
		let history: RunMemoryEntry[] = [];
		try {
			history = await _internals.getTaskHistory(directory, input.taskId);
		} catch (err) {
			warn(
				`[run-memory] history read for task ${input.taskId} failed; recording with attemptNumber 1: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		const entry: RunMemoryEntry = {
			timestamp: new Date().toISOString(),
			taskId: input.taskId,
			taskFingerprint: _internals.generateTaskFingerprint(
				input.taskId,
				input.fileTargets ?? [],
			),
			agent: input.agent,
			outcome: input.outcome,
			attemptNumber: history.length + 1,
		};
		if (input.failureReason) {
			entry.failureReason = input.failureReason;
		}
		if (input.fileTargets && input.fileTargets.length > 0) {
			entry.filesModified = input.fileTargets;
		}
		if (typeof input.durationMs === 'number') {
			entry.durationMs = input.durationMs;
		}
		await _internals.recordOutcome(directory, entry);
	} catch (err) {
		// Advisory-only — never block the caller on run-memory bookkeeping.
		// But never swallow SILENTLY either: this feature previously produced
		// nothing for its entire life with no signal anywhere. Debug-gated so it
		// stays out of chat-visible streams (invariant 10); the consumer side
		// logs symmetrically at knowledge-injector.ts.
		warn(
			`[run-memory] failed to record ${input.outcome} for task ${input.taskId}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
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
	// Order by POSITION IN THE LOG, never by timestamp.
	//
	// `.swarm/run-memory.jsonl` is append-only, so array order (which is file
	// order — groupByTaskId preserves it) is the authoritative sequence. The
	// timestamps are ISO strings with millisecond resolution, and two entries
	// recorded back-to-back routinely land in the SAME millisecond on a fast
	// host: a pass followed by a regression then compared equal, and the task
	// was reported as resolved. That is not hypothetical — it failed the
	// ubuntu CI shard while passing on slower machines. Positions cannot tie
	// and are immune to clock skew.
	let lastFailure: RunMemoryEntry | undefined;
	let lastFailureIndex = -1;
	let lastPassIndex = -1;
	let lastPass: RunMemoryEntry | undefined;
	let failCount = 0;

	entries.forEach((entry, index) => {
		if (entry.outcome === 'fail' || entry.outcome === 'retry') {
			failCount++;
			lastFailure = entry;
			lastFailureIndex = index;
		} else if (entry.outcome === 'pass') {
			lastPass = entry;
			lastPassIndex = index;
		}
	});

	// Skip tasks with only passes
	if (!lastFailure) {
		return null;
	}

	// The pass only resolves the failure if it actually came AFTER it.
	// `completed -> blocked` is a permitted transition (the settled guards only
	// protect `in_progress`), so a task can pass and later regress. Reporting
	// "Passed on attempt N" for a currently-blocked task would tell the
	// architect the opposite of the truth.
	const passResolvesFailure = lastPassIndex > lastFailureIndex;

	if (lastPass && passResolvesFailure) {
		// There's a passing attempt after failures
		const passAttempt = lastPass.attemptNumber;
		const failAttempt = lastFailure.attemptNumber;
		const reason = sanitizeContextText(lastFailure.failureReason || 'unknown');
		return `Task ${taskId}: FAILED attempt ${failAttempt} — ${reason}. Passed on attempt ${passAttempt}.`;
	} else {
		// Still failing - no pass yet
		const reason = sanitizeContextText(lastFailure.failureReason || 'unknown');
		return `Task ${taskId}: FAILED ${failCount} times — last: ${reason}. Still failing.`;
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
	validateWorkspaceRoot(directory);
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
	recordTaskAttempt: typeof recordTaskAttempt;
	getTaskHistory: typeof getTaskHistory;
	getRunMemorySummary: typeof getRunMemorySummary;
	groupByTaskId: typeof groupByTaskId;
	summarizeTask: typeof summarizeTask;
} = {
	generateTaskFingerprint,
	recordOutcome,
	recordTaskAttempt,
	getTaskHistory,
	getRunMemorySummary,
	groupByTaskId,
	summarizeTask,
} as const;
