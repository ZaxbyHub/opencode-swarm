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
 *
 * Tiers:
 *  - 'swarm' (default): archives a project-local swarm entry.
 *  - 'hive':            archives a shared hive entry (cross-project knowledge).
 */

import { z } from 'zod';
import { recordKnowledgeEvent } from '../hooks/knowledge-events.js';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type { KnowledgeEntryBase } from '../hooks/knowledge-types.js';
import { warn } from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

const MODES = ['archive', 'quarantine', 'purge'] as const;
type ArchiveMode = (typeof MODES)[number];

const TIERS = ['swarm', 'hive'] as const;
type ArchiveTier = (typeof TIERS)[number];

export const knowledge_archive: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			"Archive (default), quarantine, or purge a knowledge entry by ID (swarm or hive tier), appending an immutable audit tombstone. 'archive'/'quarantine' set the entry status reversibly and hide it from recall; 'purge' hard-deletes and requires allow_purge:true.",
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
			tier: z
				.enum(TIERS)
				.optional()
				.describe("'swarm' (default) or 'hive' — which knowledge store to archive from"),
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
				tier?: unknown;
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
			const tier: ArchiveTier = a.tier === 'hive' ? 'hive' : 'swarm';

			if (mode === 'purge' && a.allow_purge !== true) {
				return JSON.stringify({
					success: false,
					error: 'purge requires allow_purge:true (admin flag)',
				});
			}

			let filePath: string;
			if (tier === 'hive') {
				filePath = resolveHiveKnowledgePath();
			} else {
				filePath = resolveSwarmKnowledgePath(directory);
			}

			let entries: KnowledgeEntryBase[];
			try {
				entries = await readKnowledge<KnowledgeEntryBase>(filePath);
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

			let resultStatus: string;
			if (mode === 'purge') {
				// Defense-in-depth: hard-delete is irreversible. Emit a prominent
				// warning even though allow_purge:true was already required. The
				// archived event below is the audit trail.
				warn(
					`[knowledge_archive] PURGE: hard-deleting entry id=${id} tier=${tier} actor=${
						ctx?.agent ?? 'unknown'
					} reason=${reason}`,
				);
				const nextEntries = entries.filter((e) => e.id !== id);
				try {
					await rewriteKnowledge(filePath, nextEntries);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : 'Unknown error',
					});
				}
				resultStatus = 'purged';
			} else {
				const newStatus = mode === 'quarantine' ? 'quarantined' : 'archived';
				const mutate = (
					currentEntries: KnowledgeEntryBase[],
				): KnowledgeEntryBase[] | null => {
					const index = currentEntries.findIndex((e) => e.id === id);
					if (index === -1) return null;
					const updated = [...currentEntries];
					updated[index] = {
						...updated[index],
						status: newStatus,
						updated_at: now,
					};
					return updated;
				};

				try {
					await transactKnowledge(filePath, mutate);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : 'Unknown error',
					});
				}
				resultStatus = newStatus;
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
				tier,
			});

			return JSON.stringify({
				success: true,
				id,
				mode,
				tier,
				previous_status: previousStatus,
				status: resultStatus,
			});
		},
	});

export const _internals: { knowledge_archive: typeof knowledge_archive } = {
	knowledge_archive,
};
