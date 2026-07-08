/**
 * Shared skill-invalidation helper for knowledge archival/removal paths.
 *
 * Issue #1717 (G11): the tombstone + retire/stale invalidation sequence was
 * inlined independently in `knowledge-archive.ts` and `knowledge-remove.ts`,
 * and was entirely absent from the curator archive recommendation path. This
 * module is the single shared entry point all three callers use so they can
 * no longer diverge.
 *
 * Contract:
 *  - Writes an audit tombstone (fire-and-forget, fail-open) unless
 *    `skipTombstone:true` (knowledge-remove hard-deletes and historically
 *    wrote no tombstone; that behavior is preserved).
 *  - Schedules a microtask that retires/marks-stale every generated skill
 *    whose source_knowledge_ids reference the archived entry.
 *  - Never throws.
 */

import * as path from 'node:path';
import {
	findSkillsBySourceKnowledgeId,
	findStaleSkillsBySourceKnowledgeId,
	retireOrMarkStale,
} from '../services/skill-generator.js';
import { warn } from '../utils/logger.js';
import {
	recordHiveKnowledgeEvent,
	recordKnowledgeEvent,
} from './knowledge-events.js';
import { getArchivedKnowledgeIds } from './knowledge-store.js';

export interface ArchiveInvalidationContext {
	directory: string;
	entryId: string;
	tier: 'swarm' | 'hive';
	actor: string;
	reason: string;
	mode: 'archive' | 'quarantine' | 'purge';
	evidence?: string;
	previousStatus?: string;
	skipTombstone?: boolean;
	sourceLabel?: string;
	/**
	 * Pre-computed archived-ID set for callers invalidating multiple entries
	 * in one batch (e.g. curator processing several archive recommendations).
	 * Skips this call's own `getArchivedKnowledgeIds` scan when provided.
	 */
	precomputedArchivedIds?: Set<string>;
}

export async function writeArchiveTombstoneAndInvalidateSkills(
	ctx: ArchiveInvalidationContext,
): Promise<void> {
	const label = ctx.sourceLabel ?? 'skill-invalidator';

	if (!ctx.skipTombstone) {
		const tombstone = {
			type: 'archived' as const,
			entry_id: ctx.entryId,
			tier: ctx.tier,
			actor: ctx.actor,
			reason: ctx.reason,
			mode: ctx.mode,
			evidence: ctx.evidence,
			previous_status: ctx.previousStatus,
		};
		if (ctx.tier === 'hive') {
			await recordHiveKnowledgeEvent(tombstone);
		} else {
			await recordKnowledgeEvent(ctx.directory, tombstone);
		}
	}

	const allArchivedIds = ctx.precomputedArchivedIds
		? new Set(ctx.precomputedArchivedIds)
		: await getArchivedKnowledgeIds(ctx.directory);
	allArchivedIds.add(ctx.entryId);

	queueMicrotask(async () => {
		try {
			const affectedSkillDirs = await findSkillsBySourceKnowledgeId(
				ctx.directory,
				ctx.entryId,
			);
			const staleSkillDirs = await findStaleSkillsBySourceKnowledgeId(
				ctx.directory,
				allArchivedIds,
			);
			const allSkillDirs = new Set([...affectedSkillDirs, ...staleSkillDirs]);
			if (allSkillDirs.size === 0) return;

			const slugSet = new Set<string>();
			let retiredCount = 0;
			let staleCount = 0;

			for (const skillDir of allSkillDirs) {
				const slug = path.basename(skillDir);
				if (slugSet.has(slug)) continue;
				slugSet.add(slug);
				const result = await retireOrMarkStale(
					ctx.directory,
					skillDir,
					allArchivedIds,
				);
				if (result.action === 'retire') retiredCount++;
				else staleCount++;
			}

			const batchEvent = {
				type: 'skill-stale-batch' as const,
				skillIds: Array.from(slugSet),
				archivedIds: Array.from(allArchivedIds),
				retiredCount,
				staleCount,
			};
			await recordKnowledgeEvent(ctx.directory, batchEvent);
		} catch (err) {
			warn(
				`[${label}] post-archive skill invalidation failed for entry '${ctx.entryId}': ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});
}

export const _internals = {
	writeArchiveTombstoneAndInvalidateSkills,
	recordKnowledgeEvent,
	recordHiveKnowledgeEvent,
	getArchivedKnowledgeIds,
	findSkillsBySourceKnowledgeId,
	findStaleSkillsBySourceKnowledgeId,
	retireOrMarkStale,
};
