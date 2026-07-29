/**
 * Init Orphan Recovery Advisory Hook (FR-103 SC-108)
 *
 * At plugin init, `cleanupOrphanedBranches` is called to reclaim orphaned worktrees
 * and branches. Any warnings or errors (state-unreadable conditions) are written
 * to `<directory>/.swarm/advisories/init-orphan-recovery.json`.
 *
 * This hook runs in the `messagesTransform` chain (before `guardrailsHooks.messagesTransform`)
 * and surfaces those advisories to the architect on their NEXT TURN.
 *
 * Advisory file format:
 * ```json
 * {
 *   "initTimestamp": "<ISO timestamp>",
 *   "warnings": ["warning message 1", "warning message 2"],
 *   "errors": [{ "branch": "swarm-lane/sess/lane", "error": "detail" }],
 *   "reclaimed": { "removedBranches": [], "prunedWorktrees": true }
 * }
 * ```
 *
 * The file is deleted after consumption (best-effort) so repeated turns don't re-surface.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureAgentSession, swarmState } from '../state';

export interface InitOrphanAdvisory {
	initTimestamp: string;
	warnings: string[];
	errors: Array<{ branch: string; error: string }>;
	reclaimed: {
		removedBranches: string[];
		removedWorktrees: string[];
		prunedWorktrees: boolean;
	};
}

const ADVISORY_FILENAME = 'init-orphan-recovery.json';

/**
 * Creates a messagesTransform hook that surfaces init orphan recovery advisories
 * on the architect's first turn after plugin init.
 *
 * @param directory - Project root directory (for .swarm/advisories path)
 * @returns A hook object with a messagesTransform handler
 */
export function createInitOrphanRecoveryAdvisoryHook(directory: string): {
	messagesTransform: (
		input: Record<string, never>,
		output: {
			messages?: Array<{
				info: { role: string; agent?: string; sessionID?: string };
				parts: Array<{ type?: string; text?: string; [key: string]: unknown }>;
			}>;
		},
	) => Promise<void>;
} {
	/** Tracks which sessions have already consumed the advisory file */
	const consumedBySession = new Set<string>();

	/**
	 * Reads the advisory file and returns its contents, or null if absent.
	 */
	async function readAdvisoryFile(): Promise<InitOrphanAdvisory | null> {
		const advisoryPath = path.join(
			directory,
			'.swarm',
			'advisories',
			ADVISORY_FILENAME,
		);
		try {
			const content = await fs.readFile(advisoryPath, 'utf-8');
			return JSON.parse(content) as InitOrphanAdvisory;
		} catch {
			// File absent or unreadable — nothing to surface
			return null;
		}
	}

	/**
	 * Deletes the advisory file (best-effort). Called after consumption.
	 */
	async function deleteAdvisoryFile(): Promise<void> {
		const advisoryPath = path.join(
			directory,
			'.swarm',
			'advisories',
			ADVISORY_FILENAME,
		);
		try {
			await fs.unlink(advisoryPath);
		} catch {
			// Best-effort delete — file may not exist or may already be deleted
		}
	}

	/**
	 * Formats an error entry as a readable advisory string.
	 */
	function formatError(error: { branch: string; error: string }): string {
		return `ORPHAN_RECOVERY_ERROR: Could not reclaim branch "${error.branch}": ${error.error}`;
	}

	/**
	 * messagesTransform handler.
	 *
	 * Runs before guardrailsHooks.messagesTransform in the chain.
	 * On the architect's first turn, reads the advisory file (if present) and
	 * pushes formatted warnings/errors to the session's pendingAdvisoryMessages.
	 * The file is deleted after consumption so subsequent turns don't re-surface.
	 */
	async function messagesTransform(
		_input: Record<string, never>,
		output: {
			messages?: Array<{
				info: { role: string; agent?: string; sessionID?: string };
				parts: Array<{ type?: string; text?: string; [key: string]: unknown }>;
			}>;
		},
	): Promise<void> {
		const messages = output.messages;
		if (!messages || messages.length === 0) return;

		// Extract session ID from the last message (same pattern as guardrails)
		const lastMessage = messages[messages.length - 1];
		const sessionId: string | undefined = lastMessage?.info?.sessionID;
		if (!sessionId) return;

		// Check if this is the architect session
		const activeAgent = swarmState.activeAgent.get(sessionId);
		const session = swarmState.agentSessions.get(sessionId);
		const ORCHESTRATOR_NAME = 'Architect'; // Must match constants.ts but avoiding circular import
		const isArchitect = activeAgent
			? activeAgent === ORCHESTRATOR_NAME || activeAgent.endsWith('_Architect')
			: session
				? session.agentName === ORCHESTRATOR_NAME ||
					session.agentName.endsWith('_Architect')
				: false;

		if (!isArchitect) return;

		// Only process once per session
		if (consumedBySession.has(sessionId)) return;

		// Read advisory file
		const advisory = await readAdvisoryFile();
		if (!advisory) return;

		// Mark as consumed immediately to prevent re-processing
		consumedBySession.add(sessionId);

		// Best-effort delete after reading (await to ensure file is deleted before returning)
		await deleteAdvisoryFile();

		// Emptiness gate: say nothing when there is nothing to report.
		//
		// The producer writes this file unconditionally on the happy path of every
		// plugin init — `writeAdvisoryFile(directory, cleanupResult, allWarnings,
		// true, removedWorktrees)` (init-orphan-recovery.ts) passes `attempted` as a
		// literal `true`, and `writeAdvisoryFile` sets `prunedWorktrees: attempted`.
		// So on a clean repo with zero orphans the advisory carries no warnings, no
		// errors, nothing reclaimed, and `prunedWorktrees: true` — and the block
		// below still emitted a header plus "Stale worktree metadata pruned.": two
		// lines of zero information at the top of the architect's system message,
		// once per session, on every project.
		//
		// `prunedWorktrees` alone is deliberately NOT treated as reportable content.
		// It is true on every successful init, so gating on it would suppress
		// nothing. Only warnings, errors, or something actually reclaimed count.
		// AGENTS.md invariant 10: "Do not emit diagnostic noise into chat-visible
		// streams." Mirrors the in-repo reference implementation in
		// council/council-advisory.ts, which returns early when its payload would
		// be content-free.
		//
		// The consume/delete above still runs, so a stale file is cleared either
		// way — this gate changes what is SAID, never what is CLEANED UP.
		// Optional chaining throughout: `readAdvisoryFile` does a bare
		// `JSON.parse(content) as InitOrphanAdvisory` cast with no runtime
		// validation, so an older or hand-edited file can be missing these fields
		// even though the type declares them required. Reading them defensively
		// means a malformed advisory degrades to silence instead of throwing out
		// of `messagesTransform` — which would be unrecoverable, since the file
		// has already been deleted above.
		const reclaimedForGate = advisory.reclaimed;
		const hasReportableContent =
			(advisory.warnings?.length ?? 0) > 0 ||
			(advisory.errors?.length ?? 0) > 0 ||
			(reclaimedForGate?.removedBranches?.length ?? 0) > 0 ||
			(reclaimedForGate?.removedWorktrees?.length ?? 0) > 0;
		if (!hasReportableContent) return;

		// Push warnings to pendingAdvisoryMessages
		// ensureAgentSession is idempotent — gets existing or creates new
		const targetSession = ensureAgentSession(sessionId);
		targetSession.pendingAdvisoryMessages ??= [];

		// Format header
		const timestamp = advisory.initTimestamp
			? new Date(advisory.initTimestamp).toLocaleString()
			: 'unknown';
		targetSession.pendingAdvisoryMessages.push(
			`[INIT ORPHAN RECOVERY] Plugin init detected the following at ${timestamp}:`,
		);

		// Add warnings
		//
		// Every field below is read defensively for the same reason the gate above
		// is: `readAdvisoryFile` does a bare `JSON.parse(content) as
		// InitOrphanAdvisory` with NO runtime validation, so an older or
		// hand-edited file can be missing fields the type declares as required.
		// Guarding only the gate would not have been enough — an advisory that
		// PASSES the gate on one field (say `errors`) while missing another (say
		// `warnings`) would still throw here. The file is already deleted by this
		// point, so the payload would be lost with it.
		for (const warning of advisory.warnings ?? []) {
			targetSession.pendingAdvisoryMessages.push(`  WARNING: ${warning}`);
		}

		// Add errors (state-unreadable conditions)
		for (const err of advisory.errors ?? []) {
			targetSession.pendingAdvisoryMessages.push(
				`  ERROR: ${formatError(err)}`,
			);
		}

		// Add summary of what was reclaimed
		const reclaimed = advisory.reclaimed;
		if ((reclaimed?.removedBranches?.length ?? 0) > 0) {
			targetSession.pendingAdvisoryMessages.push(
				`  Reclaimed ${reclaimed.removedBranches.length} orphaned branch(es): ${reclaimed.removedBranches.join(', ')}`,
			);
		}
		if (reclaimed?.removedWorktrees && reclaimed.removedWorktrees.length > 0) {
			targetSession.pendingAdvisoryMessages.push(
				`  Reclaimed ${reclaimed.removedWorktrees.length} orphaned worktree directory(ies): ${reclaimed.removedWorktrees.join(', ')}`,
			);
		}
		if (reclaimed?.prunedWorktrees) {
			targetSession.pendingAdvisoryMessages.push(
				'  Stale worktree metadata pruned.',
			);
		}
	}

	return { messagesTransform };
}
