/**
 * user-visible-paths.ts — the single declarative source for the AGENTS.md
 * invariant-12 path classification:
 *
 *   "Every user-visible PR ships a `docs/releases/pending/<unique-slug>.md`
 *    fragment (mandatory — see `contributing.md`)."
 *
 * Issue #2955: two required gates enforced this one mandate with contradictory
 * predicates (the TS classifier here vs a hand-maintained bash regex
 * triplicated across .github/workflows/), diverging on 9 path classes and on
 * fragment-satisfaction semantics (added-only vs added/modified/renamed).
 * This table is now the ONLY classification source; every consumer (the
 * quality-gate script scripts/check-pending-fragment.ts, the
 * `--print-requirement` CLI mode the workflow arms consume, and the
 * fragment-path-parity drift detector) reads these rows. A per-class
 * resolution note records how each formerly divergent class was settled
 * (the TS verdict wins — it encodes the "user-visible" semantics; the union
 * of the two required gates never widens, it only sheds the bash-only false
 * blocks).
 */

export const FRAGMENT_DIR = 'docs/releases/pending';

/**
 * Fragment-satisfaction semantics. Added-only: the mandate says each
 * user-visible PR *ships* a fragment — modifying another PR's pending
 * fragment does not ship yours, and deletions never satisfy. (Issue #2955
 * resolved the former AMR-vs-A divergence in favor of the TS side.)
 */
export const FRAGMENT_SATISFACTION = 'added-only' as const;

export type PathClassKind = 'suffix' | 'never-prefix' | 'exact' | 'prefix';

export interface UserVisiblePathClass {
	kind: PathClassKind;
	/** posix, root-relative pattern (prefix/exact) or file suffix. */
	pattern: string;
	/** true when the class counts as user-visible. */
	userVisible: boolean;
	/** recorded per-class resolution (issue #2955) / rationale. */
	note: string;
}

/**
 * Ordered class table. Evaluation order is load-bearing and preserves the
 * pre-table semantics exactly: suffix exclusion first, then never-prefixes,
 * then exact files, then visible prefixes.
 */
export const USER_VISIBLE_PATH_CLASSES: readonly UserVisiblePathClass[] = [
	{
		kind: 'suffix',
		pattern: '.test.ts',
		userVisible: false,
		note: 'colocated test files are never user-visible, even under src/.',
	},
	{
		kind: 'suffix',
		pattern: '.test.tsx',
		userVisible: false,
		note: 'colocated test files are never user-visible, even under src/.',
	},
	{
		kind: 'never-prefix',
		pattern: 'tests/',
		userVisible: false,
		note: '#2955 class 2: bash narrowed (dropped) — test-only PRs are not user-visible and were falsely blocked by pr-standards. Note two shipped subtrees live here (tests/fixtures/memory-recall*, tests/fixtures/memory-recall-heldout* are in package.json#files); they ship evaluation fixtures, not user-facing behavior, so a fragment is still not required. A shipped path needing a fragment gets its own exact/prefix row.',
	},
	{
		kind: 'never-prefix',
		pattern: 'scripts/',
		userVisible: false,
		note: '#2955 class 1: bash narrowed (dropped) — scripts/ is CI tooling and is NOT in package.json#files, so scripts-only PRs never reach users; scripts-only PRs were falsely blocked.',
	},
	{
		kind: 'never-prefix',
		pattern: '.zcode/',
		userVisible: false,
		note: 'harness session state, never user-visible.',
	},
	{
		kind: 'never-prefix',
		pattern: 'node_modules/',
		userVisible: false,
		note: 'dependencies are never user-visible.',
	},
	{
		kind: 'never-prefix',
		pattern: 'evaluation-fixtures/',
		userVisible: false,
		note: '#3291 census: shipped in package.json#files but ships evaluation fixtures, not user-facing behavior; recorded so every changed path under the subtree is a reviewed decision, not a fallthrough accident.',
	},
	{
		kind: 'never-prefix',
		pattern: 'dist/',
		userVisible: false,
		note: '#3291 census: generated build output of src/ (package.json#files ships it), never committed, so no PR diff can touch it; recorded for census completeness.',
	},
	{
		kind: 'exact',
		pattern: 'opencode-swarm.schema.json',
		userVisible: false,
		note: '#3291 census: generated editor-validation schema, shipped but not user-facing behavior.',
	},
	{
		kind: 'exact',
		pattern: 'README.md',
		userVisible: false,
		note: '#3291 census: shipped documentation text, not behavior.',
	},
	{
		kind: 'exact',
		pattern: 'LICENSE',
		userVisible: false,
		note: '#3291 census: shipped license text, not behavior.',
	},
	{
		kind: 'exact',
		pattern: 'package.json',
		userVisible: true,
		note: 'the npm manifest ships to users.',
	},
	{
		kind: 'exact',
		pattern: 'docs/configuration.md',
		userVisible: true,
		note: '#2955 class 9: bash widened (gained) — the user-facing configuration reference is user-visible; the bash regex missed it.',
	},
	{
		kind: 'prefix',
		pattern: 'src/',
		userVisible: true,
		note: 'plugin source ships in dist/.',
	},
	{
		kind: 'prefix',
		pattern: 'bin/',
		userVisible: true,
		note: '#3291 census correction: bin/ is NOT in package.json#files (package.json#bin points at dist/cli/index.js); classified user-visible conservatively because the legacy gate treated it as shipped.',
	},
	{
		kind: 'prefix',
		pattern: 'binaries/',
		userVisible: true,
		note: 'shipped binary payloads.',
	},
	{
		kind: 'prefix',
		pattern: 'runners/',
		userVisible: true,
		note: 'the sandbox runner ships.',
	},
	{
		kind: 'prefix',
		pattern: '.github/workflows/',
		userVisible: true,
		note: '#2955 class 4: bash widened (gained) — CI behavior is user-visible; the bash regex missed workflow changes.',
	},
	{
		kind: 'prefix',
		pattern: '.opencode/skills/',
		userVisible: true,
		note: '#2955 class 5: bash widened (gained) — shipped plugin skills are user-visible.',
	},
	{
		kind: 'prefix',
		pattern: '.claude/skills/',
		userVisible: true,
		note: '#2955 class 5: bash widened (gained) — shipped plugin skills are user-visible.',
	},
	{
		kind: 'prefix',
		pattern: '.agents/skills/',
		userVisible: true,
		note: '#2955 class 5: bash widened (gained) — shipped plugin skills are user-visible.',
	},
];

function toPosix(file: string): string {
	return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Does one changed path count as a user-visible surface? Pure. Evaluation
 * walks USER_VISIBLE_PATH_CLASSES in order; the first matching row wins
 * (suffix rows match by endsWith, prefix rows by startsWith, exact by
 * equality) — no match means not user-visible (docs/, examples/, bun.lock,
 * bunfig.toml, and all other paths; see the #2955 resolution notes).
 */
export function isUserVisiblePath(file: string): boolean {
	const p = toPosix(file);
	for (const pathClass of USER_VISIBLE_PATH_CLASSES) {
		switch (pathClass.kind) {
			case 'suffix':
				if (p.endsWith(pathClass.pattern)) return pathClass.userVisible;
				break;
			case 'never-prefix':
			case 'prefix':
				if (p.startsWith(pathClass.pattern)) return pathClass.userVisible;
				break;
			case 'exact':
				if (p === pathClass.pattern) return pathClass.userVisible;
				break;
		}
	}
	return false;
}

/**
 * Is this path an ADDED pending fragment satisfying the mandate? Pure.
 *
 * Parity with the release aggregator's `filterPendingFragmentPaths`
 * (scripts/release-notes-fragments.mjs; issues #3306/#3361): a name counts
 * as a pending fragment only when the aggregator would collect it too — no
 * C0 control characters, no `..` segments, no leading `./` prefix (the
 * aggregator performs no such stripping), and the `.md` suffix matches
 * case-insensitively. The directory prefix itself stays case-sensitive on
 * both sides.
 */
export function isPendingFragment(file: string): boolean {
	if (/[\x00-\x1f]/.test(file)) return false;
	// The leading-`./` test must run on the RAW name: toPosix strips one
	// leading `./` (`.\` normalizes into it), and the aggregator performs no
	// such stripping — a `./`-prefixed (or `.\`-prefixed) name must not
	// satisfy the gate.
	if (file.startsWith('./') || file.startsWith('.\\')) return false;
	// A backslash anywhere in the raw name is not a fragment (final-critic
	// round 1): git and GitHub always emit `/`-separated repo paths, and the
	// aggregator's collection path (containedPendingPath →
	// readFragmentFromWorkspace) resolves the NORMALIZED name — a root-level
	// file literally named `docs\releases\pending\x.md` satisfies this gate
	// but yields no release note (read returns null / release fails closed
	// under requireComplete). Both sides must refuse it.
	if (file.includes('\\')) return false;
	const p = toPosix(file);
	if (p.split('/').some((segment) => segment === '..')) return false;
	return p.startsWith(`${FRAGMENT_DIR}/`) && p.toLowerCase().endsWith('.md');
}
