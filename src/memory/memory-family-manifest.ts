/**
 * #1850 Linked Knowledge 5/5: memory family manifest.
 *
 * One authoritative inventory of every memory artifact, classified by scope
 * and merge strategy. Drives `migrateMemoryFamily` so a new artifact cannot be
 * silently omitted from link/unlink migration (issue #1850 acceptance #7).
 *
 * Mirrors the structure of `KNOWLEDGE_FAMILY` in
 * `src/knowledge/family-manifest.ts` but is memory-specific. The two
 * manifests are deliberately separate: knowledge uses text/JSONL merge
 * strategies; memory has a binary SQLite blob whose merge strategy is
 * fundamentally different (ATTACH + INSERT OR IGNORE).
 *
 * Scope classifications:
 *  - `canonical`  — data that must be migrated to preserve cohort state.
 *  - `derived`    — rebuildable state (FTS shadow tables, vec0 index,
 *                   embedding cache). Travels inside `memory.db` for SQLite;
 *                   rebuilt on first open if missing. Not migrated separately.
 *
 * Merge strategies:
 *  - `sqlite-file-copy` — whole-DB file copy under exclusive lock; for
 *                         non-empty destinations, ATTACH + INSERT OR IGNORE
 *                         keyed by record id (critic CONCERN-6).
 *  - `append-union`     — id-keyed union of append-only JSONL (reuses the
 *                         knowledge-family pattern).
 *  - `skip`             — not migrated (derived state rebuilt on open).
 */

export type MemoryFamilyMergeStrategy =
	| 'sqlite-file-copy'
	| 'append-union'
	| 'skip';

export type MemoryFamilyScope = 'canonical' | 'derived';

export interface MemoryFamilyMember {
	filename: string;
	scope: MemoryFamilyScope;
	mergeStrategy: MemoryFamilyMergeStrategy;
	/** Human-readable note for diagnostics. */
	note?: string;
}

/**
 * The canonical memory family manifest. Adding a member here automatically
 * includes it in link + unlink migration (mirrors `KNOWLEDGE_FAMILY`).
 *
 * NOTE: for SQLite-provider cohort members, only `memory.db` is migrated as a
 * binary blob; the JSONL members are migrated ONLY when a cohort member uses
 * the `local-jsonl` provider (rare — JSONL is legacy/debug mode per schema).
 * The migration engine skips JSONL members when the source uses SQLite, and
 * vice versa, so a mixed-provider cohort fails closed with a diagnostic
 * (acceptance #10) rather than silently losing data.
 */
export const MEMORY_FAMILY: readonly MemoryFamilyMember[] = [
	{
		filename: 'memory.db',
		scope: 'canonical',
		mergeStrategy: 'sqlite-file-copy',
		note: 'SQLite memory database (records, proposals, events, recall usage, rewards, embedding config). FTS/vec indexes travel inside as derived state.',
	},
	{
		filename: 'memories.jsonl',
		scope: 'canonical',
		mergeStrategy: 'append-union',
		note: 'JSONL provider memory records (legacy/debug mode only).',
	},
	{
		filename: 'proposals.jsonl',
		scope: 'canonical',
		mergeStrategy: 'append-union',
		note: 'JSONL provider pending proposals.',
	},
	{
		filename: 'audit.jsonl',
		scope: 'canonical',
		mergeStrategy: 'append-union',
		note: 'JSONL provider audit events.',
	},
	{
		filename: 'reward-events.jsonl',
		scope: 'canonical',
		mergeStrategy: 'append-union',
		note: 'JSONL provider reward events.',
	},
	{
		filename: 'outcome-events.jsonl',
		scope: 'canonical',
		mergeStrategy: 'append-union',
		note: 'Generation-bound memory outcome events keyed by invocation id.',
	},
	{
		filename: 'consolidation-log.jsonl',
		scope: 'canonical',
		mergeStrategy: 'append-union',
		note: 'Consolidation pass idempotency log (phaseNumber-keyed).',
	},
	{
		filename: 'backups/',
		scope: 'derived',
		mergeStrategy: 'skip',
		note: 'Pre-migration source backups (rebuildable; not migrated).',
	},
	{
		filename: 'export/',
		scope: 'derived',
		mergeStrategy: 'skip',
		note: 'JSONL export artifacts (rebuildable; not migrated).',
	},
];

/** Filenames that are actually migrated (not skipped). */
export const MIGRATED_MEMORY_FILENAMES: readonly string[] =
	MEMORY_FAMILY.filter((m) => m.mergeStrategy !== 'skip').map(
		(m) => m.filename,
	);

/** Look up a member by filename. */
export function findMemoryFamilyMember(
	filename: string,
): MemoryFamilyMember | undefined {
	return MEMORY_FAMILY.find((m) => m.filename === filename);
}
