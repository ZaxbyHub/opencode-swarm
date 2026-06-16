/**
 * Unactionable-knowledge hardening loop (Swarm Learning System, Change 4 /
 * Task 4.3).
 *
 * Consumes `.swarm/knowledge-unactionable.jsonl` (entries quarantined by the
 * Layer-5 actionability gate) during the skill-improver macro loop. For each
 * queued entry it attempts to produce a hardened version with predicates +
 * scope tags via the same quota-gated v3 enrichment used by the curator
 * (Task 4.2). Entries that pass Layer 5 after hardening move from quarantined
 * to the active store as candidates; entries that fail are marked
 * `retire_candidate:true` (left in the queue for human review / eventual
 * retirement). Already-marked retire candidates are never re-processed.
 *
 * Quota: every LLM attempt goes through `enrichLessonToV3`, which reserves one
 * dedicated knowledge-enrichment quota slot per call. A per-run batch cap
 * bounds worst-case cost further.
 */

import { existsSync } from 'node:fs';
import type { CuratorLLMDelegate } from '../hooks/curator.js';
import {
	type EnrichmentQuotaOptions,
	enrichLessonToV3,
} from '../hooks/knowledge-curator.js';
import {
	findNearDuplicate,
	readKnowledge,
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type {
	KnowledgeEntryBase,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import {
	resolveUnactionablePath,
	type UnactionableRecord,
	validateActionability,
} from '../hooks/knowledge-validator.js';
import { warn } from '../utils/logger.js';

/** Max queue entries processed per improver run (bounds LLM cost per run). */
export const HARDENING_BATCH_LIMIT = 5;

/** Queue record shape with the retire flag added by this loop. */
export interface HardenableRecord extends UnactionableRecord {
	retire_candidate?: boolean;
}

export interface HardeningResult {
	/** Entries promoted from the queue to the active store. */
	hardened: number;
	/** Entries newly marked retire_candidate (hardening failed). */
	retired: number;
	/** Entries left in the queue (including pre-existing retire candidates). */
	remaining: number;
}

/**
 * Run one hardening pass. Never throws; on any error the queue is left as-is
 * and zeros are reported. No-op (besides counting) when no delegate is
 * available — without an LLM there is no hardening attempt, and auto-retiring
 * without an attempt would be wrong.
 */
export async function hardenUnactionableEntries(params: {
	directory: string;
	llmDelegate?: CuratorLLMDelegate;
	quota?: EnrichmentQuotaOptions;
	batchLimit?: number;
	dedupThreshold?: number;
}): Promise<HardeningResult> {
	const result: HardeningResult = { hardened: 0, retired: 0, remaining: 0 };
	try {
		const queuePath = resolveUnactionablePath(params.directory);
		if (!existsSync(queuePath)) return result;
		const limit = params.batchLimit ?? HARDENING_BATCH_LIMIT;
		const dedupThreshold = params.dedupThreshold ?? 0.6;

		// Collect promoted entries here; they are appended to the active store
		// AFTER the queue transaction commits (avoids nested directory locks —
		// both files live in .swarm/ and transactKnowledge locks the directory).
		const promoted: SwarmKnowledgeEntry[] = [];

		// Read-process-write with a final locked reconcile is safe here: LLM calls
		// cannot run inside the lock (transactKnowledge's mutate is synchronous),
		// the queue is only appended-to by the curator, and the commit below
		// re-reads under the lock and reconciles by id.
		const queue = await readKnowledge<HardenableRecord>(queuePath);
		if (queue.length === 0) return result;

		const processedIds = new Set<string>();
		const retiredIds = new Set<string>();
		let attempts = 0;

		for (const record of queue) {
			if (attempts >= limit) break;
			if (record.retire_candidate) continue;

			// Defensive: if the record somehow became actionable (e.g. manual
			// edit), promote it without an LLM call.
			if (validateActionability(record).actionable) {
				promoted.push(toActiveEntry(record));
				processedIds.add(record.id);
				continue;
			}

			if (!params.llmDelegate) continue;
			attempts += 1;
			const fields = await enrichLessonToV3({
				directory: params.directory,
				llmDelegate: params.llmDelegate,
				lesson: record.lesson,
				category: record.category,
				tags: record.tags ?? [],
				quota: params.quota,
			});
			if (fields) {
				const hardened = { ...record, ...fields };
				if (validateActionability(hardened).actionable) {
					promoted.push(toActiveEntry(hardened));
					processedIds.add(record.id);
					continue;
				}
			}
			retiredIds.add(record.id);
		}

		// COMMIT ORDER (Phase 4 review, CRITICAL finding): append to the ACTIVE
		// store FIRST, and only drop ids from the queue AFTER the active append
		// committed. The reverse order could permanently lose an entry (dropped
		// from the queue, append fails). With this order a crash between the two
		// transactions leaves the entry in both places, which is safe: the next
		// pass re-promotes it, the active append's commit-time dedup skips the
		// duplicate, and the queue record is then dropped.
		const storedIds = new Set<string>();
		if (promoted.length > 0) {
			const knowledgePath = resolveSwarmKnowledgePath(params.directory);
			await transactKnowledge<SwarmKnowledgeEntry>(knowledgePath, (current) => {
				const trulyNew = promoted.filter(
					(e) => !findNearDuplicate(e.lesson, current, dedupThreshold),
				);
				// Dedup-as-already-present still counts as successfully promoted for
				// queue-removal purposes — the lesson IS in the active store.
				for (const e of promoted) storedIds.add(e.id);
				if (trulyNew.length === 0) return null;
				result.hardened = trulyNew.length;
				return [...current, ...trulyNew];
			});
		}

		// Now commit queue changes: drop ids whose active-store append committed
		// (or deduped as already present), flag retired ids. Ids in processedIds
		// whose append did NOT commit stay queued for the next pass.
		const droppableIds = new Set(
			[...processedIds].filter((id) => storedIds.has(id)),
		);
		if (droppableIds.size > 0 || retiredIds.size > 0) {
			await transactKnowledge<HardenableRecord>(queuePath, (current) => {
				let changed = false;
				const next: HardenableRecord[] = [];
				for (const rec of current) {
					if (droppableIds.has(rec.id)) {
						changed = true;
						continue; // promoted out of the queue
					}
					if (retiredIds.has(rec.id) && !rec.retire_candidate) {
						changed = true;
						next.push({ ...rec, retire_candidate: true });
						continue;
					}
					next.push(rec);
				}
				return changed ? next : null;
			});
		}

		result.retired = retiredIds.size;
		const after = await readKnowledge<HardenableRecord>(queuePath);
		result.remaining = after.length;
		return result;
	} catch (err) {
		warn(
			`[unactionable-hardening] pass failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return result;
	}
}

/** Convert a queue record back into an active candidate entry. */
function toActiveEntry(record: KnowledgeEntryBase): SwarmKnowledgeEntry {
	const {
		unactionable_reason: _r,
		quarantined_at: _q,
		retire_candidate: _rc,
		...base
	} = record as HardenableRecord;
	return {
		...(base as KnowledgeEntryBase),
		tier: 'swarm',
		status: 'candidate',
		updated_at: new Date().toISOString(),
	} as SwarmKnowledgeEntry;
}
