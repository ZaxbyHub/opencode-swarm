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
		for (const warning of advisory.warnings) {
			targetSession.pendingAdvisoryMessages.push(`  WARNING: ${warning}`);
		}

		// Add errors (state-unreadable conditions)
		for (const err of advisory.errors) {
			targetSession.pendingAdvisoryMessages.push(
				`  ERROR: ${formatError(err)}`,
			);
		}

		// Add summary of what was reclaimed
		const reclaimed = advisory.reclaimed;
		if (reclaimed.removedBranches.length > 0) {
			targetSession.pendingAdvisoryMessages.push(
				`  Reclaimed ${reclaimed.removedBranches.length} orphaned branch(es): ${reclaimed.removedBranches.join(', ')}`,
			);
		}
		if (reclaimed.removedWorktrees && reclaimed.removedWorktrees.length > 0) {
			targetSession.pendingAdvisoryMessages.push(
				`  Reclaimed ${reclaimed.removedWorktrees.length} orphaned worktree directory(ies): ${reclaimed.removedWorktrees.join(', ')}`,
			);
		}
		if (reclaimed.prunedWorktrees) {
			targetSession.pendingAdvisoryMessages.push(
				'  Stale worktree metadata pruned.',
			);
		}
	}

	return { messagesTransform };
}
