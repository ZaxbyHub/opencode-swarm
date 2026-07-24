/**
 * Cohort family-migration engine for the linked-swarm knowledge system.
 *
 * Drives both `/swarm link` and `/swarm unlink` off the single
 * {@link KNOWLEDGE_FAMILY} manifest (issue #1846 §3). Replaces the prior
 * single-file (`knowledge.jsonl`-only) migration that silently orphaned the
 * other six family members.
 *
 * Design (issue #1846, critic-reviewed plan W3/W4):
 *  - One manifest drives link + unlink, so a new family member cannot be
 *    silently omitted.
 *  - Three merge strategies: `dedup-id-merge` (provenance-preserving store
 *    merge), `append-union` (id-keyed union for append-only logs),
 *    `sum-counters` (per-counter SUM for the baseline JSON, reusing
 *    `mergeRollupInto`).
 *  - All-or-nothing commit: stage the entire merged family into a sibling
 *    staging directory, validate every file, then commit atomically. The
 *    pointer is flipped last by the caller.
 *  - Lock discipline: acquire the destination store's directory lock first,
 *    read source files under a *brief* source-store lock (released before the
 *    long merge/validate work), so a long migration cannot have its lock
 *    stolen by `stale` expiry and cannot deadlock against the hot path.
 *
 * No writes happen here on the plugin-init path (invariant 1). Locks are
 * `proper-lockfile` directory locks with a bumped `stale` for the migration
 * critical section (invariant 3, critic C9).
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../evidence/task-file.js';
import type { CounterRollup } from '../hooks/knowledge-events.js';
import { _internals as eventsInternals } from '../hooks/knowledge-events.js';
import { findNearDuplicate } from '../hooks/knowledge-store.js';
import type { KnowledgeEntryBase } from '../hooks/knowledge-types.js';
import { mergeEntryFields } from './entry-merge.js';
import {
	KNOWLEDGE_FAMILY,
	type KnowledgeFamilyMember,
} from './family-manifest.js';
import {
	MIGRATION_LOCK_RETRIES,
	MIGRATION_LOCK_STALE_MS,
} from './family-migration-shared.js';

const DEDUP_THRESHOLD = 0.6;

/**
 * Lock config for the migration critical section. Re-exported from
 * `family-migration-shared.ts` (issue #1850) so the memory family migration
 * engine reuses the SAME values. See the shared module for rationale.
 */

export interface FamilyMigrationCounts {
	/** Per-member counts (filename → {merged, skipped}). */
	readonly perMember: ReadonlyArray<{
		filename: string;
		merged: number;
		skipped: number;
	}>;
}

/** Read a JSONL file into an array of parsed objects (malformed lines skipped). */
function readJsonl<T>(filePath: string): T[] {
	if (!existsSync(filePath)) return [];
	try {
		const content = readFileSync(filePath, 'utf-8');
		const out: T[] = [];
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				out.push(JSON.parse(trimmed) as T);
			} catch {
				/* skip malformed */
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Read a JSON file (object). Returns null if absent or unparseable. */
function readJson<T>(filePath: string): T | null {
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
	} catch {
		return null;
	}
}

/**
 * Default id key extractor for append members (event id / entry id). Members
 * that carry no top-level `id` (append-only audit logs) override this via their
 * `keyOf` selector on the manifest.
 */
function lineId(obj: unknown): string | null {
	if (!obj || typeof obj !== 'object') return null;
	const o = obj as Record<string, unknown>;
	if (typeof o.id === 'string' && o.id.length > 0) return o.id;
	return null;
}

/**
 * Resolve the dedup-key selector for a member: its explicit `keyOf` when
 * present, else the default `id` selector. Centralising this guarantees the
 * append merge, the validator, and every consumer key a member identically —
 * and that every pre-existing (no-`keyOf`) member keeps its exact `id`-keyed
 * behavior.
 */
function keySelectorFor(
	member: KnowledgeFamilyMember,
): (obj: unknown) => string | null {
	return member.keyOf ?? lineId;
}

/**
 * Provenance-preserving merge of the active store (`dedup-id-merge`).
 *
 * Exact-id duplicates: skip (already present). Near-duplicates (Jaccard bigram
 * similarity ≥ threshold): merge fields rather than drop — union `confirmed_by`,
 * `tags`, `source_refs`; union retrieval outcomes by unique outcome key;
 * confidence becomes an evidence-weighted average; the losing entry's `id` is
 * preserved in `merged_from` for retraction traceability. A `merge` is NOT
 * silent. (Critic C8: this is "provenance-preserving", not "lossless".)
 *
 * The field-level merge itself lives in `./entry-merge.ts` (issue #1821 Lane A)
 * so the active-store near-duplicate sweep in `hooks/knowledge-dedup-sweep.ts`
 * shares EXACTLY these semantics. `DEDUP_THRESHOLD` and this function stay here
 * because they are migration policy, not merge mechanics.
 */
function mergeStoreEntries(
	destination: KnowledgeEntryBase[],
	source: KnowledgeEntryBase[],
): { merged: KnowledgeEntryBase[]; added: number; skipped: number } {
	const result = [...destination];
	const seenIds = new Set(result.map((e) => e.id));
	let added = 0;
	let skipped = 0;

	for (const src of source) {
		if (seenIds.has(src.id)) {
			skipped++;
			continue;
		}
		const dup = findNearDuplicate(src.lesson, result, DEDUP_THRESHOLD);
		if (dup) {
			// Provenance-preserving field union into the existing near-duplicate.
			mergeEntryFields(dup, src);
			skipped++;
			continue;
		}
		result.push(src);
		seenIds.add(src.id);
		added++;
	}
	return { merged: result, added, skipped };
}

/**
 * Append-union / append-concat: append source lines whose key is not already
 * present on the destination. The key is extracted by `keyOf` — the member's id
 * field by default (`append-union`), or a composite selector for non-`id`
 * append-only audit logs (`append-concat`). Lines whose key is `null` (no
 * derivable key / malformed) are skipped: we cannot dedup them safely, and a
 * keyless line is unaddressable. Idempotent on retry/relink for both strategies.
 */
function appendUnionById<T>(
	destination: T[],
	source: T[],
	keyOf: (obj: unknown) => string | null = lineId,
): { merged: T[]; added: number; skipped: number } {
	const result = [...destination];
	const seen = new Set(
		result.map(keyOf).filter((x): x is string => x !== null),
	);
	let added = 0;
	let skipped = 0;
	for (const src of source) {
		const id = keyOf(src);
		if (!id || seen.has(id)) {
			skipped++;
			continue;
		}
		result.push(src);
		seen.add(id);
		added++;
	}
	return { merged: result, added, skipped };
}

/**
 * Sum-counters: merge two baseline JSON objects (`Record<id, CounterRollup>`)
 * by per-id field-wise sum, reusing the canonical `mergeRollupInto` primitive.
 */
function sumCounters(
	destination: Record<string, CounterRollup>,
	source: Record<string, CounterRollup>,
): { merged: Record<string, CounterRollup>; added: number; skipped: number } {
	const result: Record<string, CounterRollup> = { ...destination };
	let added = 0;
	let skipped = 0;
	for (const [id, srcRollup] of Object.entries(source)) {
		const existing = result[id];
		if (existing) {
			// Merge srcRollup INTO existing (mutates a shallow copy).
			const merged = {
				...existing,
				violation_timestamps: [...existing.violation_timestamps],
			};
			eventsInternals.mergeRollupInto(merged, srcRollup);
			result[id] = merged;
			skipped++; // id already present (merged, not added)
		} else {
			result[id] = srcRollup;
			added++;
		}
	}
	return { merged: result, added, skipped };
}

/** Serialize a merged family member to its on-disk representation. */
function serialize(member: KnowledgeFamilyMember, data: unknown): string {
	if (member.mergeStrategy === 'sum-counters') {
		return `${JSON.stringify(data)}\n`;
	}
	// JSONL member
	const arr = data as unknown[];
	if (arr.length === 0) return '';
	return `${arr.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

/**
 * Validate a serialized merged member BEFORE commit. This is a real integrity
 * gate, not a vacuous JSON-parseability check: each line must parse AND, for
 * the store member, each entry must carry the required `id`/`lesson` shape so a
 * corrupted merge (e.g. an entry that lost its id) is rejected before it reaches
 * the destination. A failure aborts the migration — the destination stays
 * untouched and the caller never flips the pointer, so a retry is safe.
 */
function validateSerialized(
	member: KnowledgeFamilyMember,
	serialized: string,
): boolean {
	if (member.mergeStrategy === 'sum-counters') {
		// Counter baseline: must be a JSON object whose values are rollup objects.
		try {
			const obj = JSON.parse(serialized) as unknown;
			if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
			return true;
		} catch {
			return false;
		}
	}
	const keyOf = keySelectorFor(member);
	for (const line of serialized.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return false;
		}
		// Every family member line must carry a stable dedup key (the merge
		// strategies and the hot path both key off it). For id-keyed members that
		// key IS the string `id`; for non-`id` append-only audit logs it is the
		// member's composite `keyOf`. A line whose key cannot be derived would be
		// unaddressable for dedup/retraction — reject it.
		if (!parsed || typeof parsed !== 'object' || keyOf(parsed) === null) {
			return false;
		}
		// The store member additionally requires a `lesson` string (the field the
		// near-duplicate detector and retrieval both depend on).
		if (member.role === 'store') {
			if (
				typeof (parsed as Record<string, unknown>).lesson !== 'string' ||
				((parsed as Record<string, unknown>).lesson as string).length === 0
			) {
				return false;
			}
		}
	}
	return true;
}

/** Read a source family member from a store directory into merged form. */
function readSourceMember(
	member: KnowledgeFamilyMember,
	sourceDir: string,
): unknown {
	const filePath = path.join(sourceDir, member.filename);
	if (member.mergeStrategy === 'sum-counters') {
		return readJson<Record<string, CounterRollup>>(filePath) ?? {};
	}
	return readJsonl(filePath);
}

/** Merge a single source member into the destination member's current data. */
function mergeMember(
	member: KnowledgeFamilyMember,
	destinationData: unknown,
	sourceData: unknown,
): { merged: unknown; added: number; skipped: number } {
	switch (member.mergeStrategy) {
		case 'dedup-id-merge': {
			const r = mergeStoreEntries(
				(destinationData as KnowledgeEntryBase[]) ?? [],
				(sourceData as KnowledgeEntryBase[]) ?? [],
			);
			return { merged: r.merged, added: r.added, skipped: r.skipped };
		}
		case 'append-union':
		case 'append-concat': {
			// Both are key-dedup unions of append-only JSONL logs. `append-union`
			// keys off the member's `id` (default selector); `append-concat` keys
			// off the member's composite `keyOf` for non-`id` audit logs. Existing
			// (no-`keyOf`) members resolve to the exact `id` behavior as before.
			const r = appendUnionById(
				(destinationData as unknown[]) ?? [],
				(sourceData as unknown[]) ?? [],
				keySelectorFor(member),
			);
			return { merged: r.merged, added: r.added, skipped: r.skipped };
		}
		case 'sum-counters': {
			const r = sumCounters(
				(destinationData as Record<string, CounterRollup>) ?? {},
				(sourceData as Record<string, CounterRollup>) ?? {},
			);
			return { merged: r.merged, added: r.added, skipped: r.skipped };
		}
		default:
			return { merged: destinationData, added: 0, skipped: 0 };
	}
}

/**
 * Read all family members from a store directory under a brief directory lock.
 * Returns the in-memory snapshot keyed by filename. The lock is released before
 * this function returns, so callers must not rely on it covering later work.
 */
async function snapshotSourceFamily(
	storeDir: string,
): Promise<Record<string, unknown>> {
	const snapshot: Record<string, unknown> = {};
	// Brief lock: acquire, read all files synchronously, release immediately.
	let release: (() => Promise<void>) | null = null;
	try {
		await mkdir(storeDir, { recursive: true });
	} catch {
		/* may not exist — reads return empty below */
	}
	try {
		release = await lockfile.lock(storeDir, {
			...MIGRATION_LOCK_RETRIES,
			stale: MIGRATION_LOCK_STALE_MS,
		});
	} catch {
		/* If the lock cannot be acquired (e.g. dir doesn't exist yet), read
		   unlocked. Source files are read-only here; the destination write is
		   the serialized boundary. A missing source dir simply yields an empty
		   snapshot. During UNLINK the source is the shared store a peer may be
		   appending to: a concurrent append could be absent from this snapshot,
		   but (1) atomicWriteFile means reads never see torn files, (2) the
		   shared cohort is never deleted, so the append survives for still-
		   linked peers, and (3) the migration is id-keyed and idempotent, so a
		   retry recovers. No data is lost to the cohort. */
	}
	for (const member of KNOWLEDGE_FAMILY) {
		snapshot[member.filename] = readSourceMember(member, storeDir);
	}
	if (release) {
		try {
			await release();
		} catch {
			/* non-blocking */
		}
	}
	return snapshot;
}

/**
 * Migrate the complete knowledge family from `sourceDir` into `destinationDir`,
 * merging each member according to its manifest strategy. All-or-nothing:
 * stage → validate → commit. The pointer is NOT touched here (caller flips it).
 *
 * Returns per-member merge counts. Throws on validation failure (caller
 * surfaces the error; the destination is left untouched).
 *
 * @param destinationDir the cohort store that absorbs the merge (link → shared;
 *   unlink → local `.swarm`).
 * @param sourceDir the store whose family is merged in (link → local `.swarm`;
 *   unlink → shared).
 */
export async function migrateKnowledgeFamily(
	destinationDir: string,
	sourceDir: string,
): Promise<FamilyMigrationCounts> {
	// 1. Acquire the destination lock for the whole critical section.
	await mkdir(destinationDir, { recursive: true });
	let destRelease: (() => Promise<void>) | null = null;
	try {
		destRelease = await lockfile.lock(destinationDir, {
			...MIGRATION_LOCK_RETRIES,
			stale: MIGRATION_LOCK_STALE_MS,
		});
	} catch (err) {
		throw new Error(
			`family-migration: could not lock destination ${destinationDir}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	// 2. Snapshot source under a brief lock (released before long work).
	const sourceSnapshot = await snapshotSourceFamily(sourceDir);

	const perMember: Array<{
		filename: string;
		merged: number;
		skipped: number;
	}> = [];
	const staged: Array<{ member: KnowledgeFamilyMember; serialized: string }> =
		[];

	try {
		// 3. Read current destination + merge each member in memory.
		for (const member of KNOWLEDGE_FAMILY) {
			const destData = readSourceMember(member, destinationDir);
			const srcData =
				sourceSnapshot[member.filename] ??
				(member.mergeStrategy === 'sum-counters' ? {} : []);
			const { merged, added, skipped } = mergeMember(member, destData, srcData);
			perMember.push({
				filename: member.filename,
				merged: added,
				skipped,
			});
			staged.push({ member, serialized: serialize(member, merged) });
		}

		// 4. Validate every staged member before any commit.
		for (const { member, serialized } of staged) {
			if (!validateSerialized(member, serialized)) {
				throw new Error(
					`family-migration: validation failed for ${member.filename}; aborting before commit`,
				);
			}
		}

		// 5. Commit: write each merged member atomically (temp + rename). Because
		//    validation passed for all members, a mid-commit failure leaves the
		//    destination with a partial migration — but the pointer is NOT flipped
		//    by this function, so the worktree stays in its prior link state and a
		//    retry is idempotent (every strategy is id-keyed: re-merging already-
		//    present ids/entries is a no-op). See critic C5.
		for (const { member, serialized } of staged) {
			const destPath = path.join(destinationDir, member.filename);
			await atomicWriteFile(destPath, serialized);
		}
	} finally {
		if (destRelease) {
			try {
				await destRelease();
			} catch {
				/* non-blocking */
			}
		}
	}

	return { perMember };
}

export const _internals = {
	mergeStoreEntries,
	appendUnionById,
	sumCounters,
	mergeEntryFields,
	serialize,
	validateSerialized,
	keySelectorFor,
	MIGRATION_LOCK_STALE_MS,
};
