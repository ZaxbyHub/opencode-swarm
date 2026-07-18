/**
 * #1850 Linked Knowledge 5/5: handles `/swarm memory link` / `/swarm memory unlink`.
 *
 * Ties this worktree's memory store to a shared cohort root through the #1846
 * cohort identity — independently of the knowledge link (`/swarm link`).
 * Knowledge link and memory link are separate opt-in toggles (issue #1850
 * acceptance #1): linking knowledge does NOT link memory, and vice versa.
 *
 * On link:
 *  1. Resolve the canonical cohort id (same id used by knowledge link).
 *  2. Drain + close pooled providers for the local root (acceptance #5).
 *  3. Migrate the local memory family into the cohort root via
 *     `migrateMemoryFamily` (acceptance #7).
 *  4. Write `memory-cohort-config.json` under the migration lock (acceptance
 *     #10 — provider/schema/embedding/redaction fingerprint; CONCERN-2).
 *  5. Write the `memory-link.json` pointer LAST so a failure above leaves the
 *     worktree local (idempotent retry on re-link).
 *
 * On unlink:
 *  1. Migrate the cohort memory family back into local `.swarm/memory/`.
 *  2. Remove the pointer. The cohort store is NEVER deleted/truncated (other
 *     worktrees may still be linked).
 *
 * Status: `/swarm memory link status` prints the memory link state distinctly
 * from the knowledge link state (acceptance #2).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { loadPluginConfigWithMeta } from '../config';
import { MemoryConfigSchema } from '../config/schema.js';
import {
	type CohortIdentity,
	resolveCohortId,
} from '../knowledge/cohort-identity.js';
import { migrateMemoryFamily } from '../memory/memory-family-migration.js';
import {
	type MemoryLinkPointer,
	readMemoryLinkPointer,
	removeMemoryLinkPointer,
	resolveLinkDir,
	sanitizeLinkId,
	writeMemoryLinkPointer,
} from '../memory/memory-link.js';
import { evictAndCloseForRoot } from '../memory/provider-pool.js';
import {
	buildMemoryCohortFingerprintInput,
	computeMemoryCohortFingerprint,
} from '../memory/redaction.js';
import {
	type VettedMemoryRoot,
	wrapLocalRoot,
} from '../memory/storage-root.js';
import { criticalWarn } from '../utils/logger.js';

function formatStatus(directory: string): string {
	const pointer = readMemoryLinkPointer(directory);
	if (!pointer) {
		return [
			'ℹ️ Memory is NOT linked. Memory stays local to `.swarm/memory/`.',
			'Run `/swarm memory link` to share memory across worktrees of this repo.',
			'(Knowledge link and memory link are independent — `/swarm link` does not link memory.)',
		].join('\n');
	}
	const cohortDir = resolveLinkDir(pointer.linkId);
	const lines = [
		'🔗 Memory is shared across linked worktrees.',
		`  link id:   ${pointer.linkId}`,
	];
	if (pointer.cohortId) lines.push(`  cohort:    ${pointer.cohortId}`);
	if (pointer.identitySource) {
		lines.push(`  identity:  ${pointer.identitySource}`);
	}
	if (pointer.degraded) {
		lines.push(
			'  ⚠ degraded: cohort id is machine-local (not portable across machines).',
		);
	}
	lines.push(`  shared at: ${path.join(cohortDir, 'memory')}`);
	lines.push(`  since:     ${pointer.createdAt}`);
	if (pointer.generation !== undefined) {
		lines.push(`  generation: ${pointer.generation}`);
	}
	lines.push(
		'Run `/swarm memory unlink` to stop sharing (keeps a local copy).',
	);
	return lines.join('\n');
}

// #1850 (final-critic dedup): the cohort fingerprint helpers are centralized in
// src/memory/redaction.ts. The linker uses them to write the single source of
// truth; the SQLite provider and status service read it back.

export async function handleMemoryLinkCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const first = args[0];
	if (first === 'status') {
		return formatStatus(directory);
	}

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
		try {
			cohort = await resolveCohortId(directory);
		} catch {
			/* optional for explicit name */
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

	if (cohort?.degraded) {
		criticalWarn(
			`[opencode-swarm] Cohort identity for memory link is degraded (source: ${cohort.source}). ` +
				'The shared memory store will be cohesive for sibling worktrees on THIS machine, ' +
				'but it is not a portable cohort identity (no usable git remote).',
		);
	}

	const existing = readMemoryLinkPointer(directory);
	if (existing && existing.linkId === linkId) {
		return `ℹ️ Memory is already linked to "${linkId}".\n${formatStatus(directory)}`;
	}

	// Load the memory config to (a) check link.enabled and (b) compute the
	// cohort config fingerprint.
	const { config: loadedConfig } = loadPluginConfigWithMeta(directory);
	const memoryConfig = MemoryConfigSchema.parse(loadedConfig.memory ?? {});
	if (!memoryConfig.link?.enabled) {
		return [
			'❌ Memory sharing is not enabled. Set `memory.link.enabled: true` in your',
			'opencode.json config before running `/swarm memory link`.',
		].join('\n');
	}

	const cohortDir = resolveLinkDir(linkId);
	// Build the source (local) and destination (cohort) vetted roots.
	const localRoot: VettedMemoryRoot = {
		kind: 'local',
		root: path.join(directory, '.swarm'),
		directory,
	};
	const cohortRoot: VettedMemoryRoot = {
		kind: 'cohort',
		cohortRoot: path.join(cohortDir, 'memory'),
		cohortId: cohort?.cohortId ?? linkId,
		generation: (existing?.generation ?? 0) + 1,
		linkId,
		directory,
	};

	// Drain pooled providers for the local root before migration (acceptance #5).
	evictAndCloseForRoot(localRoot);

	let totalMerged = 0;
	let totalSkipped = 0;
	let familySummary = '';
	try {
		const result = await migrateMemoryFamily(cohortRoot, localRoot);
		for (const m of result.perMember) {
			totalMerged += m.merged;
			totalSkipped += m.skipped;
		}
		familySummary = result.perMember
			.filter((m) => m.merged > 0 || m.skipped > 0)
			.map((m) => `    ${m.filename}: ${m.merged} merged, ${m.skipped} kept`)
			.join('\n');
	} catch (error) {
		return `❌ Failed to migrate the memory family into the cohort store: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}

	// #1850 CONCERN-2: write the cohort config fingerprint UNDER the cohort dir
	// (the migration engine held the lock; this write happens immediately after,
	// before the pointer flips, so a concurrent linker sees the fingerprint).
	try {
		await mkdir(cohortRoot.cohortRoot, { recursive: true });
		const fingerprintInput = buildMemoryCohortFingerprintInput(memoryConfig);
		const fingerprint = computeMemoryCohortFingerprint(fingerprintInput);
		await writeFile(
			path.join(cohortRoot.cohortRoot, 'memory-cohort-config.json'),
			JSON.stringify(
				{
					fingerprint,
					config: fingerprintInput,
					updated_at: new Date().toISOString(),
				},
				null,
				2,
			),
			'utf-8',
		);
	} catch {
		/* best-effort — open-time check fails closed when absent */
	}

	// Write the pointer LAST. If this fails, the worktree stays local while the
	// local family is already in the cohort store — re-running link re-merges
	// (idempotent) and writes the pointer.
	const pointer: MemoryLinkPointer = {
		version: 2,
		linkId,
		name: displayName,
		createdAt: new Date().toISOString(),
		cohortId: cohort?.cohortId,
		identitySource: cohort?.source,
		degraded: cohort?.degraded,
		generation: (existing?.generation ?? 0) + 1,
	};
	try {
		await writeMemoryLinkPointer(directory, pointer);
	} catch (error) {
		return `❌ Failed to write memory link pointer: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}

	const relinkNote = existing
		? `\n(Re-linked from previous memory link "${existing.linkId}".)`
		: '';
	const familyNote = familySummary ? `\n${familySummary}` : '';
	return [
		`🔗 Linked this worktree's memory to shared cohort store "${linkId}".`,
		`  migrated the memory family (${totalMerged} new, ${totalSkipped} already present).`,
		`  shared at: ${cohortRoot.cohortRoot}`,
		'All worktrees linked to this id now read and write the same memory.' +
			relinkNote +
			familyNote,
	].join('\n');
}

export async function handleMemoryUnlinkCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const noCopy = args.includes('--no-copy');
	const pointer = readMemoryLinkPointer(directory);
	if (!pointer) {
		return 'ℹ️ Memory is not linked. Nothing to unlink.';
	}

	const cohortDir = resolveLinkDir(pointer.linkId);
	const localRoot: VettedMemoryRoot = wrapLocalRoot(directory);
	const cohortRoot: VettedMemoryRoot = {
		kind: 'cohort',
		cohortRoot: path.join(cohortDir, 'memory'),
		cohortId: pointer.cohortId ?? pointer.linkId,
		generation: pointer.generation ?? 0,
		linkId: pointer.linkId,
		directory,
	};

	// Drain pooled providers for both roots before migration.
	evictAndCloseForRoot(localRoot);
	evictAndCloseForRoot(cohortRoot);

	if (!noCopy) {
		try {
			await migrateMemoryFamily(localRoot, cohortRoot);
		} catch (error) {
			return `❌ Failed to copy the cohort memory family back to local storage: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
	}

	try {
		await removeMemoryLinkPointer(directory);
	} catch (error) {
		return `❌ Failed to remove memory link pointer: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}

	const copyNote = noCopy
		? 'No local copy was made (--no-copy).'
		: 'A local copy of the cohort memory family has been restored.';
	return [
		`🔓 Unlinked memory. ${copyNote}`,
		`  The shared cohort store at ${cohortRoot.cohortRoot} is NOT deleted`,
		'  (other worktrees may still be linked to it).',
	].join('\n');
}
