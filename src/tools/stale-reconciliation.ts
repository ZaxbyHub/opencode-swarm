/**
 * run_stale_reconciliation — Reconcile skills against the knowledge store.
 * Marks skills stale when their source knowledge entries are archived or deleted.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
	getArchivedKnowledgeIds,
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type { KnowledgeEntryBase } from '../hooks/knowledge-types.js';
import {
	clearSkillStale,
	parseDraftFrontmatter,
	retireOrMarkStale,
} from '../services/skill-generator.js';
import { createSwarmTool } from './create-tool.js';

export const run_stale_reconciliation: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Reconcile skills against the knowledge store. clear=false: mark skills stale when source knowledge is archived or deleted. clear=true: clear stale.marker on affected active skills (proposal files under .swarm/skills/proposals are scanned but not modified — they are drafts, not yet active skills).',
		args: {
			clear: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					'If true, clear stale markers for affected skills. If false (default), mark affected skills stale.',
				),
		},
		execute: async (args, directory): Promise<string> => {
			// Guard against invalid directory
			if (typeof directory !== 'string' || !directory) {
				return JSON.stringify({ found: 0, skills: [] }, null, 2);
			}

			// Get all archived/deleted knowledge IDs
			const archivedIds = await _internals.getArchivedKnowledgeIds(directory);
			const archivedSet = new Set(archivedIds);

			// Build set of all known knowledge IDs (to detect deleted ones)
			const allKnownIds = new Set<string>();
			const swarmPath = _internals.resolveSwarmKnowledgePath(directory);
			const hivePath = _internals.resolveHiveKnowledgePath();
			try {
				const swarmEntries =
					await _internals.readKnowledge<KnowledgeEntryBase>(swarmPath);
				for (const e of swarmEntries) allKnownIds.add(e.id);
			} catch {
				/* ignore */
			}
			try {
				const hiveEntries =
					await _internals.readKnowledge<KnowledgeEntryBase>(hivePath);
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
				if (!_internals.existsSync(dir)) continue;
				const entries = await _internals.readdir(dir, { withFileTypes: true });
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
				if (!_internals.existsSync(skillMdPath)) continue;

				const content = await _internals.readFile(skillMdPath, 'utf-8');
				const fm = _internals.parseDraftFrontmatter(content);
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
						if (_internals.existsSync(markerPath)) {
							try {
								await _internals.clearSkillStale(path);
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
							await _internals.retireOrMarkStale(directory, path, archivedSet);
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
	clearSkillStale: typeof clearSkillStale;
	retireOrMarkStale: typeof retireOrMarkStale;
	parseDraftFrontmatter: typeof parseDraftFrontmatter;
	getArchivedKnowledgeIds: typeof getArchivedKnowledgeIds;
	readKnowledge: typeof readKnowledge;
	resolveSwarmKnowledgePath: typeof resolveSwarmKnowledgePath;
	resolveHiveKnowledgePath: typeof resolveHiveKnowledgePath;
	readdir: typeof readdir;
	readFile: typeof readFile;
	existsSync: typeof existsSync;
} = {
	run_stale_reconciliation,
	clearSkillStale,
	retireOrMarkStale,
	parseDraftFrontmatter,
	getArchivedKnowledgeIds,
	readKnowledge,
	resolveSwarmKnowledgePath,
	resolveHiveKnowledgePath,
	readdir,
	readFile,
	existsSync,
};
