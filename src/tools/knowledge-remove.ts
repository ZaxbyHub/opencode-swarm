import { z } from 'zod';
import {
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
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

			return JSON.stringify({
				success: true,
				removed: 1,
				remaining,
			});
		},
	});
