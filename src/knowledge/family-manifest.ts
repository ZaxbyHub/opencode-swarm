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
 *  - `sum-counters`: per-counter field-wise SUM, reusing the existing
 *    `mergeRollupInto` primitive (shown/applied/... counts sum; timestamps take
 *    the max). Used for the counter baseline JSON.
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
	| 'application-legacy';

export type FamilyMergeStrategy =
	| 'dedup-id-merge'
	| 'append-union'
	| 'sum-counters';

export interface KnowledgeFamilyMember {
	/** Filename within the swarm family directory (e.g. `knowledge.jsonl`). */
	readonly filename: string;
	readonly role: FamilyRole;
	readonly mergeStrategy: FamilyMergeStrategy;
	/** True when unlink may copy this member back to the local worktree. */
	readonly reversible: boolean;
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
];

/** Filenames of every family member, for quick membership checks. */
export const FAMILY_FILENAMES: readonly string[] = KNOWLEDGE_FAMILY.map(
	(m) => m.filename,
);
