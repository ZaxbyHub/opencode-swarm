/**
 * #1850 Linked Knowledge 5/5: vetted memory storage-root capability.
 *
 * Problem: when cohort memory sharing is opted in, the memory provider must
 * open a database at a cohort-scoped root (under the platform data dir), not
 * the worktree's `.swarm/memory`. But accepting an arbitrary external path
 * would violate `validateSwarmPath` and `.swarm` containment (AGENTS.md
 * invariant #4, issue #1850 acceptance #3).
 *
 * Resolution: a narrow discriminated union `VettedMemoryRoot` that can only
 * represent one of two validated shapes:
 *   - `{kind:'local'}`  — the worktree's `.swarm/memory` root (today's path,
 *     still gated by `validateSwarmPath` in the provider constructors).
 *   - `{kind:'cohort'}` — a cohort root derived from the #1846 cohort
 *     identity via the sanitized linkId. Constructed only by
 *     `resolveVettedMemoryRoot` from the memory-link pointer; there is no
 *     public `openMemoryAt(arbitraryPath)` entry.
 *
 * Cohort roots live under `<dataDir>/links/<linkId>/memory/` — the SAME shared
 * store directory used by knowledge linking, namespaced under `memory/`. The
 * `validateSwarmPath` invariant is preserved by construction: cohort roots are
 * never passed through it (they are platform-data-dir paths, not `.swarm`
 * paths), and local roots continue to flow through the existing validation.
 *
 * This module is sync-only and side-effect-free (a pointer read) so it is safe
 * to call from the lazy gateway constructor on the plugin hot path.
 */

import * as path from 'node:path';
import { log, warn } from '../utils/logger.js';
import type { MemoryConfig } from './config.js';
import {
	type MemoryLinkPointer,
	readMemoryLinkPointer,
	resolveMemoryStoreDir,
} from './memory-link.js';

/**
 * The vetted root. `directory` is always the worktree's project root (so
 * providers can still derive auxiliary per-worktree paths when needed); `root`
 * is the resolved storage root (worktree `.swarm` for local, cohort dir for
 * cohort).
 */
export type VettedMemoryRoot =
	| {
			kind: 'local';
			/** Resolved worktree `.swarm` directory (parent of `storageDir`). */
			root: string;
			/** Original worktree project root (ctx.directory). */
			directory: string;
	  }
	| {
			kind: 'cohort';
			/** Cohort memory root: `<dataDir>/links/<linkId>/memory`. */
			cohortRoot: string;
			/** Canonical cohort id from #1846 (shared by all sibling worktrees). */
			cohortId: string;
			/** Monotonic link generation (bumped on link/unlink; aids revalidation). */
			generation: number;
			/** Sanitized linkId (the cohort directory segment). */
			linkId: string;
			/** Original worktree project root (ctx.directory). */
			directory: string;
	  };

/**
 * Resolve the vetted memory root for a worktree. Sync, side-effect-free.
 *
 * Decision tree:
 *  1. If `config.link?.enabled !== true` → local (today's behavior).
 *  2. Read the memory-link pointer. If absent or malformed → local.
 *  3. If the pointer resolves to a cohort store → cohort root under
 *     `<resolveMemoryStoreDir(directory)>/memory`. `resolveMemoryStoreDir`
 *     already canonicalizes via `path.resolve` and revalidates the pointer
 *     stat on cache hits (mirrors `resolveKnowledgeStoreDir` in
 *     `src/hooks/knowledge-link.ts:396`).
 *
 * The cohort memory root is `<resolveMemoryStoreDir(directory)>/memory` — a
 * `memory/` subdirectory of the shared link dir, sibling to the knowledge
 * family files. This keeps knowledge and memory in the same cohort container
 * without colliding filenames.
 */
export function resolveVettedMemoryRoot(
	directory: string,
	config: Pick<MemoryConfig, 'link'> | Partial<Pick<MemoryConfig, 'link'>>,
): VettedMemoryRoot {
	const linkEnabled = config?.link?.enabled === true;
	if (!linkEnabled) {
		// #1850 (C-001-config fix): if a cohort pointer exists but link is
		// disabled in config, warn the operator — cohort memory is unreachable
		// and new writes land in the local store, diverging from the cohort.
		const existingPointer = readMemoryLinkPointer(directory);
		if (existingPointer) {
			warn(
				`[memory-link] memory.link.enabled is false but a cohort pointer exists (linkId=${existingPointer.linkId}). Cohort memory is unreachable — run \`/swarm memory link\` or remove the pointer with \`/swarm memory unlink\`.`,
				{ directory, linkId: existingPointer.linkId },
			);
		}
		return wrapLocalRoot(directory);
	}
	const pointer = readMemoryLinkPointer(directory);
	if (!pointer) {
		// Opt-in is enabled in config but no link has been established yet.
		// Memory stays local until `/swarm memory link` writes the pointer.
		return wrapLocalRoot(directory);
	}
	const sharedDir = resolveMemoryStoreDir(directory);
	// When the pointer is present but `resolveMemoryStoreDir` returns the
	// local `.swarm` (e.g. the link dir is unavailable), fall back to local —
	// fail-open never strands memory.
	const localSwarm = path.join(directory, '.swarm');
	if (sharedDir === localSwarm) {
		return wrapLocalRoot(directory);
	}
	return {
		kind: 'cohort',
		cohortRoot: path.join(sharedDir, 'memory'),
		cohortId: pointer.cohortId ?? pointer.linkId,
		generation: pointer.generation ?? 0,
		linkId: pointer.linkId,
		directory,
	};
}

/**
 * Backward-compat shim: wraps a raw directory into a local vetted root. Emits
 * a debug log so incomplete wiring (a caller that should have resolved a vetted
 * root itself) is visible during development (critic CONCERN-5).
 */
export function wrapLocalRoot(directory: string): VettedMemoryRoot {
	log(
		'[memory] wrapping raw directory as local vetted root — cohort sharing inactive for this caller',
		{ directory },
	);
	return {
		kind: 'local',
		root: path.join(directory, '.swarm'),
		directory,
	};
}

/** Type guard for the cohort branch. */
export function isCohortRoot(
	root: VettedMemoryRoot,
): root is Extract<VettedMemoryRoot, { kind: 'cohort' }> {
	return root.kind === 'cohort';
}

/** Type guard for the local branch. */
export function isLocalRoot(
	root: VettedMemoryRoot,
): root is Extract<VettedMemoryRoot, { kind: 'local' }> {
	return root.kind === 'local';
}

/** Return the resolved storage path for a given root (no validation). */
export function rootStoragePath(root: VettedMemoryRoot): string {
	// #1850 (reviewer fix): local roots must resolve to `.swarm/memory` (where
	// the SQLite provider stores memory.db and the JSONL provider stores its
	// files), NOT bare `.swarm`. Cohort roots already include the `memory`
	// segment by construction (storage-root.ts resolveVettedMemoryRoot).
	return root.kind === 'cohort'
		? root.cohortRoot
		: path.join(root.root, 'memory');
}

export const _internals = {
	resolveVettedMemoryRoot,
	wrapLocalRoot,
};

// Re-export the pointer type so consumers don't need a second import site.
export type { MemoryLinkPointer };
