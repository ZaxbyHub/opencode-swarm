import * as path from 'node:path';
import { z } from 'zod';
import { recordKnowledgeEvent } from '../hooks/knowledge-events.js';
import {
	getArchivedKnowledgeIds,
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
import {
	findSkillsBySourceKnowledgeId,
	findStaleSkillsBySourceKnowledgeId,
	retireOrMarkStale,
} from '../services/skill-generator.js';
import { warn } from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

export const knowledge_remove: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Delete an outdated swarm knowledge entry by ID (swarm tier only — does not affect hive). Promoted entries cannot be deleted. Double-deletion is idempotent — removing a non-existent entry returns a clear message without error.',
		args: {
			id: z.string().min(1).describe('UUID of the knowledge entry to remove'),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let idInput: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					idInput = obj.id;
				}
			} catch {
				// Malicious getter threw
			}

			// Validate id
			if (typeof idInput !== 'string' || idInput.length < 1) {
				return JSON.stringify({
					success: false,
					error: 'id must be a non-empty string',
				});
			}
			const id = idInput as string;

			const swarmPath = resolveSwarmKnowledgePath(directory);

			// Atomically read, check status, filter, and rewrite in one locked transaction to
			// prevent concurrent appendKnowledge calls from inserting entries that
			// are silently dropped by the rewrite (CF-2 TOCTOU fix).
			let found = false;
			let remaining = 0;
			let isPromoted = false;
			try {
				await transactKnowledge<SwarmKnowledgeEntry>(swarmPath, (entries) => {
					const entryToDelete = entries.find((entry) => entry.id === id);
					if (!entryToDelete) return null; // not found, no write

					// Guard: prevent deletion of promoted entries by default
					if (entryToDelete.status === 'promoted') {
						isPromoted = true;
						return null; // no write
					}

					const filtered = entries.filter((entry) => entry.id !== id);
					if (filtered.length === entries.length) return null; // not found, no write
					found = true;
					remaining = filtered.length;
					return filtered;
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: message,
				});
			}

			if (isPromoted) {
				return JSON.stringify({
					success: false,
					message:
						'cannot delete promoted entry — this entry has been promoted to cross-project consensus',
				});
			}

			if (!found) {
				return JSON.stringify({
					success: false,
					message: 'entry not found',
				});
			}

			// Fire-and-forget: invalidate derived skills after hard-delete.
			// The purged entry is gone — retire or mark affected skills stale
			// depending on whether all their source knowledge entries are archived.
			// Placed BEFORE the return so the microtask is queued; it executes
			// after the caller receives the response (microtask timing).
			//
			// Read the full set of already-archived IDs BEFORE queuing the
			// microtask so retireOrMarkStale can correctly determine if ALL
			// sources for a multi-source skill are archived.
			const allArchivedIds = await getArchivedKnowledgeIds(directory);
			allArchivedIds.add(id);

			queueMicrotask(async () => {
				try {
					const affectedSkillDirs = await findSkillsBySourceKnowledgeId(
						directory,
						id,
					);
					const staleSkillDirs = await findStaleSkillsBySourceKnowledgeId(
						directory,
						allArchivedIds,
					);
					const allSkillDirs = new Set([
						...affectedSkillDirs,
						...staleSkillDirs,
					]);
					if (allSkillDirs.size === 0) return;

					const slugSet = new Set<string>();
					let retiredCount = 0;
					let staleCount = 0;

					for (const skillDir of allSkillDirs) {
						const slug = path.basename(skillDir);
						if (slugSet.has(slug)) continue;
						slugSet.add(slug);
						const result = await retireOrMarkStale(
							directory,
							skillDir,
							allArchivedIds,
						);
						if (result.action === 'retire') retiredCount++;
						else staleCount++;
					}

					// Emit batch event (fire-and-forget, fail-open)
					const batchEvent = {
						type: 'skill-stale-batch' as const,
						skillIds: Array.from(slugSet),
						archivedIds: Array.from(allArchivedIds),
						retiredCount,
						staleCount,
					};
					await recordKnowledgeEvent(directory, batchEvent);
				} catch (err) {
					warn(
						`[knowledge-remove] post-purge skill invalidation failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			});

			return JSON.stringify({
				success: true,
				removed: 1,
				remaining,
			});
		},
	});
