/**
 * Handles the `/swarm link` command.
 *
 * Ties this worktree's swarm knowledge store to a shared "link" store so that
 * several swarms working on the same project (typically separate git worktrees)
 * — or on deliberately "similar" projects — pool their lessons instead of each
 * keeping an isolated `.swarm/knowledge.jsonl`.
 *
 * Usage:
 * - /swarm link                — link using the canonical cohort id (ties all
 *                                worktrees of the same repo to one shared store).
 * - /swarm link <name>         — link using an explicit shared name (use the same
 *                                name in each worktree/repo to tie them together).
 * - /swarm link status         — show the current link state for this worktree.
 *
 * On link, this worktree's existing local knowledge *family* (store, events,
 * rejected, retractions, counters, quarantine, unactionable, application-legacy)
 * is migrated into the shared store per the family manifest, with each member
 * merged according to its strategy (issue #1846). The pointer is flipped only
 * after the migration commits.
 */

import {
	type CohortIdentity,
	resolveCohortId,
} from '../knowledge/cohort-identity.js';
import { migrateKnowledgeFamily } from '../knowledge/family-migration.js';
import {
	type LinkPointer,
	readLinkPointer,
	resolveLinkDir,
	sanitizeLinkId,
	writeLinkPointer,
} from '../hooks/knowledge-link.js';
import * as path from 'node:path';
import { criticalWarn } from '../utils/logger.js';

function formatStatus(directory: string): string {
	const pointer = readLinkPointer(directory);
	if (!pointer) {
		return [
			'ℹ️ This worktree is NOT linked. Its swarm knowledge is local to `.swarm/`.',
			'Run `/swarm link` to share knowledge across worktrees of this repo,',
			'or `/swarm link <name>` to share with deliberately similar projects.',
		].join('\n');
	}
	const linkDir = resolveLinkDir(pointer.linkId);
	const lines = [
		'🔗 Linked — swarm knowledge is shared.',
		`  link id:   ${pointer.linkId}`,
	];
	if (pointer.name) lines.push(`  name:      ${pointer.name}`);
	if (pointer.cohortId) lines.push(`  cohort:    ${pointer.cohortId}`);
	if (pointer.identitySource) {
		lines.push(`  identity:  ${pointer.identitySource}`);
	}
	if (pointer.degraded) {
		lines.push(
			'  ⚠ degraded: cohort id is machine-local (not portable across machines).',
		);
	}
	lines.push(`  shared at: ${linkDir}`);
	lines.push(`  since:     ${pointer.createdAt}`);
	if (pointer.generation !== undefined) {
		lines.push(`  generation: ${pointer.generation}`);
	}
	lines.push('Run `/swarm unlink` to stop sharing (keeps a local copy).');
	return lines.join('\n');
}

export async function handleLinkCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const first = args[0];
	if (first === 'status') {
		return formatStatus(directory);
	}

	// First non-flag token (if any) is an explicit shared name.
	const nameArg = args.find((a) => !a.startsWith('--'));

	let linkId: string;
	let displayName: string | undefined;
	let cohort: CohortIdentity | undefined;
	if (nameArg) {
		const sanitized = sanitizeLinkId(nameArg);
		if (!sanitized) {
			return `❌ Invalid link name "${nameArg}". Use letters, digits, '.', '-', or '_'.`;
		}
		linkId = sanitized;
		displayName = nameArg;
		// Still resolve the canonical cohort id for diagnostics/provenance.
		try {
			cohort = await resolveCohortId(directory);
		} catch {
			/* optional — explicit name does not require a resolvable identity */
		}
	} else {
		try {
			cohort = await resolveCohortId(directory);
			linkId = cohort.cohortId;
		} catch (error) {
			return `❌ Failed to resolve cohort identity: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	}

	// Surface a visible warning when the cohort identity is degraded (machine-local,
	// not portable). The operator should know the cohort won't follow a clone of
	// this repo to another machine (issue #1846 §1.3, critic C3).
	if (cohort?.degraded) {
		criticalWarn(
			`[opencode-swarm] Cohort identity for this worktree is degraded (source: ${cohort.source}). ` +
				'The shared store will be cohesive for sibling worktrees on THIS machine, ' +
				'but it is not a portable cohort identity (no usable git remote).',
		);
	}

	const existing = readLinkPointer(directory);
	if (existing && existing.linkId === linkId) {
		return `ℹ️ Already linked to "${linkId}".\n${formatStatus(directory)}`;
	}

	const linkDir = resolveLinkDir(linkId);
	let totalMerged = 0;
	let totalSkipped = 0;
	let familySummary = '';
	try {
		const result = await migrateKnowledgeFamily(
			linkDir,
			path.join(directory, '.swarm'),
		);
		for (const m of result.perMember) {
			totalMerged += m.merged;
			totalSkipped += m.skipped;
		}
		familySummary = result.perMember
			.filter((m) => m.merged > 0 || m.skipped > 0)
			.map((m) => `    ${m.filename}: ${m.merged} merged, ${m.skipped} kept`)
			.join('\n');
	} catch (error) {
		return `❌ Failed to migrate the knowledge family into the link store: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}

	// v2 pointer carries cohort metadata (issue #1846). Bump generation so the
	// cross-process cache revalidates (resolveKnowledgeStoreDir keys off it).
	const pointer: LinkPointer = {
		version: 2,
		linkId,
		name: displayName,
		createdAt: new Date().toISOString(),
		source: 'manual',
		cohortId: cohort?.cohortId,
		identitySource: cohort?.source,
		degraded: cohort?.degraded,
		generation: (existing?.generation ?? 0) + 1,
	};
	// Ordering is deliberate: migrate BEFORE writing the pointer. The migration
	// is id-keyed and idempotent, so if writeLinkPointer fails the worktree stays
	// unlinked while the local family is safely already in the shared store —
	// re-running `/swarm link` re-merges (no-ops for already-present ids) and
	// writes the pointer. The reverse order (pointer first) would, on a migration
	// failure, leave the worktree linked to a shared store missing local family
	// data, which is worse.
	try {
		await writeLinkPointer(directory, pointer);
	} catch (error) {
		return `❌ Failed to write link pointer: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}

	const relinkNote = existing
		? `\n(Re-linked from previous link "${existing.linkId}".)`
		: '';
	const familyNote = familySummary ? `\n${familySummary}` : '';
	return [
		`🔗 Linked this worktree to shared knowledge store "${linkId}".`,
		`  migrated the complete knowledge family (${totalMerged} new, ${totalSkipped} already present).`,
		`  shared at: ${linkDir}`,
		'All swarms linked to this id now read and write the same knowledge.' +
			relinkNote +
			familyNote,
	].join('\n');
}
