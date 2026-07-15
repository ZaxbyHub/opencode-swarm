import { z } from 'zod';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
import { writeArchiveTombstoneAndInvalidateSkills } from '../hooks/skill-invalidator.js';
import {
	authorizeCuration,
	type CurationAuthorizationInput,
	type CurationContext,
} from '../knowledge/curation-policy.js';
import { createSwarmTool } from './create-tool.js';

async function loadConfigForPolicy() {
	const { KnowledgeConfigSchema } = await import('../config/schema.js');
	return KnowledgeConfigSchema.parse({});
}

export const _internals = {
	transactKnowledge,
	writeArchiveTombstoneAndInvalidateSkills,
};

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

			// #1848 §2: cohort-safe authorization before destructive remove.
			// Removal is the most destructive lifecycle action; route through the
			// shared policy with cohort-wide evidence scope. Promoted entries are
			// still protected by the status guard below.
			// #1848 review F-13: the pre-authorization read must honor the tool's
			// {success:false, error} contract on I/O failure (e.g. EACCES).
			// Without this guard the throw escapes to createSwarmTool's outer
			// wrapper, which returns {failure_class, errors:[...]} with no
			// `.error` field, breaking the tool's documented error shape.
			let preEntries: SwarmKnowledgeEntry[];
			try {
				preEntries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({ success: false, error: message });
			}
			const preTarget = preEntries.find((e) => e.id === id) ?? null;
			if (preTarget) {
				const curationInput: CurationAuthorizationInput = {
					directory,
					action: 'remove',
					entryId: id,
					reason: 'hard-delete via knowledge_remove tool',
					evidenceScope: 'cohort-wide',
				};
				const curationContext: CurationContext = {
					config: await loadConfigForPolicy(),
					entry: preTarget,
				};
				const decision = await authorizeCuration(
					curationInput,
					curationContext,
				);
				if (!decision.authorized) {
					return JSON.stringify({
						success: false,
						error: `Cohort-safety policy blocked removal: ${decision.detail}`,
						basis: decision.basis,
					});
				}
			}

			// Atomically read, check status, filter, and rewrite in one locked transaction to
			// prevent concurrent appendKnowledge calls from inserting entries that
			// are silently dropped by the rewrite (CF-2 TOCTOU fix).
			let found = false;
			let remaining = 0;
			let isPromoted = false;
			try {
				await _internals.transactKnowledge<SwarmKnowledgeEntry>(
					swarmPath,
					(entries) => {
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
					},
				);
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

			// G11 (issue #1717): route through the shared invalidator. Hard-delete
			// preserves its historical no-tombstone behavior via skipTombstone;
			// the microtask still fires to retire/mark-stale derived skills.
			await _internals.writeArchiveTombstoneAndInvalidateSkills({
				directory,
				entryId: id,
				tier: 'swarm',
				actor: 'knowledge_remove',
				reason: 'hard-delete via knowledge_remove tool',
				mode: 'purge',
				skipTombstone: true,
				sourceLabel: 'knowledge-remove',
			});

			return JSON.stringify({
				success: true,
				removed: 1,
				remaining,
			});
		},
	});
