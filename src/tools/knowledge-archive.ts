/**
 * knowledge_archive — archival-by-default removal with audit tombstones.
 *
 * Unlike knowledge_remove (which hard-deletes a swarm entry), this tool defaults
 * to a reversible status transition and always appends an immutable `archived`
 * event to `.swarm/knowledge-events.jsonl` recording the actor, reason, evidence,
 * and previous status.
 *
 * Modes:
 *  - 'archive'    (default): set status='archived' — TTL-exempt, hidden from recall.
 *  - 'quarantine':           set status='quarantined' — suspected-bad, hidden from recall.
 *  - 'purge':                hard-delete the JSONL line. Requires allow_purge:true.
 */

import { z } from 'zod';
import { recordKnowledgeEvent } from '../hooks/knowledge-events.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from '../hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
import { createSwarmTool } from './create-tool.js';

const MODES = ['archive', 'quarantine', 'purge'] as const;
type ArchiveMode = (typeof MODES)[number];

export const knowledge_archive: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			"Archive (default), quarantine, or purge a swarm knowledge entry by ID, appending an immutable audit tombstone. 'archive'/'quarantine' set the entry status reversibly and hide it from recall; 'purge' hard-deletes and requires allow_purge:true.",
		args: {
			id: z.string().min(1).describe('UUID of the knowledge entry'),
			reason: z
				.string()
				.min(1)
				.max(500)
				.describe('Why the entry is being archived/quarantined/purged'),
			evidence: z
				.string()
				.max(1000)
				.optional()
				.describe(
					'Supporting evidence (e.g. "ignored 8 times, contradicted by tests")',
				),
			mode: z.enum(MODES).optional().describe("Default 'archive'"),
			allow_purge: z
				.boolean()
				.optional()
				.describe("Admin flag required when mode='purge'"),
		},
		execute: async (args: unknown, directory, ctx): Promise<string> => {
			const a = (args ?? {}) as {
				id?: unknown;
				reason?: unknown;
				evidence?: unknown;
				mode?: unknown;
				allow_purge?: unknown;
			};

			const id = typeof a.id === 'string' ? a.id : '';
			if (!id) {
				return JSON.stringify({
					success: false,
					error: 'id must be a non-empty string',
				});
			}
			const reason = typeof a.reason === 'string' ? a.reason : '';
			if (!reason) {
				return JSON.stringify({
					success: false,
					error: 'reason is required',
				});
			}
			const evidence = typeof a.evidence === 'string' ? a.evidence : undefined;
			const mode: ArchiveMode =
				a.mode === 'quarantine' || a.mode === 'purge' ? a.mode : 'archive';

			if (mode === 'purge' && a.allow_purge !== true) {
				return JSON.stringify({
					success: false,
					error: 'purge requires allow_purge:true (admin flag)',
				});
			}

			const swarmPath = resolveSwarmKnowledgePath(directory);
			let entries: SwarmKnowledgeEntry[];
			try {
				entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
			} catch (err) {
				return JSON.stringify({
					success: false,
					error: err instanceof Error ? err.message : 'Unknown error',
				});
			}

			const target = entries.find((e) => e.id === id);
			if (!target) {
				return JSON.stringify({ success: false, message: 'entry not found' });
			}
			const previousStatus = target.status;
			const now = new Date().toISOString();

			let nextEntries: SwarmKnowledgeEntry[];
			let resultStatus: string;
			if (mode === 'purge') {
				nextEntries = entries.filter((e) => e.id !== id);
				resultStatus = 'purged';
			} else {
				const newStatus = mode === 'quarantine' ? 'quarantined' : 'archived';
				nextEntries = entries.map((e) =>
					e.id === id ? { ...e, status: newStatus, updated_at: now } : e,
				);
				resultStatus = newStatus;
			}

			try {
				await rewriteKnowledge(swarmPath, nextEntries);
			} catch (err) {
				return JSON.stringify({
					success: false,
					error: err instanceof Error ? err.message : 'Unknown error',
				});
			}

			// Append the audit tombstone. Fire-and-forget (fail-open): the status
			// change already persisted; a telemetry failure must not undo it.
			await recordKnowledgeEvent(directory, {
				type: 'archived',
				entry_id: id,
				actor: ctx?.agent ?? 'unknown',
				reason,
				mode,
				evidence,
				previous_status: previousStatus,
			});

			return JSON.stringify({
				success: true,
				id,
				mode,
				previous_status: previousStatus,
				status: resultStatus,
			});
		},
	});

export const _internals: { knowledge_archive: typeof knowledge_archive } = {
	knowledge_archive,
};
