/**
 * run_stale_reconciliation — Reconcile skills against the knowledge store.
 * Marks skills stale when their source knowledge entries are archived or deleted.
 */

import { z } from 'zod';
import { existsSync } from 'node:fs';
import type { KnowledgeEntryBase } from '../hooks/knowledge-types.js';
import { createSwarmTool } from './create-tool.js';

export const run_stale_reconciliation: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Reconcile skills against the knowledge store: mark skills stale when source knowledge is archived or deleted, or clear stale markers.',
		args: {
			clear: z.boolean().optional().default(false).describe(
				'If true, clear stale markers for affected skills. If false (default), mark affected skills stale.',
			),
		},
		execute: async (args, directory): Promise<string> => {
			// Guard against invalid directory
			if (typeof directory !== 'string' || !directory) {
				return JSON.stringify({ found: 0, skills: [] }, null, 2);
			}

			const { getArchivedKnowledgeIds } = await import(
				'../hooks/knowledge-store.js'
			);
			const { retireOrMarkStale, parseDraftFrontmatter } = await import(
				'../services/skill-generator.js'
			);
			const { readdir, readFile } = await import('node:fs/promises');
			const { join } = await import('node:path');
			const {
				readKnowledge,
				resolveSwarmKnowledgePath,
				resolveHiveKnowledgePath,
			} = await import('../hooks/knowledge-store.js');

			// Get all archived/deleted knowledge IDs
			const archivedIds = await getArchivedKnowledgeIds(directory);
			const archivedSet = new Set(archivedIds);

			// Build set of all known knowledge IDs (to detect deleted ones)
			const allKnownIds = new Set<string>();
			const swarmPath = resolveSwarmKnowledgePath(directory);
			const hivePath = resolveHiveKnowledgePath();
			try {
				const swarmEntries = await readKnowledge<KnowledgeEntryBase>(swarmPath);
				for (const e of swarmEntries) allKnownIds.add(e.id);
			} catch {
				/* ignore */
			}
			try {
				const hiveEntries = await readKnowledge<KnowledgeEntryBase>(hivePath);
				for (const e of hiveEntries) allKnownIds.add(e.id);
			} catch {
				/* ignore */
			}

			// Scan all skill directories and proposal files
			const skillEntries: {
				slug: string;
				path: string;
				isProposal: boolean;
			}[] = [];
			for (const dir of [
				join(directory, '.opencode', 'skills', 'generated'),
				join(directory, '.swarm', 'skills', 'proposals'),
			]) {
				if (!existsSync(dir)) continue;
				const entries = await readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						skillEntries.push({
							slug: entry.name,
							path: join(dir, entry.name),
							isProposal: false,
						});
					} else if (entry.name.endsWith('.md')) {
						const slug = entry.name.replace(/\.md$/, '');
						skillEntries.push({
							slug,
							path: join(dir, entry.name),
							isProposal: true,
						});
					}
				}
			}

			const results: { slug: string; reason: string; action: string }[] = [];

			for (const { slug, path, isProposal } of skillEntries) {
				const skillMdPath = isProposal ? path : join(path, 'SKILL.md');
				if (!existsSync(skillMdPath)) continue;

				const content = await readFile(skillMdPath, 'utf-8');
				const fm = parseDraftFrontmatter(content);
				const sourceIds = fm?.sourceKnowledgeIds ?? [];

				if (sourceIds.length === 0) continue;

				// Check if any source is archived or deleted
				const affected = sourceIds.filter(
					(id) => archivedSet.has(id) || !allKnownIds.has(id),
				);
				if (affected.length === 0) continue;

				if (args.clear) {
					// Clear existing stale marker (only for active skills)
					if (!isProposal) {
						const markerPath = join(path, 'stale.marker');
						if (existsSync(markerPath)) {
							const { clearSkillStale } = await import(
								'../services/skill-generator.js'
							);
							try {
								await clearSkillStale(path);
								results.push({
									slug,
									reason: affected.join(', '),
									action: 'cleared',
								});
							} catch {
								/* skip skills that fail to clear */
							}
						}
					}
				} else {
					// Mark stale or retire (only for active skills)
					if (!isProposal) {
						try {
							await retireOrMarkStale(directory, path, archivedSet);
							results.push({
								slug,
								reason: affected.join(', '),
								action: 'marked_stale',
							});
						} catch {
							/* skip skills that fail to mark */
						}
					}
				}
			}

			return JSON.stringify(
				{ found: results.length, skills: results },
				null,
				2,
			);
		},
	});

export const _internals: {
	run_stale_reconciliation: typeof run_stale_reconciliation;
} = { run_stale_reconciliation };
