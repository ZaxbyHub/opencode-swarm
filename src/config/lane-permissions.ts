/**
 * Scoped `external_directory` permission rules for swarm worktree-lane
 * instances.
 *
 * ## The problem this solves
 *
 * A lane session is created against a new directory, so OpenCode builds it a
 * fresh directory-keyed permission universe with an empty `approved` list. The
 * host's default agent ruleset ends in `external_directory: { "*": "ask" }`, and
 * a lane instance has no TUI attached to answer an ask — `Permission.ask` parks
 * on a deferred with no timeout and the lane hangs forever.
 *
 * ## The mechanism
 *
 * The plugin `config` hook runs once per OpenCode instance (`Plugin.state` is
 * built through the same directory-keyed `InstanceState` cache as
 * `Permission.state`), so in a lane instance it runs with `ctx.directory` set to
 * the lane path. Rules merged into the top-level `permission` block there are
 * folded by the host into **every** agent's ruleset:
 *
 * ```js
 * // opencode host, Agent.state
 * l = a.fromConfig(p.permission ?? {})            // top-level config permission
 * r = { build: { permission: a.merge(c, ..., l) }, plan: {...}, general: {...},
 *       explore: {...}, compaction: {...}, title: {...}, summary: {...} }
 * for (const [n, s] of Object.entries(p.agent ?? {})) {
 *   let e = r[n];
 *   if (!e) e = r[n] = { ..., permission: a.merge(c, l), ... };   // swarm agents
 *   e.permission = a.merge(e.permission, a.fromConfig(s.permission ?? {}));
 * }
 * ```
 *
 * Top-level is therefore strictly broader than per-agent injection: it reaches
 * the host-native agents (`build`, `plan`, `general`, `explore`, ...) that a
 * lane can also run, and it lands *before* any per-agent block so explicit
 * per-agent user config still wins. Injecting the same rules per-agent as well
 * would duplicate every rule in every ruleset and would make our injected rules
 * outrank the user's own top-level entries — the wrong precedence.
 *
 * ## DISCLOSED ASSUMPTION: hook-before-agents ordering
 *
 * This design requires the `config` hook to run before `Agent.state` reads the
 * config. What is PROVEN: both sides touch the *same* object — `Plugin.state`
 * does `U = yield* Config.get()` and mutates `U` in place, `Agent.state` does
 * `p = yield* Config.get()`, and `Config.state` is InstanceState-cached, so
 * `get()` returns one shared instance. There is no copy; only ordering is in
 * question.
 *
 * What is NOT proven: any static ordering guarantee. Two bounded searches of
 * the host binary came back negative — the Agent layer's deps
 * (`deps:[J.node,O.node,P.node,_.node,$.node,Ve]`, offset 100817167) do not
 * include the Plugin node (the three symbols the Agent chunk imports from the
 * Plugin chunk are `$G`, `b8`, `r1`, none of which is the Plugin service), and
 * `Plugin.init` (offset 102128681) has no caller anywhere in the bundle. The
 * hook therefore fires lazily, when `Plugin.state` is first populated by a
 * `Plugin.trigger` / `Plugin.list`.
 *
 * The evidence that it holds is empirical and strong: opencode-swarm's agents
 * are registered ONLY by this config hook, and they demonstrably appear in the
 * TUI, which is impossible unless the hook ran before `Agent.state` was built.
 * Treat it as a verified-in-practice property of this host build rather than a
 * contract. If a future OpenCode release reorders layer construction, the
 * symptom is loud and immediate — no swarm agents at all — not a silent
 * permission regression.
 *
 * ## Rule ordering is load-bearing
 *
 * The host evaluates with `findLast` over the flattened rule list:
 *
 * ```js
 * function c(j, J, ...K) {
 *   return K.flat().findLast((z) => g.match(j, z.permission) && g.match(J, z.pattern))
 *          ?? { action: "ask", permission: j, pattern: "*" };
 * }
 * ```
 *
 * and `fromConfig` preserves `Object.entries` order. So **later wins**, and the
 * catch-all `"*": "deny"` must be emitted FIRST, before the specific allows.
 * Emitting it last would deny everything. `tests/unit/config/lane-permissions.test.ts`
 * pins this against a faithful re-implementation of the host's own
 * `fromConfig`/`merge`/`evaluate`, so the ordering contract is verified rather
 * than assumed.
 *
 * Two further host behaviours matter and are deliberately relied upon:
 *
 *  - `Wildcard.match` compiles the rule pattern with `*` -> `.*` under the `s`
 *    (dotAll) flag, so `<dir>/*` covers the entire subtree, and it normalises
 *    `\` to `/` on both sides before matching, so native Windows paths are fine.
 *  - After merging config, the host appends
 *    `external_directory: { <Global.Path.data>/tool-output/*: "allow" }` to every
 *    agent unless a rule already matches that exact pattern with `action: "deny"`.
 *    Our catch-all uses pattern `"*"`, which does not satisfy that exact-string
 *    check, so the append still happens and still lands last. Tool output stays
 *    readable. The emitted ruleset is intentionally not the final ruleset.
 *
 * @module config/lane-permissions
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendCoreEventSync } from '../events/core-events.js';
import { SKILL_SEARCH_ROOTS } from '../hooks/skill-propagation-gate';
import { addDeferredWarning } from '../services/warning-buffer';
import {
	getHostConfigDir,
	getHostDataDir,
	getHostSkillCacheDir,
	getPluginConfigDir,
} from './cache-paths';
import { hostNormalizePathPattern } from './host-path';
import type { LaneContext } from './lane-context';
import { resolveLaneContext } from './lane-context';

/**
 * Lane permission policy. Mirrors `worktree.lane_permissions` in
 * `src/config/schema.ts`.
 */
export type LanePermissionMode = 'scoped_allow' | 'deny' | 'off';

/** Permission actions OpenCode understands for a rule. */
type PermissionAction = 'allow' | 'ask' | 'deny';

/**
 * An `external_directory` rule map whose ONLY insertion semantics are
 * "last write wins, and lands last".
 *
 * ## Why this class exists
 *
 * The host evaluates with `findLast` over `Object.entries` order, so a rule's
 * POSITION is its precedence. Plain assignment (`rules[k] = v`) does not move an
 * existing key — it updates the value in place and the key keeps its ORIGINAL
 * slot. Writing the catch-all `'*'` first and then re-assigning it from user
 * config therefore leaves the user's rule at index 0, behind the entire plugin
 * allowlist, so the allowlist beats the operator's explicit deny-all. Because
 * `external_directory` has no read/write split, that silently re-grants WRITE
 * access against a deliberate lockdown.
 *
 * This is the third appearance of one defect class (precedence via JS object
 * key insertion order), so the fix is structural rather than another
 * `delete`-then-`set` at a call site: every write to THIS map goes through
 * {@link set}, which deletes an existing key before re-inserting it so the last
 * writer is always last in iteration order. The map's internals are private and
 * {@link toObject} rebuilds a fresh object from the ordered entries, so a caller
 * cannot bypass the ordering by assigning to it.
 *
 * Scope note: this governs the `external_directory` map assembled here. It does
 * NOT govern the separate per-agent sweep in `downgradeAgentAskRules`, which
 * rewrites values in a config object the host owns. That sweep intentionally
 * mutates in place — it only changes `'ask'` to `'deny'` on keys the user
 * already wrote, and moving those keys would silently re-order the user's own
 * precedence.
 */
class LastWinsRuleMap {
	private readonly entries = new Map<string, PermissionAction>();

	/** Inserts or re-inserts `pattern` so it becomes the LAST rule. */
	set(pattern: string, action: PermissionAction): void {
		// Map preserves insertion order and `delete` frees the slot, so a
		// re-inserted key moves to the end — exactly the precedence we need.
		this.entries.delete(pattern);
		this.entries.set(pattern, action);
	}

	/** Materialises the rules as a plain object in evaluation order. */
	toObject(): Record<string, PermissionAction> {
		return Object.fromEntries(this.entries);
	}
}

/**
 * Directory names the host's skill glob accepts, mirroring
 * `SA = "{skill,skills}/**\/SKILL.md"` (binary offset 102990880). Both
 * spellings are supported for `Config.directories()` roots, so the allowlist
 * grants the pair from this one definition rather than hardcoding either.
 */
const SKILL_DIR_NAMES = ['skill', 'skills'] as const;

/**
 * Home/project skill marker directories the host scans with the PLURAL-only
 * glob `GA = "skills/**\/SKILL.md"` — verbatim `bA = ".claude"`,
 * `xA = ".agents"` (same offset).
 */
const HOST_HOME_SKILL_MARKERS = ['.claude', '.agents'] as const;

/** Result of assembling a lane's `external_directory` rule map. */
interface LaneRuleBuild {
	/** The rule map, in emission (== evaluation) order. */
	rules: Record<string, PermissionAction>;
	/**
	 * User-configured patterns whose `"ask"` was coerced to `"deny"` because a
	 * lane has no TUI that could answer an ask. Empty in the common case.
	 */
	coercedAskPatterns: string[];
}

/** An allowlisted directory plus the justification for granting it. */
interface LaneAllowlistEntry {
	/** Absolute directory path. */
	dir: string;
	/**
	 * The emitted `external_directory` rule pattern for {@link dir}.
	 *
	 * Computed ONCE here and reused by both consumers — the rule map and the
	 * `.swarm/events.jsonl` record. Deriving it twice meant a second round of
	 * `realpathSync.native` per entry on the config-hook path and, more
	 * importantly, left room for the two to disagree: if they ever did, the
	 * event log would misreport the rule that was actually emitted, which is
	 * precisely the observability this subsystem exists to provide.
	 */
	pattern: string;
	/** Why this directory is justified — recorded in `.swarm/events.jsonl`. */
	reason: string;
}

/**
 * Converts an absolute directory into the `external_directory` rule pattern
 * that covers it and everything beneath it.
 *
 * The literal part of the directory is escaped for the host's matcher. The host
 * compiles a rule pattern as:
 *
 * ```js
 * o.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*​/g,".*").replace(/\?/g,".")
 * // then: new RegExp("^"+compiled+"$","si")
 * ```
 *
 * Note what is NOT escaped: `*` and `?`. A directory legitimately named `a*`
 * (legal on POSIX) would compile to `a.*` and silently grant every sibling
 * starting with `a`; `?` becomes a single-character wildcard the same way. The
 * matcher offers no escape syntax for either, so such a directory cannot be
 * expressed exactly. {@link isExpressibleDirectory} therefore drops it from the
 * allowlist rather than emitting an over-broad grant: dropping fails safe (the
 * path is denied, and its absence is visible in the event log), emitting would
 * fail open.
 *
 * The matcher also uses the `i` flag, so patterns are case-insensitive even on
 * case-sensitive filesystems. `/home/u/Work/*` will therefore also match
 * `/home/u/work/...`. That widening is inherent to the host and cannot be
 * avoided from a rule pattern; it is recorded here so it is a known, reviewed
 * property rather than a surprise.
 */
function laneDirectoryPattern(dir: string): string {
	// MUST mirror the host. The asked pattern is produced by
	// `Filesystem.normalizePathPattern`, which realpaths the directory part; a
	// rule from config gets no such treatment (`fromConfig` only expands `~`).
	// Emitting the un-canonicalised form means a lane reached through a junction
	// or symlink is denied access to its own grant, because the two strings
	// never converge.
	return hostNormalizePathPattern(path.join(dir, '*'));
}

/**
 * True when `dir` can be expressed as an exact `external_directory` pattern.
 *
 * The host's pattern compiler does not escape `*` or `?`, so a directory whose
 * own name contains either character cannot be pinned down — any pattern we
 * emit for it would match strictly more than the directory itself. Such a
 * directory is excluded from the allowlist (fail safe) rather than granted
 * (fail open).
 */
function isExpressibleDirectory(dir: string): boolean {
	return !dir.includes('*') && !dir.includes('?');
}

function push(
	out: LaneAllowlistEntry[],
	seen: Set<string>,
	dir: string | undefined,
	reason: string,
): void {
	if (!dir) return;
	let resolved: string;
	try {
		resolved = path.resolve(dir);
	} catch {
		return;
	}
	// A directory containing `*` or `?` cannot be expressed exactly — see
	// isExpressibleDirectory. Drop it (denied) rather than emit a pattern that
	// grants more than intended.
	if (!isExpressibleDirectory(resolved)) return;
	// Deduplicate case-insensitively on Windows so the same directory reached by
	// two spellings does not produce two rules.
	const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	if (seen.has(key)) return;
	seen.add(key);
	out.push({ dir: resolved, pattern: laneDirectoryPattern(resolved), reason });
}

/**
 * Builds the justified `external_directory` allowlist for a lane.
 *
 * Every entry is a directory the lane provably needs in order to do the work it
 * was created for. Nothing is added "just in case" — an over-broad allowlist
 * here is the security cost of this fix, so each entry carries its reason and
 * is asserted in tests.
 *
 * @param lane - Resolved lane context.
 * @returns Deduplicated absolute directories with justifications.
 */
function buildLaneAllowlist(
	lane: LaneContext,
	configuredSkillPaths: readonly string[] = [],
	configuredSkillUrls: readonly string[] = [],
): LaneAllowlistEntry[] {
	const out: LaneAllowlistEntry[] = [];
	const seen = new Set<string>();

	// The project this lane is literally a git worktree of. Without this the
	// lane cannot read the sources it was branched from.
	push(
		out,
		seen,
		lane.parentProjectPath,
		'parent project the lane is a git worktree of',
	);

	// The lane itself. The host already treats the instance directory as
	// internal, but stating it makes the ruleset self-describing and keeps the
	// lane reachable if the host's own default ever narrows.
	push(out, seen, lane.lanePath, 'the lane worktree itself');

	// The OpenCode config tree the host is actually reading (global agents,
	// commands, skills). `getHostConfigDir` honours OPENCODE_CONFIG_DIR, which
	// `getPluginConfigDir` deliberately does not.
	//
	// NOTE the plugin cache/install locations (`getPluginCachePaths()`) are
	// intentionally NOT granted. `external_directory` has no read/write split,
	// so every entry here is also a WRITE grant, and a lane has no legitimate
	// reason to write to the plugin's own installed code — which the host then
	// executes in-process on the next load, outside lane teardown.
	// DELIBERATE WIDENING (not a restoration). The host's per-agent base allow is
	//   q = [A.GLOB, join(Global.Path.tmp,'*'), ...Skill.dirs(), ...config-references]
	// (Agent.state, offset 100811506; the `G` there resolves to the SKILL service —
	// the Agent chunk imports `zr as _` from chunk-mdqr1haw.js, whose `zr` is the
	// Skill namespace exposing `dirs`). OpenCode's CONFIG directories are NOT in
	// that list, so granting them is a choice we are making, justified by the lane
	// needing to read global agent/command/skill definitions.
	//
	// Both config dirs are granted because the host resolves them from two
	// different places: `ConfigPaths.directories` (offset 103303216) reads
	// `I.Path.config` — the Global namespace's static `Path`, bound to the RAW
	// object whose `config` is join(XDG_CONFIG_HOME,'opencode') WITHOUT the
	// override (offset 107378114) — and separately appends OPENCODE_CONFIG_DIR
	// when set. The override is applied only by the `y()` service factory
	// (offset 107379448). Granting one and not the other would leave a directory
	// OpenCode actually reads inaccessible.
	push(
		out,
		seen,
		getPluginConfigDir(),
		'OpenCode XDG config dir (host Global.Path.config)',
	);
	push(
		out,
		seen,
		getHostConfigDir(),
		'OpenCode config dir override (OPENCODE_CONFIG_DIR), when set',
	);

	// Temp scratch. Deliberately NOT all of `os.tmpdir()`: that is a shared,
	// world-writable-ish tree on POSIX and granting it wholesale would let a
	// lane write into any other process's temp state. Two narrow subtrees only:
	//   - `<tmpdir>/opencode`, the host's own temp area;
	//   - `<tmpdir>/swwt`, where `shortenWorktreePath()` relocates a lane when
	//     the Windows path budget is exceeded. A shortened lane's own directory
	//     is already covered by the lane entry above, but sibling lanes of the
	//     same run live under this root and lane merge-back reads across them.
	// `path.join(os.tmpdir(), 'opencode')` is exactly the host's own
	// `Global.Path.tmp` (binary offset 107378900: `jn=H.join(r.tmpdir(),W)` with
	// `W = "opencode"`), which the host base-allows for every agent. Re-granting
	// it keeps a lane no more restricted than an ordinary session.
	const tmpRoot = os.tmpdir();
	push(
		out,
		seen,
		path.join(tmpRoot, 'opencode'),
		"OpenCode's own temp dir (host Global.Path.tmp)",
	);
	// Windows only. `shortenWorktreePath` fires solely on the Windows path-budget
	// check, so on POSIX this directory is never created and granting it would be
	// a pointless write grant into a sticky-bit, world-writable tree.
	if (process.platform === 'win32') {
		push(
			out,
			seen,
			path.join(tmpRoot, 'swwt'),
			'shortened-worktree lane root (Windows path-budget fallback)',
		);
	}

	// RESTORATION: the host natively grants its `plan` agent
	// `external_directory: { join(Path.data,'plans','*'): 'allow' }`
	// (Agent.state, offset ~100812132). That rule is merged BEFORE the top-level
	// block, so our catch-all would outrank it under `findLast` and a lane
	// running `plan` would be denied its own plan storage — a clean DeniedError
	// rather than a hang, but a real documented capability lost.
	push(
		out,
		seen,
		path.join(getHostDataDir(), 'plans'),
		"OpenCode plan storage (host `plan` agent's native allow)",
	);

	// Configured skill roots, resolved against both trees the lane can legally
	// read from, plus the user-level roots OpenCode itself scans.
	//
	// Unlike the config dirs above, these ARE a restoration: the host's
	// per-agent base allow includes ...Skill.dirs() (Agent.state, offset
	// 100811506), i.e. every directory skill discovery found. Without
	// re-granting them the catch-all deny would make a lane strictly more
	// restricted than an ordinary session. The field log
	// for this defect shows the hang on
	// `C:\Users\Brett\.claude\skills\engineering-conventions\*` — a user-level
	// skill root — so these are not optional.
	let home: string | undefined;
	try {
		home = os.homedir();
	} catch {
		home = undefined;
	}

	// NOTE: the whole `~/.opencode` tree is deliberately NOT granted.
	//
	// It was originally added on the belief that the host base-allows
	// `ConfigPaths.directories()`; that turned out to be false (the per-agent
	// base allow is `Skill.dirs()`, not the config dirs). Two facts then make the
	// whole-tree grant both unnecessary and unsafe:
	//
	//  - Unnecessary: the parts a lane's AGENT actually reads are the skill
	//    roots, and BOTH `~/.opencode/skill` and `~/.opencode/skills` are granted
	//    individually below (the host's glob accepts either spelling — granting
	//    only the plural one silently denied the singular layout, which is what
	//    the whole-tree grant used to cover). Global agent/command/plugin
	//    definitions under `~/.opencode` are loaded by the HOST process: only
	//    three sites in the binary reference `permission:"external_directory"`
	//    and both enforcers are tool-side, so config loading never consults it.
	//  - Unsafe: `external_directory` has no read/write split, and OpenCode's
	//    GitLab OAuth helper (offsets 101269799, 102089082) stores credentials at
	//    `XDG_DATA_HOME ? join(XDG_DATA_HOME,'opencode','auth.json')
	//                   : join(homedir(),'.opencode','auth.json')`.
	//    With XDG_DATA_HOME unset — the default on Windows and macOS — that file
	//    sits directly inside `~/.opencode`, so granting the tree would put a
	//    credential file inside a lane's write grant.
	//
	// A user who genuinely needs more of `~/.opencode` in a lane adds an explicit
	// `permission.external_directory` allow, which always wins.
	// Mirror the HOST's skill discovery (offset 102990880) rather than encoding
	// half of it. Verbatim constants:
	//   bA = ".claude"   xA = ".agents"
	//   GA = "skills/**/SKILL.md"           <- PLURAL only
	//   SA = "{skill,skills}/**/SKILL.md"   <- singular OR plural
	// and the scan is:
	//   .claude/.agents at $HOME  -> GA
	//   .claude/.agents walked from directory to worktree -> GA
	//   every Config.directories() entry -> SA
	//
	// Granting only `skills` for a Config.directories() root silently denies the
	// supported singular `skill/` layout, which is what the removed whole-tree
	// `~/.opencode` grant used to cover. The pair is derived from one constant so
	// the two spellings cannot drift apart.
	const projectRoots = [
		{ base: lane.parentProjectPath, label: 'parent project' },
		{ base: lane.lanePath, label: 'lane' },
	];

	// (a) `.claude` / `.agents` roots — host scans PLURAL `skills` only.
	for (const marker of HOST_HOME_SKILL_MARKERS) {
		for (const { base, label } of projectRoots) {
			push(
				out,
				seen,
				path.resolve(base, marker, 'skills'),
				`skill root (${label}): ${marker}/skills`,
			);
		}
		if (home) {
			push(
				out,
				seen,
				path.resolve(home, marker, 'skills'),
				`skill root (user level): ~/${marker}/skills`,
			);
		}
	}

	// (b) Config.directories()-style roots — host scans BOTH `skill` and
	//     `skills`.
	const configSkillRoots: Array<{ base: string; label: string }> = [
		{ base: getPluginConfigDir(), label: 'XDG config dir' },
		{ base: getHostConfigDir(), label: 'config dir override' },
		...projectRoots.map(({ base, label }) => ({
			base: path.resolve(base, '.opencode'),
			label: `${label} .opencode`,
		})),
		...(home
			? [{ base: path.join(home, '.opencode'), label: 'user-level .opencode' }]
			: []),
	];
	for (const { base, label } of configSkillRoots) {
		for (const dirName of SKILL_DIR_NAMES) {
			push(
				out,
				seen,
				path.resolve(base, dirName),
				`skill root (${label}): ${dirName}/`,
			);
		}
	}

	// (c) The plugin's OWN gate list (`SKILL_SEARCH_ROOTS`). Union'd in so a root
	//     added there is granted even if the host layout above does not cover it.
	for (const relative of SKILL_SEARCH_ROOTS) {
		for (const { base, label } of projectRoots) {
			push(
				out,
				seen,
				path.resolve(base, relative),
				`skill root (${label}): ${relative}`,
			);
		}
		if (home) {
			push(
				out,
				seen,
				path.resolve(home, relative),
				`skill root (user level): ~/${relative}`,
			);
		}
	}

	// (d) Config `skills.paths`. Resolved exactly as the host does (offset
	//     102994011): `~/` expands to $HOME, a relative path anchors to the
	//     instance directory. This is a pure read of the config object the hook
	//     already holds — no I/O, so invariant 1 is unaffected. The host also
	//     `isDir`-checks each one; we deliberately do not, because granting a
	//     path that does not exist yet is harmless and a stat per entry is not.
	//
	//     `skills.urls` themselves need no per-URL handling here — their cache
	//     root is granted below.

	// (e) The URL-skill cache root. A SCOPED SUPERSET of the host's base allow —
	//     NOT a pure restoration like <data>/plans, and deliberately conditional.
	//
	//     WHY IT IS NEEDED: when `skills.urls` is configured, the host pulls each
	//     one and adds every pulled skill's directory to `Skill.dirs()` (offset
	//     ~102994300: the `skills.urls` loop calls the same `u()` helper, which
	//     does `dirs.add(dirname(match))`), and `Skill.dirs()` is part of the
	//     per-agent base allow (Agent.state, offset 100811506). Without this a
	//     lane would be denied a URL-sourced skill an ordinary session can read.
	//
	//     WHY IT IS CONDITIONAL: with no `skills.urls`, nothing under the cache
	//     is in `Skill.dirs()`, so an ordinary session evaluates this path under
	//     the base `"*": "ask"`. Granting it unconditionally would make a LANE
	//     more permissive than an ordinary session — inverting the property this
	//     whole module exists to preserve. So it is granted only when the config
	//     actually declares URLs. Reading them is a pure property access on the
	//     config object the hook already holds: no I/O, no network.
	//
	//     WHY IT IS A SUPERSET: the host base-allows `join(n,"*")` per INDIVIDUAL
	//     pulled directory; we grant the ROOT, and `*` compiles to `.*` under the
	//     `s` flag, so it covers the whole subtree — including hashed directories
	//     for URLs that were never pulled. Narrowing to the exact leaves is not
	//     available to us: v2's layout is `resolve(cache,"skills",Bun.hash(url))`
	//     (offset 103375250) and `Bun.hash` is a Bun-only API, unusable here
	//     under AGENTS.md invariant 2 (the bundle must stay Node-ESM-loadable);
	//     v1 (offset 102988349) uses a different destination scheme again.
	//
	//     CONSEQUENCE, stated plainly: `external_directory` has no read/write
	//     split, so this is a WRITE grant over that subtree. `Discovery.download`
	//     short-circuits on an existing destination
	//     (`if (yield* j.exists(T)) return !0`, offset 102988349; v2 additionally
	//     skips on a matching `.opencode-version`, offset 103375250) and
	//     destinations are deterministic. A lane can therefore pre-plant content
	//     at a path a LATER, DIFFERENT session's host will decline to overwrite
	//     and will then load as skill instructions — a cross-session write→load
	//     path. That is the same blast radius cited for excluding the plugin
	//     install dirs. It is accepted here only because the alternative is
	//     breaking URL skills in lanes outright, and only when the operator has
	//     opted into `skills.urls` at all.
	//
	//     SCOPE: `<cache>/opencode/skills` ONLY, never `<cache>/opencode`. The
	//     host defines `bin: join(cache,"bin")` (offset 107378747) and creates
	//     it at startup — a directory the host EXECUTES from. Granting the parent
	//     would put executable code inside the write grant. Same reasoning that
	//     dropped getPluginCachePaths() and narrowed os.tmpdir() above.
	const skillUrls = Array.isArray(configuredSkillUrls)
		? configuredSkillUrls
		: [];
	if (skillUrls.some((u) => typeof u === 'string' && u.trim() !== '')) {
		push(
			out,
			seen,
			getHostSkillCacheDir(),
			'URL-sourced skill cache (only because skills.urls is configured)',
		);
	}
	// Back to (d): the `skills.paths` loop. (The (e) cache grant above is a
	// single push and needs no per-entry handling, so it was placed before this
	// loop rather than after it.)
	//
	// Defence in depth for the one argument that carries user data.
	// `readConfiguredSkillList` already normalises this, but allowlist
	// construction runs on the plugin-init path, so a malformed `skills` config
	// must not be able to throw.
	//
	// Scope note, so the claim matches the code: `lane` itself is NOT guarded — a
	// null lane or a non-string `lanePath` would throw. That is unreachable by
	// construction rather than by validation: `applyLanePermissions` returns
	// early on `!lane`, `resolveLaneContext` only ever yields `path.resolve`
	// strings, and the `src/index.ts` call site wraps the whole thing in
	// try/catch. Adding a guard here would be unreachable defensive code.
	const skillPaths = Array.isArray(configuredSkillPaths)
		? configuredSkillPaths
		: [];
	for (const configured of skillPaths) {
		if (typeof configured !== 'string' || configured.trim() === '') continue;
		const expanded =
			configured.startsWith('~/') && home
				? path.join(home, configured.slice(2))
				: configured;
		push(
			out,
			seen,
			path.isAbsolute(expanded)
				? expanded
				: path.resolve(lane.lanePath, expanded),
			`configured skills.path: ${configured}`,
		);
	}

	return out;
}

/**
 * Normalises the `external_directory` value already present in a config
 * `permission` block into rule-object form.
 *
 * OpenCode accepts either a shorthand string (`"allow"`) or a pattern map. The
 * shorthand is equivalent to `{ "*": <value> }`.
 */
function normalizeExisting(
	existing: unknown,
): Record<string, PermissionAction> | undefined {
	if (typeof existing === 'string') {
		return { '*': existing as PermissionAction };
	}
	if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
		return { ...(existing as Record<string, PermissionAction>) };
	}
	return undefined;
}

/**
 * Builds the `external_directory` rule map to write into the top-level
 * `permission` block of a lane instance's config.
 *
 * Emission order (which IS the evaluation order, later-wins):
 *
 *  1. `"*": "deny"` — our catch-all, so nothing can be left pending in a lane
 *     that has no TUI to answer it. This is the only mechanism that delivers
 *     the approved policy's "answered, not hung" guarantee now that the host's
 *     `permission.ask` plugin hook is confirmed dead (never triggered by
 *     opencode 1.18.10).
 *  2. Our justified allowlist — beats the catch-all because it comes later.
 *  3. Whatever the user already configured — beats everything, because explicit
 *     user configuration must always outrank a plugin default. A user entry
 *     keyed `"*"` replaces our catch-all's value in place (same key), so
 *     `external_directory: "allow"` in `opencode.json` still means allow-all.
 *
 * ## Why `"ask"` is coerced to `"deny"` INSIDE A LANE
 *
 * A user's `allow` and `deny` are honoured verbatim. `ask` is not, and that is
 * deliberate: a lane instance has no TUI attached, so `ask` cannot be answered
 * by anyone. It is not a third policy choice there — it is a guaranteed
 * indefinite hang, which is the exact defect this module exists to remove.
 * Honouring it literally would let a top-level `external_directory: "ask"` (or
 * any `"ask"` pattern) silently reinstate the bug while this code reported
 * success. Coercion resolves to the fail-safe direction (`deny`, never
 * `allow`), the affected patterns are named in the advisory, and they are
 * recorded under `coercedAskPatterns` in the `.swarm/events.jsonl` entry so the
 * decision is auditable rather than silent. Users who genuinely want the
 * prompting behaviour back have `worktree.lane_permissions: "off"`.
 *
 * @param mode     - Configured lane permission policy.
 * @param lane     - Resolved lane context.
 * @param existing - Current `external_directory` value from the config being
 *                   mutated, if any.
 * @returns The rule map plus any patterns whose `ask` was coerced, or `null`
 *          when the policy is `off` (the caller must then touch nothing).
 */
function buildLaneExternalDirectoryRules(
	mode: LanePermissionMode,
	lane: LaneContext,
	existing?: unknown,
	// Precomputed by the caller so the allowlist is built once per lane rather
	// than twice on the plugin-init path.
	precomputedAllowlist?: readonly LaneAllowlistEntry[],
): LaneRuleBuild | null {
	if (mode === 'off') return null;

	const rules = new LastWinsRuleMap();
	rules.set('*', 'deny');

	if (mode === 'scoped_allow') {
		for (const entry of precomputedAllowlist ?? buildLaneAllowlist(lane)) {
			rules.set(entry.pattern, 'allow');
		}
	}

	const coercedAskPatterns: string[] = [];
	const user = normalizeExisting(existing);
	if (user) {
		for (const [pattern, action] of Object.entries(user)) {
			if (action === 'ask') {
				// Unanswerable in a lane — see the "Why `ask` is coerced" note above.
				coercedAskPatterns.push(pattern);
				rules.set(pattern, 'deny');
				continue;
			}
			rules.set(pattern, action);
		}
	}

	return { rules: rules.toObject(), coercedAskPatterns };
}

/**
 * Renders the operator-facing remedy text for a lane whose permissions are
 * being scoped.
 *
 * The permission system itself carries an action, not a message — a `deny` rule
 * cannot explain itself. So the explanation is delivered out-of-band (a deferred
 * warning plus a `.swarm/events.jsonl` record) and names the exact
 * `opencode.json` edit that widens the allowlist.
 */
function renderLanePermissionAdvisory(
	mode: Exclude<LanePermissionMode, 'off'>,
	lane: LaneContext,
	allowlist: readonly LaneAllowlistEntry[],
	coercedAskPatterns: readonly string[] = [],
): string {
	const scope =
		mode === 'deny'
			? 'ALL external directory access is denied in this lane'
			: `external directory access is limited to ${allowlist.length} justified path(s)`;
	const parts = [
		`[swarm] Worktree-lane permissions active for ${lane.lanePath} (worktree of ${lane.parentProjectPath}).`,
		`Policy worktree.lane_permissions="${mode}": ${scope}; anything else is denied rather than left pending.`,
		'A lane instance has no TUI attached, so an "ask" there can never be answered and would hang the lane forever.',
	];
	if (coercedAskPatterns.length > 0) {
		parts.push(
			`Your configured external_directory "ask" rule(s) [${coercedAskPatterns.join(', ')}] were treated as "deny" here for that reason — change them to "allow" if the lane needs those paths.`,
		);
	}
	parts.push(
		'To widen the allowlist, add the directory to opencode.json:',
		'  { "permission": { "external_directory": { "<absolute-dir>/*": "allow" } } }',
		'To restore the previous (hanging) behaviour, set worktree.lane_permissions to "off".',
	);
	return parts.join(' ');
}

/**
 * Tier-0 test seam (see the writing-tests skill): these are pure functions with
 * no external dependencies, so they are tested directly rather than mocked.
 * They are intentionally NOT part of the module's public API — only
 * {@link applyLanePermissions} is called from production.
 */
export const _test_exports = {
	buildLaneAllowlist,
	buildLaneExternalDirectoryRules,
	laneDirectoryPattern,
	renderLanePermissionAdvisory,
};

/**
 * Test-only dependency-injection seam (AGENTS.md invariant 7). Tests replace
 * these to assert the event record and advisory without touching the real
 * filesystem or the process-wide warning buffer. Restore in `afterEach`.
 */
export const _internals = {
	resolveLaneContext,
	addDeferredWarning,
	appendFileSync: fs.appendFileSync as (
		p: string,
		data: string,
		enc: BufferEncoding,
	) => void,
	mkdirSync: fs.mkdirSync as (
		p: string,
		opts: { recursive: boolean },
	) => string | undefined,
};

/** Outcome of {@link applyLanePermissions}, returned for tests and logging. */
export interface LanePermissionApplication {
	/** `true` when the directory was recognised as a swarm worktree lane. */
	lane: boolean;
	/** Effective policy. `undefined` when `lane` is `false`. */
	mode?: LanePermissionMode;
	/** Rules written into `permission.external_directory`, when any. */
	rules?: Record<string, PermissionAction>;
}

/**
 * Reads `skills.paths` or `skills.urls` out of the live config object the hook
 * was handed, selected by `key`.
 *
 * Pure object access — no filesystem, no network — so it is safe on the
 * plugin-init path. Anything that is not an array of strings yields an empty
 * list rather than throwing, and blank or whitespace-only entries are dropped.
 */
function readConfiguredSkillList(
	opencodeConfig: Record<string, unknown>,
	key: 'paths' | 'urls',
): string[] {
	const skills = opencodeConfig.skills;
	if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return [];
	const value = (skills as Record<string, unknown>)[key];
	if (!Array.isArray(value)) return [];
	return value.filter(
		(v): v is string => typeof v === 'string' && v.trim() !== '',
	);
}

/**
 * Rewrites every `external_directory: "ask"` in a per-agent `permission` block
 * to `"deny"`, in place, and returns the affected `<agent>.<pattern>` labels.
 *
 * Necessary because the host merges per-agent permission LAST:
 * `e.permission = a.merge(e.permission, a.fromConfig(s.permission ?? {}))`.
 * Coercing only the top-level block would therefore be trivially bypassed by
 * any agent that declares its own `external_directory` ask — the rule that
 * actually wins at evaluation time.
 *
 * Handles both accepted config shapes: the string shorthand
 * (`external_directory: "ask"`, equivalent to `{ "*": "ask" }`) and the pattern
 * map.
 */
function downgradeAgentAskRules(
	opencodeConfig: Record<string, unknown>,
): string[] {
	const coerced: string[] = [];
	const agents = opencodeConfig.agent;
	if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
		return coerced;
	}
	for (const [agentName, rawAgent] of Object.entries(
		agents as Record<string, unknown>,
	)) {
		if (!rawAgent || typeof rawAgent !== 'object' || Array.isArray(rawAgent)) {
			continue;
		}
		const agent = rawAgent as Record<string, unknown>;
		const rawPermission = agent.permission;
		if (
			!rawPermission ||
			typeof rawPermission !== 'object' ||
			Array.isArray(rawPermission)
		) {
			continue;
		}
		const agentPermission = rawPermission as Record<string, unknown>;
		const external = agentPermission.external_directory;
		if (external === 'ask') {
			agentPermission.external_directory = 'deny';
			coerced.push(`${agentName}.*`);
			continue;
		}
		if (!external || typeof external !== 'object' || Array.isArray(external)) {
			continue;
		}
		const map = external as Record<string, unknown>;
		for (const [pattern, action] of Object.entries(map)) {
			if (action !== 'ask') continue;
			map[pattern] = 'deny';
			coerced.push(`${agentName}.${pattern}`);
		}
	}
	return coerced;
}

/**
 * Appends one structured decision record to `<directory>/.swarm/events.jsonl`.
 *
 * Best-effort by design: observability must never be able to break plugin
 * initialisation. Note the lane's `.swarm/` is torn down with the worktree,
 * which is exactly why the same information is also emitted as a deferred
 * warning that survives into `/swarm diagnose`.
 */
function recordLanePermissionEvent(
	directory: string,
	event: Record<string, unknown>,
): void {
	try {
		appendCoreEventSync(directory, event);
	} catch {
		// Intentionally swallowed — see doc comment.
	}
}

/**
 * Applies scoped lane permissions to an OpenCode config object, in place.
 *
 * Called from the plugin `config` hook. When `directory` is not a swarm
 * worktree lane this returns immediately and mutates NOTHING — ordinary
 * sessions must be byte-for-byte unaffected, which
 * `tests/unit/config/lane-permissions-config.test.ts` asserts directly.
 *
 * @param opencodeConfig - The live merged config object the host handed to the
 *                         `config` hook. Mutated in place, as the hook contract
 *                         requires.
 * @param directory      - The plugin's own `ctx.directory`. Under this host that
 *                         IS the instance directory, so in a lane instance it is
 *                         the lane path.
 * @param mode           - Configured `worktree.lane_permissions` policy.
 * @returns What was decided, for logging and tests.
 */
export function applyLanePermissions(
	opencodeConfig: Record<string, unknown>,
	directory: string,
	mode: LanePermissionMode,
): LanePermissionApplication {
	const lane = _internals.resolveLaneContext(directory);
	if (!lane) return { lane: false };
	// AGENTS.md invariant 4: `.swarm/` lives at the project root, never under a
	// source subdirectory. An OpenCode instance can be bound BELOW a lane root
	// (that is why resolveLaneContext walks ancestors), and using `directory`
	// here would write `<lane>/src/.swarm/events.jsonl`. Always anchor to the
	// lane root.
	const eventRoot = lane.lanePath;
	if (mode === 'off') {
		// Explicitly opted out: record the decision so the hang is diagnosable,
		// but change nothing.
		recordLanePermissionEvent(eventRoot, {
			event: 'lane_permissions',
			timestamp: new Date().toISOString(),
			decision: 'skipped',
			mode,
			lanePath: lane.lanePath,
			parentProjectPath: lane.parentProjectPath,
			reason:
				'worktree.lane_permissions is "off"; external_directory asks in this lane cannot be answered and will hang',
		});
		return { lane: true, mode };
	}

	const permission = ((): Record<string, unknown> => {
		const current = opencodeConfig.permission;
		if (current && typeof current === 'object' && !Array.isArray(current)) {
			return current as Record<string, unknown>;
		}
		const created: Record<string, unknown> = {};
		opencodeConfig.permission = created;
		return created;
	})();

	// Per-agent `permission` is merged by the host AFTER the top-level block
	// (`e.permission = a.merge(e.permission, a.fromConfig(s.permission ?? {}))`),
	// so an `ask` left in any agent's own external_directory would outrank the
	// top-level coercion below and reinstate the hang for that agent. Sweep
	// those too.
	const agentCoerced = downgradeAgentAskRules(opencodeConfig);

	const allowlist =
		mode === 'scoped_allow'
			? buildLaneAllowlist(
					lane,
					readConfiguredSkillList(opencodeConfig, 'paths'),
					readConfiguredSkillList(opencodeConfig, 'urls'),
				)
			: [];
	const build = buildLaneExternalDirectoryRules(
		mode,
		lane,
		permission.external_directory,
		allowlist,
	);
	// `mode` is not 'off' here, so buildLaneExternalDirectoryRules never returns
	// null; the guard keeps the types honest without an assertion.
	if (!build) return { lane: true, mode };

	const { rules, coercedAskPatterns: topLevelCoerced } = build;
	permission.external_directory = rules;

	const coercedAskPatterns = [...topLevelCoerced, ...agentCoerced];
	_internals.addDeferredWarning(
		renderLanePermissionAdvisory(mode, lane, allowlist, coercedAskPatterns),
	);
	recordLanePermissionEvent(eventRoot, {
		event: 'lane_permissions',
		timestamp: new Date().toISOString(),
		decision: 'applied',
		mode,
		lanePath: lane.lanePath,
		parentProjectPath: lane.parentProjectPath,
		allowlist: allowlist.map((entry) => ({
			pattern: entry.pattern,
			reason: entry.reason,
		})),
		rules,
		coercedAskPatterns,
		remedy:
			'Add { "permission": { "external_directory": { "<absolute-dir>/*": "allow" } } } to opencode.json to widen the allowlist.',
	});

	return { lane: true, mode, rules };
}
