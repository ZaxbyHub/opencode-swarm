/**
 * Authoritative knowledge-family manifest for the linked-swarm knowledge system.
 *
 * Problem (issue #1846): `link`/`unlink` previously hardcoded a *single* family
 * member (`knowledge.jsonl`) while the link-aware resolvers quietly redirected
 * all seven. The two sources of truth drifted, so pre-link local copies of the
 * other six members were silently orphaned at link time and lost at unlink
 * time. Adding a new family file required editing two commands in lockstep — a
 * classic omission hazard.
 *
 * This manifest is the single source of truth for *which* artifacts participate
 * in link/unlink family migration and *how* each is merged. `link` and `unlink`
 * both iterate it, so a new family member is a one-line edit here.
 *
 * Merge strategies:
 *  - `dedup-id-merge`: id-dedup with provenance-preserving near-duplicate merge
 *    (union fields, evidence-weighted confidence, preserve losing id in
 *    `merged_from`). Used for the active store.
 *  - `append-union`: union by the line's stable id field (event id / entry id),
 *    appending only lines whose id is not already present on the destination.
 *    Idempotent on retry/relink.
 *  - `append-concat`: union of an append-only audit log that has NO top-level
 *    `id`. Dedup is keyed off a per-member composite `keyOf` selector (e.g.
 *    `entry_id + after_revision + timestamp` for rewrite history) so legitimately
 *    distinct revisions/proposals are preserved while an idempotent relink/retry
 *    does not duplicate a record. Mechanically identical to `append-union` but
 *    labelled separately so the manifest documents which members are non-`id`
 *    audit logs (issue #1848 cohort-scoped rewrite/proposal history).
 *  - `sum-counters`: per-counter field-wise SUM, reusing the existing
 *    `mergeRollupInto` primitive (shown/applied/... counts sum; timestamps take
 *    the max). Used for the counter baseline JSON.
 *
 * Key selection:
 *  - Every member is deduped by a stable key. By default the key is the line's
 *    string `id` field. A member may override this with an explicit `keyOf`
 *    selector returning a composite string (or `null` for an unkeyable/malformed
 *    line). The default preserves the historical `id`-keyed behavior for every
 *    pre-existing member exactly.
 *
 * NOT in the manifest (deliberate exceptions, documented in
 * `knowledge-link.ts` "Intentionally NOT redirected"):
 *  - `synonym-map.json` — derived state. It is rebuilt deterministically from
 *    the linked `knowledge.jsonl` corpus on link rather than migrated, so recall
 *    is deterministic across the cohort (issue #1846 §4, critic C4).
 *  - `.knowledge-shown.json`, `plan.json`, evidence, session state — per
 *    worktree by design.
 */

export type FamilyRole =
	| 'store'
	| 'events'
	| 'rejected'
	| 'retractions'
	| 'counters'
	| 'quarantine'
	| 'unactionable'
	| 'application-legacy'
	| 'rewrite-history'
	| 'curation-proposals';

export type FamilyMergeStrategy =
	| 'dedup-id-merge'
	| 'append-union'
	| 'append-concat'
	| 'sum-counters';

/**
 * Extracts the stable dedup key from a single parsed JSONL line. Returns `null`
 * for a line that carries no derivable key (e.g. missing required fields) — such
 * a line is unaddressable for dedup and is skipped by the append strategies and
 * rejected by the pre-commit validator, exactly as an id-less line is today.
 */
export type FamilyKeySelector = (line: unknown) => string | null;

export interface KnowledgeFamilyMember {
	/** Filename within the swarm family directory (e.g. `knowledge.jsonl`). */
	readonly filename: string;
	readonly role: FamilyRole;
	readonly mergeStrategy: FamilyMergeStrategy;
	/** True when unlink may copy this member back to the local worktree. */
	readonly reversible: boolean;
	/**
	 * Optional per-member identity-key selector. When omitted, the member is
	 * keyed by its string `id` field (the historical default that every
	 * pre-existing member relies on). Members whose records have no top-level
	 * `id` (append-only audit logs) supply a composite selector here.
	 */
	readonly keyOf?: FamilyKeySelector;
}

/** Read a required non-empty string field off a parsed line, else `null`. */
function reqStr(o: Record<string, unknown>, field: string): string | null {
	const v = o[field];
	return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Composite key for `knowledge-rewrites.jsonl` (`RewriteHistoryRecord`). A
 * rewrite is uniquely identified by the entry it rewrote, the resulting revision
 * number, and the timestamp of the change. Revisions are monotonic per entry, so
 * `entry_id + after_revision` already discriminates distinct revisions; the
 * timestamp is folded in as a belt-and-braces guard so no legitimately distinct
 * audit line is ever collapsed, while an identical line re-seen on retry/relink
 * dedupes cleanly. Returns `null` for a malformed line (missing required fields).
 */
function rewriteHistoryKey(line: unknown): string | null {
	if (!line || typeof line !== 'object') return null;
	const o = line as Record<string, unknown>;
	const entryId = reqStr(o, 'entry_id');
	const timestamp = reqStr(o, 'timestamp');
	const afterRevision = o.after_revision;
	if (entryId === null || timestamp === null) return null;
	if (typeof afterRevision !== 'number' || !Number.isFinite(afterRevision)) {
		return null;
	}
	// "|" separator: cannot occur inside the component strings, so no key
	// collision across field boundaries.
	return `${entryId}|${afterRevision}|${timestamp}`;
}

/**
 * Composite key for `curation-proposals.jsonl` (`CurationProposal`). A proposal
 * is uniquely identified by the entry, the destructive action proposed, and the
 * ISO instant it was proposed. Two distinct actions proposed for the same entry
 * are kept as separate lines; an identical proposal re-seen on retry dedupes.
 * Returns `null` for a malformed line (missing required fields).
 */
function curationProposalKey(line: unknown): string | null {
	if (!line || typeof line !== 'object') return null;
	const o = line as Record<string, unknown>;
	const entryId = reqStr(o, 'entryId');
	const action = reqStr(o, 'action');
	const proposedAt = reqStr(o, 'proposedAt');
	if (entryId === null || action === null || proposedAt === null) return null;
	return `${entryId}|${action}|${proposedAt}`;
}

/**
 * The complete knowledge family that participates in cohort linking.
 * Adding a member here automatically includes it in link + unlink migration.
 */
export const KNOWLEDGE_FAMILY: readonly KnowledgeFamilyMember[] = [
	{
		filename: 'knowledge.jsonl',
		role: 'store',
		mergeStrategy: 'dedup-id-merge',
		reversible: true,
	},
	{
		filename: 'knowledge-events.jsonl',
		role: 'events',
		mergeStrategy: 'append-union',
		reversible: true,
	},
	{
		filename: 'knowledge-rejected.jsonl',
		role: 'rejected',
		mergeStrategy: 'append-union',
		reversible: true,
	},
	{
		filename: 'knowledge-retractions.jsonl',
		role: 'retractions',
		mergeStrategy: 'append-union',
		reversible: true,
	},
	{
		filename: 'knowledge-counter-baseline.json',
		role: 'counters',
		mergeStrategy: 'sum-counters',
		reversible: true,
	},
	{
		filename: 'knowledge-quarantined.jsonl',
		role: 'quarantine',
		mergeStrategy: 'append-union',
		reversible: true,
	},
	{
		filename: 'knowledge-unactionable.jsonl',
		role: 'unactionable',
		mergeStrategy: 'append-union',
		reversible: true,
	},
	{
		filename: 'knowledge-application.jsonl',
		role: 'application-legacy',
		mergeStrategy: 'append-union',
		reversible: true,
	},
	{
		// Issue #1848 §3: cohort-scoped immutable before/after rewrite/merge audit
		// log (`RewriteHistoryRecord`). No top-level `id`; keyed by a composite of
		// entry + resulting revision + timestamp so distinct revisions survive and
		// relink/retry is idempotent. Resolver: resolveRewriteHistoryPath.
		filename: 'knowledge-rewrites.jsonl',
		role: 'rewrite-history',
		mergeStrategy: 'append-concat',
		reversible: true,
		keyOf: rewriteHistoryKey,
	},
	{
		// Issue #1848 §2: cohort-scoped blocked-destructive-action proposals
		// (`CurationProposal`). No top-level `id`; keyed by a composite of entry +
		// action + proposedAt. Written by authorizeCuration (curation-policy.ts).
		filename: 'curation-proposals.jsonl',
		role: 'curation-proposals',
		mergeStrategy: 'append-concat',
		reversible: true,
		keyOf: curationProposalKey,
	},
];

/** Filenames of every family member, for quick membership checks. */
export const FAMILY_FILENAMES: readonly string[] = KNOWLEDGE_FAMILY.map(
	(m) => m.filename,
);
