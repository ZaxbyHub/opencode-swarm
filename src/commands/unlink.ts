/**
 * Handles the `/swarm unlink` command.
 *
 * Stops sharing this worktree's swarm knowledge with its link store and returns
 * it to a local `.swarm/knowledge.jsonl`. By default the shared knowledge
 * *family* (store, events, rejected, retractions, counters, quarantine,
 * unactionable, application-legacy) is copied back into the local store per the
 * family manifest so the worktree keeps the pooled knowledge it had access to;
 * pass `--no-copy` to skip the copy-back.
 *
 * The copy-back is transactional (issue #1846): it reads the shared family
 * under the shared-store lock and writes the local family atomically, so a
 * concurrent append in a peer worktree cannot be lost. The shared cohort is
 * never deleted or truncated.
 *
 * Usage:
 * - /swarm unlink              — unlink and copy the shared family back to local.
 * - /swarm unlink --no-copy    — unlink without copying the shared family back.
 */

import * as path from 'node:path';
import {
	readLinkPointer,
	removeLinkPointer,
	resolveLinkDir,
} from '../hooks/knowledge-link.js';
import { migrateKnowledgeFamily } from '../knowledge/family-migration.js';

export async function handleUnlinkCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const pointer = readLinkPointer(directory);
	if (!pointer) {
		return 'ℹ️ This worktree is not linked. Nothing to unlink.';
	}

	const copyBack = !args.includes('--no-copy');
	const linkDir = resolveLinkDir(pointer.linkId);

	// Copy the shared family back to local BEFORE removing the pointer, so the
	// resolver still distinguishes the two stores by explicit path and the
	// migration engine locks the right directories. The shared cohort is never
	// deleted/truncated (acceptance: must not lose data for peers).
	let totalMerged = 0;
	let totalSkipped = 0;
	let familySummary = '';
	if (copyBack) {
		try {
			const result = await migrateKnowledgeFamily(
				path.join(directory, '.swarm'),
				linkDir,
			);
			for (const m of result.perMember) {
				totalMerged += m.merged;
				totalSkipped += m.skipped;
			}
			familySummary = result.perMember
				.filter((m) => m.merged > 0 || m.skipped > 0)
				.map((m) => `    ${m.filename}: ${m.merged} copied, ${m.skipped} kept`)
				.join('\n');
		} catch (error) {
			return `❌ Failed to copy shared knowledge family back to local: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	}

	try {
		await removeLinkPointer(directory);
	} catch (error) {
		return `❌ Failed to remove link pointer: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}

	if (!copyBack) {
		return [
			`🔓 Unlinked this worktree from shared knowledge store "${pointer.linkId}".`,
			'  shared knowledge family was NOT copied back (--no-copy).',
			'This worktree now uses its local `.swarm/` knowledge again.',
		].join('\n');
	}

	const familyNote = familySummary ? `\n${familySummary}` : '';
	return [
		`🔓 Unlinked this worktree from shared knowledge store "${pointer.linkId}".`,
		`  copied the shared knowledge family back to local (${totalMerged} new, ${totalSkipped} already present).`,
		'This worktree now uses its local `.swarm/` knowledge again.',
		`The shared store is retained for any still-linked worktrees.${familyNote}`,
	].join('\n');
}
