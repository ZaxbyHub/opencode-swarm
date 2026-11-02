/**
 * user-visible-paths.ts (8.x `next` line) — the declarative source for the
 * release-fragment path classification on this branch.
 *
 * Ported from the main line's `scripts/user-visible-paths.ts` (issue #2955
 * there; issue #3228 here) with a table adapted to this monorepo's layout.
 * Contract preserved: ordered classes, first match wins, no match = not
 * user-visible; fragment satisfaction is ADDED-ONLY (a PR satisfies the
 * mandate by ADDING a file under docs/releases/pending/, never by editing
 * or deleting another PR's fragment).
 *
 * 8.x table rationale (recorded per class):
 * - `packages/` is the shipped surface: everything under it except tests
 *   and colocated test files ships to npm consumers (claude-code ships
 *   scripts/hooks/agents; core/opencode/telemetry ship dist built from src).
 * - root `package.json` here is the PRIVATE workspace manifest (unlike the
 *   main line, where it is the shipped npm manifest) — not user-visible.
 * - `.github/workflows/` is user-visible: CI behavior is user-visible
 *   (main-line #2955 class 4 semantics). This port's own PR therefore
 *   requires a fragment.
 */

export const FRAGMENT_DIR = 'docs/releases/pending';

/**
 * Fragment-satisfaction semantics. Added-only: the mandate says each
 * user-visible PR *ships* a fragment — modifying another PR's pending
 * fragment does not ship yours, and deletions never satisfy.
 */
export const FRAGMENT_SATISFACTION = 'added-only' as const;

export type PathClassKind = 'suffix' | 'never-prefix' | 'exact' | 'prefix';

export interface UserVisiblePathClass {
	kind: PathClassKind;
	/** posix, root-relative pattern (prefix/exact) or file suffix. */
	pattern: string;
	/** true when the class counts as user-visible. */
	userVisible: boolean;
	/** rationale / provenance of the class decision. */
	note: string;
}

/**
 * Ordered class table. Evaluation order is load-bearing: suffix exclusions
 * first, then never-prefixes, then exact files, then visible prefixes.
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
		kind: 'suffix',
		pattern: '.test.cjs',
		userVisible: false,
		note: 'colocated test files are never user-visible (telemetry package root ships none of these).',
	},
	{
		kind: 'never-prefix',
		pattern: 'tests/',
		userVisible: false,
		note: 'root test tree (smoke/security) — never shipped; none of it is in any package.json#files.',
	},
	{
		kind: 'never-prefix',
		pattern: 'test/',
		userVisible: false,
		note: 'root test-support tree — never shipped.',
	},
	{
		kind: 'never-prefix',
		pattern: 'packages/opencode/tests/',
		userVisible: false,
		note: 'package test trees are never shipped (package.json#files ships dist + docs only).',
	},
	{
		kind: 'never-prefix',
		pattern: 'packages/core/tests/',
		userVisible: false,
		note: 'package test trees are never shipped.',
	},
	{
		kind: 'never-prefix',
		pattern: 'scripts/',
		userVisible: false,
		note: 'root scripts/ is CI/release tooling, not in any package.json#files. (packages/claude-code/scripts/ IS shipped — the visible packages/ prefix below covers it; this root-relative never-prefix does not match it.)',
	},
	{
		kind: 'never-prefix',
		pattern: '.zcode/',
		userVisible: false,
		note: 'harness session state, never user-visible.',
	},
	{
		kind: 'never-prefix',
		pattern: '.agents/',
		userVisible: false,
		note: 'trace/tooling scratch space excluded from version control, never user-visible.',
	},
	{
		kind: 'never-prefix',
		pattern: 'node_modules/',
		userVisible: false,
		note: 'dependencies are never user-visible.',
	},
	{
		kind: 'never-prefix',
		pattern: 'dist/',
		userVisible: false,
		note: 'generated build output, never committed, so no PR diff can touch it; recorded for census completeness.',
	},
	{
		kind: 'exact',
		pattern: 'package.json',
		userVisible: false,
		note: '8.x divergence from main: the ROOT package.json here is the private workspace manifest, not the shipped npm manifest; the shipped per-package manifests live under packages/ and are covered by the visible prefix below.',
	},
	{
		kind: 'exact',
		pattern: 'README.md',
		userVisible: false,
		note: 'shipped documentation text, not behavior.',
	},
	{
		kind: 'exact',
		pattern: 'LICENSE',
		userVisible: false,
		note: 'shipped license text, not behavior.',
	},
	{
		kind: 'prefix',
		pattern: 'packages/',
		userVisible: true,
		note: 'the shipped monorepo surface: src builds the published dist; claude-code additionally ships scripts/hooks/agents per its package.json#files; per-package package.json manifests ship.',
	},
	{
		kind: 'prefix',
		pattern: '.github/workflows/',
		userVisible: true,
		note: 'CI/release behavior is user-visible (main-line #2955 class 4 semantics) — workflow changes alter what ships and how.',
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
 * biome.json, root config, and all other paths).
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

/** Is this path an ADDED pending fragment satisfying the mandate? Pure. */
export function isPendingFragment(file: string): boolean {
	const p = toPosix(file);
	return p.startsWith(`${FRAGMENT_DIR}/`) && p.endsWith('.md');
}

export interface FragmentRequirement {
	/** true when the changed set touches at least one user-visible surface. */
	required: boolean;
	/** true when the mandate is satisfied (an added pending fragment). */
	satisfied: boolean;
}

/**
 * Pure requirement evaluation for a changed/added path set.
 * - required=false for a diff with no user-visible surface (chore/test/
 *   docs-only PRs) — satisfied is then vacuously true.
 * - required=true requires at least one ADDED path under
 *   docs/releases/pending/ ending in .md (added-only semantics).
 */
export function evaluateRequirement(changed: readonly string[], added: readonly string[]): FragmentRequirement {
	const changedList = Array.isArray(changed) ? changed : [];
	const addedList = Array.isArray(added) ? added : [];
	const required = changedList.some((f) => isUserVisiblePath(f));
	const satisfied = !required || addedList.some((f) => isPendingFragment(f));
	return { required, satisfied };
}
