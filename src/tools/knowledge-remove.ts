import { z } from 'zod';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from '../hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
import { createSwarmTool } from './create-tool.js';

export const knowledge_remove: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Delete an outdated swarm knowledge entry by ID (swarm tier only — does not affect hive). Double-deletion is idempotent — removing a non-existent entry returns a clear message without error.',
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

			// Read all swarm entries
			const swarmPath = resolveSwarmKnowledgePath(directory);
			let entries: SwarmKnowledgeEntry[];
			try {
				entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: message,
				});
			}

			// Filter out the entry matching the given id
			const originalCount = entries.length;
			entries = entries.filter((entry) => entry.id !== id);

			// If no entry was removed (id not found): return success: false, message: 'entry not found'
			if (entries.length === originalCount) {
				return JSON.stringify({
					success: false,
					message: 'entry not found',
				});
			}

			// Rewrite the file with the filtered entries
			try {
				await rewriteKnowledge(swarmPath, entries);
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: message,
				});
			}

			return JSON.stringify({
				success: true,
				removed: 1,
				remaining: entries.length,
			});
		},
	});
