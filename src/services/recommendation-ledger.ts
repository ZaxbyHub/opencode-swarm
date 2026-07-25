/**
 * Cross-producer recommendation dedup ledger (issue #1821, AC21).
 *
 * Three mechanisms propose learning recommendations: the curator sweep
 * (`src/hooks/curator.ts`), the skill improver's macro-reflector
 * (`src/services/trajectory-cluster.ts`), and the consensus miner
 * (`src/consensus/miner.ts`). `src/learning/fingerprint.ts` gave them a shared
 * identity function, but a fingerprint alone dedups nothing: somebody has to
 * remember what was already emitted. This module is that memory.
 *
 * ## Why a second key
 *
 * `computeRecommendationFingerprint` deliberately folds `kind` into the digest —
 * its own doc says "dedup across mechanisms is a policy decision made by the
 * caller, not baked into the identity". This module *is* that caller, and the
 * policy it implements is: **two recommendations are the same recommendation
 * when they say the same thing about the same scope, regardless of which
 * mechanism noticed it first.** So every ledger entry carries two ids:
 *
 * - `fingerprint` — the producer-scoped `lrec_…` id, kept verbatim for audit.
 * - `crossKey` — an `lxk_…` id over `{ normalizedStatement, sortedScopeKeys }`.
 *
 * `crossKey` drops both `kind` and `target`. Dropping `kind` is the whole point.
 * Dropping `target` is a redundancy call, not a necessity: each producer already
 * interpolates its target into the statement it emits (the miner's `intent`
 * names its `proposedTarget`; the improver's statement names the tool and
 * failure kind its slug is built from; the curator's `entry_id` travels in
 * `scopeKeys`), so keeping `target` would add no discriminating power while
 * splitting identity on producer-local vocabulary.
 *
 * Disambiguation that genuinely must survive therefore travels in `scopeKeys`,
 * which is order- and duplicate-insensitive (`normalizeScopeKeys`). The curator
 * uses that to keep `archive entry-X` and `rewrite entry-X` distinct even when
 * both carry the same lesson text; recommendations that mint *new* knowledge
 * carry no scope keys, because content alone is their identity.
 *
 * ## What this does and does not achieve today
 *
 * The key is an EXACT hash of normalized text. Two producers dedup against each
 * other only when they emit the same sentence. In the current codebase the
 * improver and the miner build their statements from fixed templates
 * (`Avoid the recurring … failure in …`, `Investigate the smallest … change …`)
 * while the curator's statement is a free-form LLM lesson, so a cross-producer
 * collision is possible but uncommon. The concrete, everyday win is therefore:
 * (a) WITHIN-producer dedup, which the curator and the improver had none of, and
 * (b) one shared, provenance-stamped record of every emitted recommendation that
 * any producer can consult. Making cross-producer suppression routine would need
 * near-duplicate matching (see `findNearDuplicate` / the knowledge dedup sweep)
 * rather than an exact fingerprint, which is a different mechanism than the one
 * `src/learning/fingerprint.ts` defines.
 *
 * ## Check, emit, then record — never "reserve"
 *
 * The two phases are deliberately separate:
 *
 * - `checkRecommendations` is read-only. It answers "has this been emitted
 *   before?" and writes nothing.
 * - `recordEmittedRecommendations` is the locked write, and callers run it only
 *   for recommendations that **actually took effect**.
 *
 * An earlier design claimed the key up-front, before the caller emitted. That is
 * wrong here: the curator legitimately *defers* recommendations (cohort-safe
 * authorization not yet granted, target entry temporarily inactive, CAS revision
 * drift, fair-scan generation already curated, actionability quarantine pending
 * the hardening loop). Every one of those paths expects a later sweep to retry,
 * and a key claimed before the emit would suppress that retry permanently.
 * Recording after the fact costs a small race — two producers can both pass
 * `check` and both emit — whose worst case is one duplicate, exactly the
 * pre-#1821 behaviour. A burned key, by contrast, loses a lesson forever. The
 * record step re-checks under the lock, so the ledger itself never grows a
 * duplicate.
 *
 * ## Boundedness and containment
 *
 * The ledger is a JSONL file at `.swarm/learning/recommendation-ledger.jsonl`,
 * hard-capped at `MAX_RECOMMENDATION_LEDGER_ENTRIES` entries with oldest-first
 * FIFO eviction, and every entry is capped at `MAX_ENTRY_BYTES` (provenance is
 * dropped rather than allowed to blow the bound), so the file has a hard ceiling
 * of roughly 2 MB (AGENTS.md invariant 8). It never touches `process.cwd()`
 * (invariant 4). Its own subdirectory is deliberate: `transactFile` locks the
 * *containing directory*, so living under `learning/` keeps this lock disjoint
 * from the `.swarm/` root lock that `transactKnowledge` takes.
 *
 * The root is `resolveKnowledgeStoreDir`, NOT a hardcoded `<directory>/.swarm`.
 * That is the same link-aware resolution `resolveSwarmKnowledgePath` uses, so in
 * a linked cohort the ledger lives beside the knowledge store it guards instead
 * of being stranded per-worktree — a lane worktree would otherwise discard its
 * ledger while the lessons it recorded persisted in the shared store.
 *
 * Eviction means a recommendation older than the last 500 emissions can surface
 * again. That is the intended trade: bounded state beats perfect recall. Note
 * this cap is independent of `knowledge.swarm_max_entries` (default 100): a
 * lesson the knowledge store has already FIFO-evicted can still be suppressed
 * here until its own entry ages out.
 *
 * ## Fail-open
 *
 * Every failure mode — unreadable ledger, lock timeout, corrupt lines, a
 * provenance record the schema rejects — resolves to "emit everything", i.e.
 * exactly the behaviour that existed before this module. A broken dedup ledger
 * must never silence the learning loops.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalHash } from '../evaluation/hashing.js';
import { atomicWriteFile } from '../evidence/task-file.js';
import { resolveKnowledgeStoreDir } from '../hooks/knowledge-link.js';
import { transactFile } from '../hooks/knowledge-store.js';
import {
	computeRecommendationFingerprint,
	isRecommendationFingerprint,
	normalizeRecommendationStatement,
	normalizeScopeKeys,
	type RecommendationKind,
} from '../learning/fingerprint.js';
import {
	type LearningProvenanceInput,
	type LearningProvenanceV1,
	type LearningWriteOriginInput,
	stampLearningProvenance,
} from '../learning/provenance.js';
import { warn } from '../utils/logger.js';

/**
 * Hard cap on retained ledger entries (AGENTS.md invariant 8). Sized to match
 * `INSIGHT_CANDIDATES_MAX_ENTRIES` in `src/hooks/micro-reflector.ts`, the
 * closest sibling queue: the same order of magnitude of learning artifacts flows
 * through both, and one shared number is easier to reason about than two.
 */
export const MAX_RECOMMENDATION_LEDGER_ENTRIES = 500;

/**
 * Hard cap on one serialized entry. Provenance reference lists are individually
 * bounded by `stampLearningProvenance`, but 5 classes x 50 refs x 512 chars is
 * still ~128 KB, which would put the file's ceiling in the tens of megabytes.
 * An entry over this budget keeps its identity fields and drops provenance —
 * dedup is the contract, provenance is the bonus.
 */
export const MAX_ENTRY_BYTES = 4096;

/** Path of the ledger relative to the resolved knowledge-store directory. */
const LEDGER_REL_PATH = path.join('learning', 'recommendation-ledger.jsonl');

/** Cross-producer key prefix — the `lrec_` namespace's kind-agnostic sibling. */
const CROSS_KEY_PREFIX = 'lxk_';

/** Hex characters retained from the digest. 16 hex chars = 64 bits. */
const CROSS_KEY_HEX_LENGTH = 16;

/** Upper bound on the stored `target`, so one entry cannot grow unbounded. */
const MAX_TARGET_CHARS = 256;

/** Longest provenance reference accepted. Mirrors `ReferenceSchema`'s bound. */
const MAX_REF_CHARS = 512;

/** References retained per provenance class before stamping. */
const MAX_REFS_PER_CLASS_INPUT = 20;

/** A recommendation a producer is about to emit, or has just emitted. */
export interface RecommendationCandidate {
	/** Producing mechanism. Recorded on the entry; excluded from `crossKey`. */
	kind: RecommendationKind;
	/** Producer-local target (knowledge id, proposal slug, subsystem name). */
	target: string;
	/** The recommendation body. Normalized before hashing. */
	statement: string;
	/** Scope disambiguators. Order- and duplicate-insensitive. */
	scopeKeys?: string[];
	/** Learning provenance stamped onto the ledger entry when recorded. */
	provenance?: LearningProvenanceInput;
	/** Write origin for the provenance stamp. */
	origin?: LearningWriteOriginInput;
}

/** The two ids a candidate resolves to. */
export interface RecommendationIdentity {
	/** Producer-scoped `lrec_…` id from `src/learning/fingerprint.ts`. */
	fingerprint: string;
	/** Kind- and target-independent `lxk_…` id used for dedup. */
	crossKey: string;
}

/** One durable record of an emitted recommendation. */
export interface RecommendationLedgerEntry extends RecommendationIdentity {
	v: 1;
	kind: RecommendationKind;
	target: string;
	/** ISO-8601 timestamp of the record call that appended this entry. */
	emittedAt: string;
	provenance?: LearningProvenanceV1;
}

/** Why a candidate was not accepted for emission. */
export type RecommendationSuppressionSource = 'ledger' | 'batch';

/** Per-candidate outcome, in input order. */
export interface RecommendationDecision extends RecommendationIdentity {
	/** Index into the candidate array this decision belongs to. */
	index: number;
	/** True when the caller should emit this recommendation. */
	emit: boolean;
	/**
	 * `'ledger'` — a previous emission (possibly by another producer) already
	 * claimed this `crossKey`. `'batch'` — an earlier candidate in this same call
	 * claimed it. Absent when `emit` is true.
	 */
	suppressedBy?: RecommendationSuppressionSource;
}

export interface CheckRecommendationsResult {
	decisions: RecommendationDecision[];
	/** Count of `emit === true` decisions. */
	accepted: number;
	/** Count of `emit === false` decisions. */
	suppressed: number;
	/**
	 * True when the ledger could not be read and every candidate was accepted by
	 * fail-open default rather than by an actual dedup check.
	 */
	degraded: boolean;
}

export interface RecordRecommendationsResult {
	/** Entries actually appended. */
	recorded: number;
	/** Candidates skipped because the ledger already carried their cross key. */
	suppressed: number;
	/** Entries dropped by the FIFO cap during this record. */
	evicted: number;
	/** True when the ledger could not be written. */
	degraded: boolean;
}

/**
 * Absolute path of the ledger, link-aware.
 *
 * Byte-identical to `<directory>/.swarm/learning/recommendation-ledger.jsonl`
 * for an unlinked worktree; redirects to the shared cohort store when
 * `.swarm/link.json` is active, exactly as `resolveSwarmKnowledgePath` does for
 * the knowledge file this ledger shadows.
 */
export function resolveRecommendationLedgerPath(directory: string): string {
	return path.join(resolveKnowledgeStoreDir(directory), LEDGER_REL_PATH);
}

/** Shape check for a value that claims to be a cross-producer key. */
export function isRecommendationCrossKey(value: string): boolean {
	return /^lxk_[a-f0-9]{16}$/.test(value);
}

/**
 * Compute the kind- and target-independent dedup key.
 *
 * Built from the same normalizers the `lrec_` fingerprint uses, so whitespace
 * runs, surrounding space, letter case, trailing sentence punctuation, scope-key
 * order, and scope-key duplicates all collapse to one identity.
 */
export function computeCrossProducerKey(input: {
	statement: string;
	scopeKeys?: string[];
}): string {
	const digest = canonicalHash({
		normalizedStatement: normalizeRecommendationStatement(input.statement),
		sortedScopeKeys: normalizeScopeKeys(input.scopeKeys),
	});
	return `${CROSS_KEY_PREFIX}${digest.slice(0, CROSS_KEY_HEX_LENGTH)}`;
}

/** Compute both ids for a candidate. Pure. */
export function computeRecommendationIdentity(
	candidate: RecommendationCandidate,
): RecommendationIdentity {
	return {
		fingerprint: computeRecommendationFingerprint({
			kind: candidate.kind,
			target: candidate.target,
			statement: candidate.statement,
			...(candidate.scopeKeys ? { scopeKeys: candidate.scopeKeys } : {}),
		}),
		crossKey: computeCrossProducerKey({
			statement: candidate.statement,
			...(candidate.scopeKeys ? { scopeKeys: candidate.scopeKeys } : {}),
		}),
	};
}

/**
 * A statement that normalizes to nothing carries no identity: every blank-lesson
 * recommendation from every producer would otherwise collapse onto one universal
 * key and the first one would suppress all the rest. Such candidates are always
 * emitted and never recorded.
 */
function hasIdentity(candidate: RecommendationCandidate): boolean {
	return normalizeRecommendationStatement(candidate.statement).length > 0;
}

/** Structural check for a parsed ledger line. Rejects anything unusable. */
function isLedgerEntry(value: unknown): value is RecommendationLedgerEntry {
	if (typeof value !== 'object' || value === null) return false;
	const entry = value as Partial<RecommendationLedgerEntry>;
	// Both identity fields get a SHAPE check, not just a typeof. The crossKey
	// half was already validated; the fingerprint half was not, so a corrupt
	// `fingerprint` survived and could be written back out as if it were a real
	// `lrec_` id. Symmetric validation also gives
	// `isRecommendationFingerprint` its production caller (#1821 review).
	return (
		typeof entry.fingerprint === 'string' &&
		isRecommendationFingerprint(entry.fingerprint) &&
		typeof entry.crossKey === 'string' &&
		isRecommendationCrossKey(entry.crossKey)
	);
}

/** Parse JSONL, skipping blank and corrupt lines. Never throws. */
function parseLedgerJsonl(content: string): RecommendationLedgerEntry[] {
	const entries: RecommendationLedgerEntry[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isLedgerEntry(parsed)) entries.push(parsed);
		} catch {
			// Corrupt line — a partially-flushed write or manual edit. Skipping is
			// strictly better than failing the whole operation.
		}
	}
	return entries;
}

/**
 * Read the ledger from disk under the transaction lock.
 *
 * A missing file is the first-write case and yields `[]`. Any OTHER read error
 * is rethrown: returning `[]` would let the write-back half of `transactFile`
 * clobber an existing ledger with only the new entries (silent data loss). This
 * mirrors the comment on `appendInsightCandidates` in `micro-reflector.ts`.
 */
async function readLedgerForTransaction(
	filePath: string,
): Promise<RecommendationLedgerEntry[]> {
	try {
		return parseLedgerJsonl(await readFile(filePath, 'utf-8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
		throw err;
	}
}

/**
 * Read every retained ledger entry, propagating a real read failure.
 *
 * A missing ledger is the first-run case and yields `[]`; anything else throws
 * so `checkRecommendations` can report `degraded` truthfully instead of treating
 * an unreadable ledger as an empty one and silently claiming it deduped.
 */
async function readLedgerStrict(
	directory: string,
): Promise<RecommendationLedgerEntry[]> {
	const filePath = _internals.resolveRecommendationLedgerPath(directory);
	try {
		return parseLedgerJsonl(await readFile(filePath, 'utf-8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
		throw err;
	}
}

/**
 * Read every retained ledger entry. Fail-open: returns `[]` when the ledger is
 * absent or unreadable. This is the inspection entry point — the dedup decision
 * itself goes through `readLedgerStrict` so a failure is visible rather than
 * disguised as an empty ledger.
 */
export async function readRecommendationLedger(
	directory: string,
): Promise<RecommendationLedgerEntry[]> {
	try {
		return await _internals.readLedgerStrict(directory);
	} catch (err) {
		warn(
			`[recommendation-ledger] read failed (fail-open): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return [];
	}
}

/** Serialize entries back to JSONL. Empty input yields an empty file. */
function serializeLedger(entries: RecommendationLedgerEntry[]): string {
	if (entries.length === 0) return '';
	return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/**
 * Trim, drop empty / NUL-bearing / over-long refs, DEDUPLICATE, and only then
 * cap — the same truncate → dedupe → cap order `dedupeCapped`
 * (`src/hooks/knowledge-store.ts`) enforces, and for the same reason.
 *
 * The cap runs before `stampLearningProvenance` sees the list because its Zod
 * schema rejects an over-long ref by throwing, and that throw would otherwise
 * take the whole batch's dedup down with it.
 *
 * DEDUP MUST PRECEDE THE CAP (issue #1821 F2). `stampLearningProvenance`
 * dedupes too, but only *after* this function has already cut the list, so a
 * positional cap here is truncate-then-dedupe: a run of duplicates evicts every
 * distinct ref behind it. That is not theoretical — the miner emits
 * `[...tally.evidenceRefs].sort()` (`src/consensus/miner.ts`), so duplicates
 * arrive adjacent and first, and 25 refs carrying 6 distinct values persisted
 * exactly ONE with 49 of the schema's 50 slots free.
 *
 * `dedupeCapped` is deliberately NOT reused: it dedupes on a case-INSENSITIVE
 * key and TRUNCATES over-long items, both wrong for opaque provenance
 * references (`run-A` and `run-a` are different runs; a 600-char ref is
 * malformed, not shortenable). Only its ordering is mirrored.
 *
 * Dedup preserves input order, so the early exit at the top of the loop is
 * identical to filter → dedupe → `slice(0, MAX_REFS_PER_CLASS_INPUT)`.
 */
function sanitizeRefs(refs: string[] | undefined): string[] | undefined {
	if (refs === undefined) return undefined;
	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const ref of refs) {
		if (cleaned.length >= MAX_REFS_PER_CLASS_INPUT) break;
		const trimmed = ref.trim();
		if (trimmed.length === 0 || trimmed.length > MAX_REF_CHARS) continue;
		if (trimmed.includes('\0')) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		cleaned.push(trimmed);
	}
	return cleaned;
}

/**
 * Stamp provenance for one candidate. Returns `undefined` when the candidate
 * carries none, or when the schema rejects it — a single malformed provenance
 * must cost that entry its provenance, never the batch its dedup.
 */
function stampCandidateProvenance(
	candidate: RecommendationCandidate,
	emittedAt: string,
): LearningProvenanceV1 | undefined {
	const input = candidate.provenance;
	if (!input) return undefined;
	try {
		return stampLearningProvenance(
			{
				mechanism: input.mechanism,
				sourceKnowledgeIds: sanitizeRefs(input.sourceKnowledgeIds),
				sourceTaskIds: sanitizeRefs(input.sourceTaskIds),
				sourceEvidenceRefs: sanitizeRefs(input.sourceEvidenceRefs),
				sourceRunIds: sanitizeRefs(input.sourceRunIds),
				sourceModelIds: sanitizeRefs(input.sourceModelIds),
			},
			{
				...candidate.origin,
				producedAt: candidate.origin?.producedAt ?? emittedAt,
			},
		);
	} catch (err) {
		warn(
			`[recommendation-ledger] provenance stamp rejected (entry recorded without it): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return undefined;
	}
}

/** Build the durable entry, dropping provenance if the entry blows its budget. */
function buildLedgerEntry(
	candidate: RecommendationCandidate,
	identity: RecommendationIdentity,
	emittedAt: string,
): RecommendationLedgerEntry {
	const base: RecommendationLedgerEntry = {
		v: 1,
		...identity,
		kind: candidate.kind,
		target: candidate.target.slice(0, MAX_TARGET_CHARS),
		emittedAt,
	};
	const provenance = stampCandidateProvenance(candidate, emittedAt);
	if (provenance === undefined) return base;
	const withProvenance: RecommendationLedgerEntry = { ...base, provenance };
	// Byte length, not code units: a ledger of multi-byte statements would blow a
	// `.length`-based bound by up to 4x and the documented ~2 MB ceiling with it.
	return Buffer.byteLength(JSON.stringify(withProvenance), 'utf8') >
		MAX_ENTRY_BYTES
		? base
		: withProvenance;
}

/**
 * Answer "has this been emitted before?" without writing anything.
 *
 * Suppression is decided against the ledger's existing cross keys plus the keys
 * claimed by earlier candidates in this same batch. Fail-open: an unreadable
 * ledger yields `degraded: true` and accepts everything.
 */
export async function checkRecommendations(
	directory: string,
	candidates: readonly RecommendationCandidate[],
): Promise<CheckRecommendationsResult> {
	if (candidates.length === 0) {
		return { decisions: [], accepted: 0, suppressed: 0, degraded: false };
	}

	let ledgerKeys = new Set<string>();
	let degraded = false;
	try {
		const entries = await _internals.readLedgerStrict(directory);
		ledgerKeys = new Set(entries.map((entry) => entry.crossKey));
	} catch (err) {
		warn(
			`[recommendation-ledger] check failed (fail-open, emitting everything): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		degraded = true;
	}

	// The identity loop is inside the same fail-open envelope as the read: a
	// caller that hands in a malformed candidate must lose dedup, never its whole
	// sweep. The curator calls this before any knowledge mutation, so a throw here
	// would drop every recommendation in the batch.
	const batchKeys = new Set<string>();
	const decisions: RecommendationDecision[] = [];
	try {
		for (const [index, candidate] of candidates.entries()) {
			const identity = computeRecommendationIdentity(candidate);
			if (degraded || !hasIdentity(candidate)) {
				decisions.push({ index, ...identity, emit: true });
				continue;
			}
			if (ledgerKeys.has(identity.crossKey)) {
				decisions.push({
					index,
					...identity,
					emit: false,
					suppressedBy: 'ledger',
				});
				continue;
			}
			if (batchKeys.has(identity.crossKey)) {
				decisions.push({
					index,
					...identity,
					emit: false,
					suppressedBy: 'batch',
				});
				continue;
			}
			batchKeys.add(identity.crossKey);
			decisions.push({ index, ...identity, emit: true });
		}
	} catch (err) {
		warn(
			`[recommendation-ledger] identity computation failed (fail-open, emitting everything): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return {
			decisions: candidates.map((_candidate, index) => ({
				index,
				fingerprint: '',
				crossKey: '',
				emit: true,
			})),
			accepted: candidates.length,
			suppressed: 0,
			degraded: true,
		};
	}

	const accepted = decisions.filter((decision) => decision.emit).length;
	return {
		decisions,
		accepted,
		suppressed: decisions.length - accepted,
		degraded,
	};
}

/**
 * Append the recommendations a producer actually emitted.
 *
 * Runs one locked read-modify-write and re-checks every cross key under that
 * lock, so a candidate another producer recorded between `checkRecommendations`
 * and here is counted as `suppressed` rather than duplicated into the ledger.
 * Candidates whose statement normalizes to nothing are never recorded.
 */
export async function recordEmittedRecommendations(
	directory: string,
	candidates: readonly RecommendationCandidate[],
	options: { producedAt?: string } = {},
): Promise<RecordRecommendationsResult> {
	// Candidates with no identity are never recorded, so a batch made entirely of
	// them is a genuine no-op rather than a failure. Returning early keeps the
	// `!wrote` disambiguation below from mistaking that for a broken transaction.
	if (!candidates.some(hasIdentity)) {
		return { recorded: 0, suppressed: 0, evicted: 0, degraded: false };
	}

	const emittedAt = options.producedAt ?? _internals.now().toISOString();
	let recorded = 0;
	let suppressed = 0;
	let evicted = 0;

	try {
		const filePath = _internals.resolveRecommendationLedgerPath(directory);
		const wrote = await _internals.transactFile<RecommendationLedgerEntry[]>(
			filePath,
			readLedgerForTransaction,
			async (target, data) => {
				await atomicWriteFile(target, serializeLedger(data));
			},
			(existing) => {
				const seen = new Set(existing.map((entry) => entry.crossKey));
				const additions: RecommendationLedgerEntry[] = [];
				recorded = 0;
				suppressed = 0;
				evicted = 0;

				for (const candidate of candidates) {
					if (!hasIdentity(candidate)) continue;
					const identity = computeRecommendationIdentity(candidate);
					if (seen.has(identity.crossKey)) {
						suppressed += 1;
						continue;
					}
					seen.add(identity.crossKey);
					additions.push(buildLedgerEntry(candidate, identity, emittedAt));
				}

				recorded = additions.length;
				if (additions.length === 0) return null;

				const merged = [...existing, ...additions];
				if (merged.length <= MAX_RECOMMENDATION_LEDGER_ENTRIES) return merged;
				evicted = merged.length - MAX_RECOMMENDATION_LEDGER_ENTRIES;
				return merged.slice(-MAX_RECOMMENDATION_LEDGER_ENTRIES);
			},
		);

		// `transactFile` returns false without ever running `mutate` when its own
		// mkdir fails. Nothing was appended and nothing was compared, so report
		// degraded rather than a truthful-looking zero.
		if (!wrote && recorded === 0 && suppressed === 0) {
			return { recorded: 0, suppressed: 0, evicted: 0, degraded: true };
		}
		return { recorded, suppressed, evicted, degraded: false };
	} catch (err) {
		warn(
			`[recommendation-ledger] record failed (fail-open): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return { recorded: 0, suppressed: 0, evicted: 0, degraded: true };
	}
}

/**
 * DI seam (AGENTS.md invariant 7). `now` lets tests pin `emittedAt`;
 * `transactFile`, `readRecommendationLedger`, and
 * `resolveRecommendationLedgerPath` let them exercise the fail-open paths
 * without `mock.module`. Restore each entry in `afterEach`.
 */
export const _internals: {
	now: () => Date;
	transactFile: typeof transactFile;
	readLedgerStrict: typeof readLedgerStrict;
	resolveRecommendationLedgerPath: typeof resolveRecommendationLedgerPath;
} = {
	now: () => new Date(),
	transactFile,
	readLedgerStrict,
	resolveRecommendationLedgerPath,
};
