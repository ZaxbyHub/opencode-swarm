/**
 * TRAJECTORY LOGGER (v6.31 Task 3.2)
 *
 * tool.execute.after hook that appends per-task tool call trajectories to a
 * .swarm/evidence/{taskId}/trajectory.jsonl file. Only logs INSIDE delegation
 * scope (when delegationActive is true on the session).
 *
 * Trajectories are used for post-hoc analysis, audit trails, and replay.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { sanitizeTaskId } from '../evidence/manager';
import { appendTrajectoryEntry } from '../prm/trajectory-store';
import { swarmState } from '../state';
import { deriveGateDenialCode } from './gate-denial-tracker';
import { normalizeToolNameLowerCase } from './normalize-tool-name';
import {
	clearTrajectoryStepCounters,
	nextTrajectoryStep,
	resetTrajectoryStepCounter,
} from './trajectory-step-state.js';
import { validateSwarmPath } from './utils';

export interface TrajectoryConfig {
	enabled: boolean;
	max_lines: number;
}

export interface TrajectoryEntry {
	step: number;
	agent: string;
	action: string;
	target: string;
	intent: string;
	timestamp: string;
	result: 'success' | 'failure' | 'pending';
	tool: string;
	args_summary: string;
	verdict: string;
	elapsed_ms: number;
	/**
	 * Host tool-call id. Written only by {@link recordDeniedToolCall} (issue
	 * #2063 D1) so a `tool.execute.after` that unexpectedly fires for a call
	 * whose before-hook already threw can be recognised and skipped instead of
	 * double-recording the same call.
	 */
	callID?: string;
}

/**
 * Module-level map for tracking tool call start times.
 * Populated by toolBefore (via recordToolCallStart), consumed by toolAfter.
 */
const callStartTimes = new Map<string, number>();

/**
 * Sensitive field names to redact in args summaries.
 */
const SENSITIVE_FIELDS = new Set([
	'password',
	'token',
	'secret',
	'api_key',
	'apikey',
	'authorization',
	'access_token',
	'refresh_token',
	'private_key',
	'secret_key',
	'credential',
	'auth',
	'bearer',
	'x-api-key',
	'session_id',
	'cookie',
]);

/**
 * Substrings that indicate a sensitive key name.
 * Used for case-insensitive partial matching to avoid false positives.
 */
const SENSITIVE_SUBSTRINGS = [
	'key',
	'secret',
	'token',
	'password',
	'auth',
	'credential',
	'private',
	'certificate',
	'bearer',
	'session',
	'cookie',
];

/**
 * Check if a key name contains any sensitive substring.
 */
function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	return SENSITIVE_SUBSTRINGS.some((substr) => lower.includes(substr));
}

/**
 * Truncates a trajectory file to the newest half when maxLines is exceeded.
 * Reads all lines, keeps the newest half, rewrites the file.
 *
 * @param filePath - Absolute path to the trajectory.jsonl file
 * @param maxLines - Maximum number of lines to retain
 */
export async function truncateTrajectoryFile(
	filePath: string,
	maxLines: number,
): Promise<void> {
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim().length > 0);
		if (lines.length <= maxLines) {
			return;
		}

		// Keep the newest half
		const keepCount = Math.floor(maxLines / 2);
		const keptLines = lines.slice(-keepCount);
		await fs.writeFile(filePath, `${keptLines.join('\n')}\n`, 'utf-8');
	} catch {
		/* non-blocking: truncate errors are swallowed */
	}
}

/**
 * Derives the action type from the tool name.
 *
 * Issue #2063 D2: the name is normalized via `normalizeToolNameLowerCase`
 * first, so host-namespaced names (`opencode:bash`, `opencode.read`) bucket
 * identically to their bare forms. Previously they all fell through to
 * `tool_use`, which flattened the taxonomy PRM pattern detection reads. `grep`
 * was likewise missing from the read bucket despite being one of the most
 * frequent read-only calls.
 *
 * @param tool - Tool name (may carry a host namespace prefix)
 * @returns Action type string
 */
function deriveAction(tool: string): string {
	const toolLower = normalizeToolNameLowerCase(tool ?? '');
	if (toolLower === 'task') return 'delegate';
	if (['write', 'edit', 'apply_patch', 'swarm_apply_patch'].includes(toolLower))
		return 'edit';
	if (['read', 'glob', 'grep', 'search'].includes(toolLower)) return 'read';
	if (['bash', 'shell'].includes(toolLower)) return 'execute';
	if (toolLower === 'test_runner') return 'test';
	return 'tool_use';
}

/**
 * Extracts the target from tool arguments.
 *
 * @param tool - Tool name
 * @param args - Tool arguments object
 * @returns Target string
 */
function extractTarget(tool: string, args?: Record<string, unknown>): string {
	if (!args) return '';

	// For Task tool, use subagent_type as target
	if (tool.toLowerCase() === 'task') {
		const subagentType = args.subagent_type;
		if (typeof subagentType === 'string' && subagentType.length > 0) {
			return subagentType;
		}
	}

	// Check common target field names
	const targetFields = ['filePath', 'path', 'file', 'target'];
	for (const field of targetFields) {
		const value = args[field];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}

	// Fallback for bash/shell and other tools: extract from command/description/args fields
	// This prevents unrelated commands from collapsing to the same empty target
	const toolLower = tool.toLowerCase();
	if (
		toolLower === 'bash' ||
		toolLower === 'shell' ||
		toolLower === 'execute' ||
		toolLower === 'command'
	) {
		// Try to extract from command field
		const command = args.command;
		if (typeof command === 'string' && command.length > 0) {
			// Return first word of command as target (e.g., "git" from "git commit")
			const firstWord = command.split(/\s+/)[0] || '';
			if (firstWord.length > 0) {
				return firstWord;
			}
		}

		// Try description field
		const description = args.description;
		if (typeof description === 'string' && description.length > 0) {
			// Return first 30 chars as target to differentiate commands
			return description.length > 30
				? `${description.slice(0, 27)}...`
				: description;
		}

		// Try args field (generic fallback)
		const argsStr = args.args;
		if (typeof argsStr === 'string' && argsStr.length > 0) {
			const firstWord = argsStr.split(/\s+/)[0] || '';
			if (firstWord.length > 0) {
				return firstWord;
			}
		}
	}

	return '';
}

/**
 * Extracts the intent from tool arguments.
 *
 * @param tool - Tool name
 * @param args - Tool arguments object
 * @returns Intent string (max 100 chars for Task tool descriptions)
 */
function extractIntent(tool: string, args?: Record<string, unknown>): string {
	if (!args) return '';

	// For Task tool, extract first 100 chars of prompt or description
	if (tool.toLowerCase() === 'task') {
		const prompt = args.prompt;
		const description = args.description;
		const text =
			typeof prompt === 'string'
				? prompt
				: typeof description === 'string'
					? description
					: '';
		if (text.length > 100) {
			return `${text.slice(0, 97)}...`;
		}
		return text;
	}

	// Check for description or task fields
	const intentFields = ['description', 'task'];
	for (const field of intentFields) {
		const value = args[field];
		if (typeof value === 'string' && value.length > 0) {
			return value.length > 200 ? `${value.slice(0, 197)}...` : value;
		}
	}

	return '';
}

/**
 * Maps verdict to result status.
 *
 * @param verdict - Verdict string from tool execution
 * @returns Result status
 */
function mapResult(verdict: string): 'success' | 'failure' | 'pending' {
	if (verdict === 'success') return 'success';
	if (verdict === 'failure') return 'failure';
	return 'pending';
}

/**
 * Creates the trajectory logger hook pair.
 *
 * @param config - TrajectoryConfig { enabled: boolean (default true), max_lines: number (default 500) }
 * @param _directory - Reserved for future use (evidence path derived from session taskId)
 * @returns Object with toolAfter handler
 */
export function createTrajectoryLoggerHook(
	config: Partial<TrajectoryConfig>,
	_directory: string,
): {
	toolAfter: (
		input: {
			tool: string;
			sessionID: string;
			callID: string;
			args?: Record<string, unknown>;
		},
		output: { title: string; output: string; metadata: unknown },
	) => Promise<void>;
} {
	const enabled = config.enabled ?? true;
	const maxLines = config.max_lines ?? 500;

	return {
		toolAfter: async (input, output) => {
			if (!enabled) return;

			const sessionId = input.sessionID;

			// (#2063 D1) The before-hook chain already recorded this exact call as
			// a denial. The host is not expected to fire `tool.execute.after` for a
			// call whose `tool.execute.before` threw, but if it ever does, recording
			// again would double-count the call AND burn a second trajectory step —
			// desynchronising the `prmTrajectoryStep` window PRM reads. Consume the
			// marker and bail BEFORE `nextTrajectoryStep` is called.
			if (consumeDeniedCallMarker(sessionId, input.callID)) {
				callStartTimes.delete(`${sessionId}:${input.callID}`);
				return;
			}

			const session = swarmState.agentSessions.get(sessionId);

			// Only log INSIDE delegation scope
			if (!session?.delegationActive) {
				return;
			}

			const taskId = session.currentTaskId;
			if (!taskId) {
				return;
			}

			// Calculate elapsed time
			const startKey = `${sessionId}:${input.callID}`;
			const startTime = callStartTimes.get(startKey) ?? Date.now();
			callStartTimes.delete(startKey);
			const elapsed_ms = Date.now() - startTime;

			// Derive agent name
			const agentName =
				swarmState.activeAgent.get(sessionId) ??
				session?.agentName ??
				'unknown';

			// Summarize args as string, max 200 chars
			const args_summary = summarizeArgs(input.args, 200);

			// Derive verdict from output metadata or default to success/failure
			const verdict = deriveVerdict(output);

			// Derive step counter for this session
			const step = nextTrajectoryStep(sessionId);

			// Derive action type from tool name
			const action = deriveAction(input.tool);

			// Extract target from args
			const target = extractTarget(input.tool, input.args);

			// Extract intent from args
			const intent = extractIntent(input.tool, input.args);

			// Map verdict to result status
			const result = mapResult(verdict);

			const entry: TrajectoryEntry = {
				step,
				agent: agentName,
				action,
				target,
				intent,
				timestamp: new Date().toISOString(),
				result,
				tool: input.tool,
				args_summary,
				verdict,
				elapsed_ms,
			};

			// Append to trajectory file
			const sanitized = sanitizeTaskId(taskId);
			const relativePath = path.join('evidence', sanitized, 'trajectory.jsonl');
			const trajectoryPath = validateSwarmPath(_directory, relativePath);

			try {
				// Ensure directory exists
				await fs.mkdir(path.dirname(trajectoryPath), { recursive: true });

				// Append entry
				const line = `${JSON.stringify(entry)}\n`;
				await fs.appendFile(trajectoryPath, line, 'utf-8');

				// Truncate if exceeded max_lines
				await truncateTrajectoryFile(trajectoryPath, maxLines);
			} catch {
				/* non-blocking: file I/O errors are swallowed */
			}

			// Also write to session-level trajectory store for PRM pattern detection
			try {
				await appendTrajectoryEntry(sessionId, entry, _directory, maxLines);
			} catch {
				/* non-blocking: PRM errors should not break task-level logging */
			}
		},
	};
}

// ─── Denied-call recording (issue #2063 D1) ─────────────────────────────────

/** Bound on tracked denied-call dedupe markers (invariant 8). */
const MAX_DENIED_CALL_MARKERS = 500;

/**
 * Idle TTL for a dedupe marker. A `tool.execute.after` for a given callID
 * either arrives on the same turn or never; five minutes is generous.
 */
const DENIED_CALL_TTL_MS = 5 * 60_000;

/**
 * `${sessionID}:${callID}` -> expiry. Written by {@link recordDeniedToolCall}
 * when it actually appended an entry; consumed (and cleared) by `toolAfter`.
 */
const deniedCallMarkers = new Map<string, number>();

function markDeniedCall(sessionId: string, callID: string | undefined): void {
	if (!callID) return;
	const now = Date.now();
	for (const [key, expiresAt] of deniedCallMarkers) {
		if (expiresAt <= now) deniedCallMarkers.delete(key);
	}
	const key = `${sessionId}:${callID}`;
	deniedCallMarkers.delete(key);
	deniedCallMarkers.set(key, now + DENIED_CALL_TTL_MS);
	while (deniedCallMarkers.size > MAX_DENIED_CALL_MARKERS) {
		const oldest = deniedCallMarkers.keys().next().value;
		if (oldest === undefined || oldest === key) break;
		deniedCallMarkers.delete(oldest);
	}
}

function consumeDeniedCallMarker(
	sessionId: string,
	callID: string | undefined,
): boolean {
	if (!callID) return false;
	const key = `${sessionId}:${callID}`;
	const expiresAt = deniedCallMarkers.get(key);
	if (expiresAt === undefined) return false;
	deniedCallMarkers.delete(key);
	return expiresAt > Date.now();
}

/**
 * Records a tool call that a fail-closed `tool.execute.before` hook DENIED.
 *
 * Before this existed the trajectory only contained calls that ran, so a
 * session that spent fifty turns re-issuing a dispatch the delegation gate kept
 * rejecting looked, to PRM and to any post-hoc reader, like a session that made
 * no tool calls at all — the exact loop shape #2063 is about was invisible in
 * the record of it.
 *
 * Contract:
 *   - The step is minted with the SHARED `nextTrajectoryStep(sessionId)`. Any
 *     private counter would desynchronise the `prmTrajectoryStep` window and
 *     silently break PRM's step-range filtering.
 *   - `session.delegationActive` gates recording at all (the architect session
 *     is deliberately out of scope); the task-evidence copy additionally
 *     requires `session.currentTaskId`, so a subagent running without a task id
 *     still lands in the PRM store.
 *   - EVERY failure is swallowed. This runs inside the `catch` that is about to
 *     rethrow a policy denial; it must never change which error propagates.
 *
 * @param sessionID - Session whose chain denied the call
 * @param input - The host `tool.execute.before` input (tool / callID / args)
 * @param errorMessage - The ORIGINAL denial message, before any B1 decoration
 * @param directory - Workspace root (evidence + PRM store live under `.swarm/`)
 * @param options - `maxLines` mirrors the hook's `max_lines` config
 */
export async function recordDeniedToolCall(
	sessionID: string,
	input: {
		tool: string;
		callID?: string;
		args?: Record<string, unknown>;
	},
	errorMessage: string,
	directory: string,
	options?: { maxLines?: number },
): Promise<void> {
	try {
		const session = swarmState.agentSessions.get(sessionID);
		if (!session?.delegationActive) return;

		const maxLines = options?.maxLines ?? 500;

		const startKey = `${sessionID}:${input.callID}`;
		const startTime = callStartTimes.get(startKey);
		if (startTime !== undefined) callStartTimes.delete(startKey);
		const elapsed_ms = startTime === undefined ? 0 : Date.now() - startTime;

		const agentName =
			swarmState.activeAgent.get(sessionID) ?? session.agentName ?? 'unknown';

		const code = deriveGateDenialCode(errorMessage);

		const entry: TrajectoryEntry = {
			step: nextTrajectoryStep(sessionID),
			agent: agentName,
			action: deriveAction(input.tool),
			target: extractTarget(input.tool, input.args),
			intent: `denied: ${code}`,
			timestamp: new Date().toISOString(),
			result: 'failure',
			tool: input.tool,
			args_summary: summarizeArgs(input.args, 200),
			verdict: 'failure',
			elapsed_ms,
			callID: input.callID,
		};

		// Claim the callID before any I/O so a `tool.execute.after` that races in
		// cannot slip a duplicate entry past the guard.
		markDeniedCall(sessionID, input.callID);

		// Session-level PRM store — the copy that matters for loop detection.
		try {
			await appendTrajectoryEntry(sessionID, entry, directory, maxLines);
		} catch {
			/* non-blocking: PRM store failures must not block the rethrow */
		}

		// Task-evidence copy, only when the session is bound to a task.
		const taskId = session.currentTaskId;
		if (!taskId) return;
		try {
			const relativePath = path.join(
				'evidence',
				sanitizeTaskId(taskId),
				'trajectory.jsonl',
			);
			const trajectoryPath = validateSwarmPath(directory, relativePath);
			// drift-test:exempt — target is .swarm/evidence/{taskId}/trajectory.jsonl and
			// 'evidence/' IS in PRESERVED_SWARM_PATHS, but the scanner matches the literal
			// against a +/-2-line window and path.join('evidence', ...) segments never carry
			// the trailing slash it looks for. Same artifact as the toolAfter writer above.
			await fs.mkdir(path.dirname(trajectoryPath), { recursive: true });
			await fs.appendFile(
				trajectoryPath,
				`${JSON.stringify(entry)}\n`,
				'utf-8',
			);
			await truncateTrajectoryFile(trajectoryPath, maxLines);
		} catch {
			/* non-blocking: evidence I/O errors are swallowed */
		}
	} catch {
		/* fail-open by contract: never prevent the B1 rethrow */
	}
}

/** Test helper: drop all denied-call dedupe markers. */
export function clearDeniedCallMarkers(): void {
	deniedCallMarkers.clear();
}

/**
 * Resets the step counter for a session. Called when a new session starts
 * or when trajectory tracking should restart from step 1.
 *
 * @param sessionId - Session identifier
 */
export function resetTrajectoryStep(sessionId: string): void {
	resetTrajectoryStepCounter(sessionId);
}

/**
 * Clears trajectory step counters for one session, or all sessions when omitted.
 *
 * @param sessionId - Optional session identifier
 */
export function clearTrajectoryStep(sessionId?: string): void {
	clearTrajectoryStepCounters(sessionId);
}

/**
 * Records the start time for a tool call (called from toolBefore).
 * Stored in a module-level Map for correlation with toolAfter.
 *
 * @param sessionId - Session identifier
 * @param callID - Tool call identifier
 * @param startTime - Start timestamp in milliseconds
 */
export function recordToolCallStart(
	sessionId: string,
	callID: string,
	startTime: number,
): void {
	const key = `${sessionId}:${callID}`;
	callStartTimes.set(key, startTime);

	// Cleanup stale entries older than 30 minutes to prevent memory leak
	const cutoff = Date.now() - 30 * 60 * 1000;
	for (const [k, timestamp] of callStartTimes.entries()) {
		if (timestamp < cutoff) {
			callStartTimes.delete(k);
		}
	}
}

/**
 * Summarizes tool arguments as a compact string.
 * Handles nested objects, arrays, and sensitive fields.
 *
 * @param args - Tool arguments object
 * @param maxLength - Maximum length of the summary string
 * @returns Compact string summary
 */
function summarizeArgs(
	args: Record<string, unknown> | undefined,
	maxLength: number,
): string {
	if (!args || Object.keys(args).length === 0) {
		return '';
	}

	const summaries: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		// Skip sensitive fields - check exact match and substring match
		if (SENSITIVE_FIELDS.has(key) || isSensitiveKey(key)) {
			summaries.push(`${key}:[REDACTED]`);
			continue;
		}

		if (value === null || value === undefined) {
			summaries.push(`${key}:null`);
		} else if (typeof value === 'string') {
			// Truncate long string values
			const truncated = value.length > 50 ? `${value.slice(0, 50)}...` : value;
			summaries.push(`${key}:"${truncated}"`);
		} else if (typeof value === 'number' || typeof value === 'boolean') {
			summaries.push(`${key}:${String(value)}`);
		} else if (Array.isArray(value)) {
			const itemSummary =
				value.length > 3
					? `${value.slice(0, 3).map(String).join(',')},...(+${value.length - 3})`
					: value.map(String).join(',');
			summaries.push(`${key}:[${itemSummary}]`);
		} else if (typeof value === 'object') {
			const keys = Object.keys(value as Record<string, unknown>);
			summaries.push(`${key}:{${keys.join(',')}}`);
		} else {
			summaries.push(`${key}:${typeof value}`);
		}
	}

	const summary = summaries.join(' ');
	return summary.length > maxLength
		? `${summary.slice(0, maxLength - 3)}...`
		: summary;
}

/**
 * Derives the verdict from tool output metadata or string content.
 *
 * @param output - Tool execution output
 * @returns 'success', 'failure', or a custom verdict string
 */
function deriveVerdict(output: {
	title: string;
	output: string;
	metadata: unknown;
}): string {
	// Check metadata for verdict signal
	if (
		output.metadata &&
		typeof output.metadata === 'object' &&
		!Array.isArray(output.metadata)
	) {
		const meta = output.metadata as Record<string, unknown>;

		// Check for explicit verdict field
		if (typeof meta.verdict === 'string' && meta.verdict.length > 0) {
			return meta.verdict;
		}

		// Check for success/passed fields
		if (meta.success === false || meta.passed === false) {
			return 'failure';
		}
		if (meta.success === true || meta.passed === true) {
			return 'success';
		}
	}

	// Fallback: check output string for error indicators
	const outputStr = String(output.output ?? '');
	if (
		outputStr.startsWith('Error:') ||
		outputStr.startsWith('error:') ||
		outputStr.startsWith('Error: ')
	) {
		return 'failure';
	}

	return 'success';
}

/**
 * Tier-0 pure-function test seam (writing-tests skill). These helpers take no
 * external dependencies, so testing them directly needs no mocks at all.
 */
export const _test_exports = {
	deriveAction,
	extractTarget,
	MAX_DENIED_CALL_MARKERS,
	DENIED_CALL_TTL_MS,
	deniedCallMarkerCount: (): number => deniedCallMarkers.size,
} as const;
