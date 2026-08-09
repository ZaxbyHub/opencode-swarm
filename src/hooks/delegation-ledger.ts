/**
 * DELEGATION LEDGER (v6.31 Task 3.2)
 *
 * tool.execute.after hook that maintains a per-session in-memory ledger of tool calls
 * made during a delegation. When the architect session receives a message (resume),
 * injects a compact DELEGATION SUMMARY via pendingAdvisoryMessages.
 *
 * No file I/O — fully in-memory.
 */

import { swarmState } from '../state';
import { normalizeToolNameLowerCase } from './normalize-tool-name';

export interface LedgerEntry {
	agent: string;
	tool: string;
	file?: string; // extracted from args.path/filePath if present
	duration_ms: number;
	success: boolean;
	timestamp: number;
}

export interface DelegationLedgerConfig {
	enabled: boolean; // default true
}

/**
 * In-memory ledger stored per-session.
 * Key: sessionId, Value: list of tool call entries
 *
 * Bounded two ways (invariant 8):
 *  - MAX_TRACKED_SESSIONS caps the number of distinct session keys (FIFO).
 *  - MAX_LEDGER_ENTRIES_PER_SESSION caps each session's entry list (keep-latest).
 */
const ledgerBySession = new Map<string, LedgerEntry[]>();

/**
 * Max distinct sessions tracked in ledgerBySession before the oldest-inserted
 * session is evicted (FIFO). Mirrors adversarial-detector.ts / pr-event-delivery.ts.
 */
const MAX_TRACKED_SESSIONS = 500;

/**
 * Max entries retained per session. Older entries are dropped (keep-latest) and
 * the count of dropped entries is disclosed in the DELEGATION SUMMARY when the
 * ledger is summarized. Each LedgerEntry is small (a few primitives), so 200
 * keeps a single delegation's history well within budget.
 */
const MAX_LEDGER_ENTRIES_PER_SESSION = 200;

/**
 * Per-session count of ledger entries that were dropped due to the
 * MAX_LEDGER_ENTRIES_PER_SESSION cap, keyed by sessionId. Used to disclose
 * truncation in the DELEGATION SUMMARY. Cleared alongside the ledger on resume.
 */
const droppedEntryCounts = new Map<string, number>();

// Track call start times: key = sessionId:callID
//
// NOTE(invariant 8): unlike trajectory-logger's callStartTimes (which is
// populated via recordToolCallStart), THIS map has no writer — toolAfter only
// reads (with a Date.now() fallback) and deletes. It is therefore always empty
// and cannot grow unbounded, so no cap is required here. Left in place because
// removing it would change the public hook shape; a future change should either
// wire up a writer or delete this dead state.
const callStartTimes = new Map<string, number>();

/**
 * Creates the delegation ledger hook pair (toolAfter + summary injection).
 */
export function createDelegationLedgerHook(
	config: Partial<DelegationLedgerConfig>,
	_directory: string, // reserved for future use
	injectAdvisory: (sessionId: string, message: string) => void,
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
	onArchitectResume: (sessionId: string) => void; // call when architect session gets a new message
} {
	const enabled = config.enabled ?? true;

	return {
		toolAfter: async (input, output) => {
			if (!enabled) return;

			const sessionId = input.sessionID;

			// Record start time if toolBefore logged it, else estimate
			const startKey = `${sessionId}:${input.callID}`;
			const startTime = callStartTimes.get(startKey) ?? Date.now();
			callStartTimes.delete(startKey);
			const duration_ms = Date.now() - startTime;

			// Determine file touched (if any)
			const args = input.args ?? {};
			const file =
				typeof args.path === 'string'
					? args.path
					: typeof args.filePath === 'string'
						? args.filePath
						: typeof args.file === 'string'
							? args.file
							: undefined;

			// Determine agent name
			const session = swarmState.agentSessions.get(sessionId); // ← needs swarmState import
			const agentName =
				swarmState.activeAgent?.get(sessionId) ??
				session?.agentName ??
				'unknown';

			// Determine success from output — conservative check
			const outputStr = String(output.output ?? '');
			const success =
				!outputStr.startsWith('Error:') && !outputStr.startsWith('error: ');

			const entry: LedgerEntry = {
				agent: agentName,
				tool: input.tool,
				file,
				duration_ms,
				success,
				timestamp: Date.now(),
			};

			const existing = ledgerBySession.get(sessionId) ?? [];
			existing.push(entry);
			// Per-session entry cap (keep-latest): drop oldest entries beyond the cap
			// and record how many were dropped so the DELEGATION SUMMARY can disclose
			// truncation (invariant 8).
			if (existing.length > MAX_LEDGER_ENTRIES_PER_SESSION) {
				const dropped = existing.length - MAX_LEDGER_ENTRIES_PER_SESSION;
				existing.splice(0, dropped);
				droppedEntryCounts.set(
					sessionId,
					(droppedEntryCounts.get(sessionId) ?? 0) + dropped,
				);
			}
			ledgerBySession.set(sessionId, existing);
			// FIFO-cap the session-key count (invariant 8): evict oldest-inserted
			// session to bound memory. Map preserves insertion order. Skip
			// self-eviction of the session we just wrote (re-setting an existing key
			// does not change its insertion order, so this only fires for new keys).
			while (ledgerBySession.size > MAX_TRACKED_SESSIONS) {
				const oldest = ledgerBySession.keys().next().value;
				if (oldest === undefined || oldest === sessionId) break;
				ledgerBySession.delete(oldest);
				droppedEntryCounts.delete(oldest);
			}
		},

		onArchitectResume: (architectSessionId: string) => {
			if (!enabled) return;

			// Collect entries from all non-architect sessions
			// (we gather the most recent delegation's entries)
			const allEntries: LedgerEntry[] = [];
			// Aggregate per-session dropped-entry counts (invariant 8 disclosure)
			// BEFORE clearing the ledger.
			let totalDroppedEntries = 0;
			for (const [sessionId, entries] of ledgerBySession) {
				if (sessionId === architectSessionId) continue; // skip architect's own calls
				allEntries.push(...entries);
				totalDroppedEntries += droppedEntryCounts.get(sessionId) ?? 0;
			}

			if (allEntries.length === 0) return;

			// Clear ledger (and its dropped-count shadow) after generating summary
			for (const sessionId of ledgerBySession.keys()) {
				if (sessionId !== architectSessionId) {
					ledgerBySession.delete(sessionId);
					droppedEntryCounts.delete(sessionId);
				}
			}

			// Build the DELEGATION SUMMARY
			const toolCallCount = allEntries.length;
			const filesModified = [
				...new Set(
					allEntries
						.filter((e) => isWriteTool(e.tool) && e.file)
						.map((e) => e.file!),
				),
			];
			const filesRead = [
				...new Set(
					allEntries
						.filter((e) => isReadTool(e.tool) && e.file)
						.map((e) => e.file!),
				),
			];
			const failedCalls = allEntries.filter((e) => !e.success).length;
			const scopeViolations = allEntries.filter((e) =>
				e.tool.includes('scope'),
			).length;

			const summary = [
				`DELEGATION SUMMARY:`,
				`  Tool calls: ${toolCallCount}${failedCalls > 0 ? ` (${failedCalls} failed)` : ''}`,
				filesModified.length > 0
					? `  Files modified: ${filesModified.slice(0, 5).join(', ')}${filesModified.length > 5 ? ` (+${filesModified.length - 5} more)` : ''}`
					: null,
				filesRead.length > 0
					? `  Files read: ${filesRead.slice(0, 5).join(', ')}${filesRead.length > 5 ? ` (+${filesRead.length - 5} more)` : ''}`
					: null,
				scopeViolations > 0
					? `  ⚠️  ${scopeViolations} scope violation(s) detected`
					: null,
				// Disclosure (invariant 8): entries dropped by the per-session cap.
				totalDroppedEntries > 0
					? `  ...and ${totalDroppedEntries} earlier call(s) omitted (per-session ledger cap)`
					: null,
			]
				.filter(Boolean)
				.join('\n');

			try {
				injectAdvisory(architectSessionId, summary);
			} catch {
				/* non-blocking */
			}
		},
	};
}

// Helpers
const WRITE_TOOL_PATTERNS = [
	'write',
	'edit',
	'patch',
	'create',
	'insert',
	'replace',
	'append',
	'prepend',
];
function isWriteTool(toolName: string): boolean {
	const normalized = normalizeToolNameLowerCase(toolName);
	return WRITE_TOOL_PATTERNS.some((p) => normalized.includes(p));
}

const READ_TOOL_PATTERNS = ['read', 'cat', 'view', 'fetch', 'get'];
function isReadTool(toolName: string): boolean {
	const normalized = normalizeToolNameLowerCase(toolName);
	return READ_TOOL_PATTERNS.some((p) => normalized.includes(p));
}
