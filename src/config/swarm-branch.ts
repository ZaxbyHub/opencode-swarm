/**
 * The swarm worktree BRANCH GRAMMAR — single source of truth for both building
 * and recognising the branch names that identify a swarm-owned worktree.
 *
 * ## Why a grammar and not a prefix
 *
 * Lane detection (`src/config/lane-context.ts`) uses the branch name as its
 * ownership signal because, unlike the worktree's path, it is invariant across
 * all three provisioning layouts (default `.swarm-worktrees`, a configured
 * `worktree.worktree_dir`, and the Windows path-budget fallback that relocates
 * a lane to `<os.tmpdir()>/swwt/...`).
 *
 * Matching a bare `swarm/` PREFIX is not safe. A user running
 * `git worktree add -b swarm/my-own-experiment ../scratch` would be classified
 * as a lane, and their ordinary interactive session would then have
 * `external_directory: { "*": "deny", ... }` injected. That is strictly worse
 * than the hang this subsystem exists to fix, because the host's
 * `Permission.ask` short-circuits on a deny before it ever creates a deferred:
 *
 * ```js
 * // opencode 1.18.10, Permission.ask
 * if (W.action === "deny") return yield* new U.DeniedError({ ... });
 * ```
 *
 * — so no prompt is raised and "Allow always" can never be reached. The user
 * has no in-session recovery.
 *
 * The grammar below therefore matches the COMPLETE shape
 * `makeWorktreeBranchName` emits, including a session segment constrained to
 * OpenCode's `ses_`-prefixed identifier form. `tests/unit/config/swarm-branch.test.ts`
 * holds a round-trip property test over the producer and a negative corpus of
 * plausible human-authored branch names.
 *
 * @module config/swarm-branch
 */

import { SWARM_WORKTREE_DIR_NAME } from './constants';

/**
 * Branch-name prefixes emitted by `makeWorktreeBranchName`.
 *
 * `swarm/` is the standard purpose-scoped style; `swarm-lane/` is Lean Turbo's
 * `branchStyle: 'legacy-lane'`.
 */
const SWARM_WORKTREE_BRANCH_PREFIXES = ['swarm/', 'swarm-lane/'] as const;

/**
 * OpenCode session identifiers are `ses_` followed by an alphanumeric body
 * (e.g. `ses_0410b724cffeApmZIOs5VH9XsN`). Constraining the session segment is
 * what stops `swarm/lane/notasession/1.1` from matching.
 */
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;

/**
 * True when `sessionId` is a session identifier the lane grammar can encode.
 *
 * Tool arguments are LLM-supplied (`sessionID: z.string()`) and the host's own
 * `SessionID` brand is only `isStartsWith("ses")`, so a value like `ses-run-1`
 * passes the host but yields a branch the recogniser cannot match — a lane that
 * silently skips permission scoping and hangs. Callers that accept a session id
 * from outside should check this before provisioning.
 */
export function isSwarmSessionId(sessionId: unknown): sessionId is string {
	return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);
}

/**
 * A single path segment that is neither empty nor a relative-path token.
 * Applied to `<purpose>` and `<id>` so no segment can smuggle in traversal.
 */
function isPlainSegment(segment: string | undefined): segment is string {
	return (
		typeof segment === 'string' &&
		segment.length > 0 &&
		segment !== '.' &&
		segment !== '..'
	);
}

/**
 * Builds the branch name for a swarm worktree.
 *
 * The ONLY producer of these names. `makeWorktreeBranchName` in
 * `src/worktree/core.ts` delegates here so the producer and
 * {@link matchSwarmLaneBranch} cannot drift.
 *
 * @param sessionId    - Parent session identifier.
 * @param id           - Execution-unit identifier (task or lane id).
 * @param purpose      - Worktree purpose (e.g. `lane`).
 * @param legacyLane   - Use Lean Turbo's `swarm-lane/<sessionId>/<id>` style.
 */
export function buildSwarmBranchName(
	sessionId: string,
	id: string,
	purpose: string,
	legacyLane: boolean,
): string {
	const [standardPrefix, legacyLanePrefix] = SWARM_WORKTREE_BRANCH_PREFIXES;
	return legacyLane
		? `${legacyLanePrefix}${sessionId}/${id}`
		: `${standardPrefix}${purpose}/${sessionId}/${id}`;
}

/**
 * Recognises the DEFAULT lane PATH shape,
 * `<base>/.swarm-worktrees/<sessionId>/<id>`.
 *
 * This is the fallback ownership signal for a worktree whose HEAD is detached
 * or unreadable, so its branch cannot be consulted. It must be as tight as the
 * branch grammar: matching "any path containing a `.swarm-worktrees` segment"
 * captures a user's own `git worktree add -b my-feature ../.swarm-worktrees/manual-user-wt`,
 * which then has an unrecoverable deny-by-default injected into an ordinary
 * interactive session.
 *
 * `provisionWorktree` builds this path as
 * `path.resolve(resolveWorktreeBaseDir(directory), sessionId, id)`, i.e. exactly
 * two segments after the base, so the shape check requires exactly that — with
 * the session segment held to the SAME `ses_…` constraint the branch grammar
 * uses. The directory name comes from the same `SWARM_WORKTREE_DIR_NAME`
 * constant `resolveWorktreeBaseDir` builds with, so the three definitions
 * cannot drift.
 *
 * KNOWN RESIDUAL (accepted, not a defect to chase): a worktree the USER created
 * at exactly `<base>/.swarm-worktrees/ses_<alnum>/<id>` on a non-swarm branch
 * still classifies as a lane. Reaching it requires deliberately creating a
 * directory literally named `ses_<alnum>` under a `.swarm-worktrees` base, and
 * the same leniency is what keeps a REAL lane detected after someone checks out
 * a different branch inside it. Narrowing further would trade a far more likely
 * false negative (a real lane silently unscoped, i.e. the original hang) for a
 * far less likely false positive.
 *
 * Note this recognises only the DEFAULT layout. A `worktree_dir` override or
 * the Windows path-budget fallback produces a different path, and a lane in
 * those layouts with a detached HEAD is a false NEGATIVE — no permission
 * changes, i.e. today's behaviour. That is the safe direction.
 *
 * @param lanePath - An already-resolved absolute path.
 */
export function matchSwarmLanePath(
	lanePath: string,
): { sessionId: string; id: string } | undefined {
	if (typeof lanePath !== 'string' || lanePath === '') return undefined;
	const segments = lanePath.split(/[\\/]+/).filter((s) => s.length > 0);
	if (segments.length < 3) return undefined;
	const [base, sessionId, id] = segments.slice(-3);
	// Windows path comparison is case-insensitive; POSIX is not.
	const baseMatches =
		process.platform === 'win32'
			? base.toLowerCase() === SWARM_WORKTREE_DIR_NAME.toLowerCase()
			: base === SWARM_WORKTREE_DIR_NAME;
	if (!baseMatches) return undefined;
	if (!SESSION_ID_PATTERN.test(sessionId ?? '')) return undefined;
	if (!isPlainSegment(id)) return undefined;
	return { sessionId, id };
}

/** A branch name recognised as a swarm worktree lane. */
export interface SwarmLaneBranch {
	/** Worktree purpose. `'lane'` for the legacy style, which encodes no purpose. */
	purpose: string;
	sessionId: string;
	id: string;
	style: 'purpose' | 'legacy-lane';
}

/**
 * Recognises a branch name produced by {@link buildSwarmBranchName}.
 *
 * Matches the complete grammar and nothing wider:
 *   - `swarm/<purpose>/<sessionId>/<id>`   — exactly 4 segments
 *   - `swarm-lane/<sessionId>/<id>`        — exactly 3 segments
 *
 * with `<sessionId>` matching `ses_[A-Za-z0-9]+` and `<purpose>` / `<id>` each
 * a single non-empty, non-dot segment. Anything else — including a bare
 * `swarm/my-own-experiment`, or a real lane name with extra trailing segments —
 * returns `undefined`, which classifies the worktree as NOT swarm-owned and
 * leaves it completely untouched.
 *
 * @returns The parsed branch, or `undefined` when the name is not a swarm lane.
 */
export function matchSwarmLaneBranch(
	branch: string,
): SwarmLaneBranch | undefined {
	if (typeof branch !== 'string' || branch === '') return undefined;
	const segments = branch.split('/');

	// swarm-lane/<sessionId>/<id>
	if (segments[0] === 'swarm-lane') {
		if (segments.length !== 3) return undefined;
		const [, sessionId, id] = segments;
		if (!SESSION_ID_PATTERN.test(sessionId ?? '')) return undefined;
		if (!isPlainSegment(id)) return undefined;
		return { purpose: 'lane', sessionId, id, style: 'legacy-lane' };
	}

	// swarm/<purpose>/<sessionId>/<id>
	if (segments[0] === 'swarm') {
		if (segments.length !== 4) return undefined;
		const [, purpose, sessionId, id] = segments;
		if (!isPlainSegment(purpose)) return undefined;
		if (!SESSION_ID_PATTERN.test(sessionId ?? '')) return undefined;
		if (!isPlainSegment(id)) return undefined;
		return { purpose, sessionId, id, style: 'purpose' };
	}

	return undefined;
}

/**
 * Tier-0 test seam (writing-tests skill). The prefix list is an implementation
 * detail of the grammar — production code goes through
 * {@link buildSwarmBranchName} / {@link matchSwarmLaneBranch} — but the branch
 * tests assert that both documented styles are actually exercised.
 */
export const _test_exports = { SWARM_WORKTREE_BRANCH_PREFIXES };
