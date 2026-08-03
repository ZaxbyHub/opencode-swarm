# Worktree lanes no longer hang on unanswerable permission prompts

## What

Swarm worktree lanes now resolve their `external_directory` permissions up
front instead of raising prompts that nothing can answer.

- New `worktree.lane_permissions` setting: `"scoped_allow"` (default),
  `"deny"`, or `"off"`.
- Under `"scoped_allow"`, an OpenCode instance running inside a swarm worktree
  lane pre-grants `external_directory` access to a justified allowlist — the
  parent project the lane is a worktree of, the lane itself, both OpenCode config
  directories the host reads (the XDG one and, when set, the `OPENCODE_CONFIG_DIR`
  override), OpenCode's own temp directory, OpenCode's plan storage
  (`<data>/plans`), on Windows the shortened-worktree lane root used by the
  path-budget fallback, the URL-skill cache root
  (`$XDG_CACHE_HOME/opencode/skills`, and only when `skills.urls` is
  configured), and the configured skill roots (`.opencode/skills`,
  `.opencode/skills/generated`, `.claude/skills`) resolved against the parent
  project, the lane, and your home directory — and denies
  everything else outright, so no request can be left pending.
- Because `external_directory` has no read/write split, every allowlist entry is
  also a write grant. The list is deliberately narrow: the whole OS temp
  directory is **not** granted, nor are the plugin cache/install locations, nor
  OpenCode's data directory beyond its `plans` subdirectory. The user-level
  `~/.opencode` tree is excluded specifically because OpenCode's GitLab OAuth
  helper stores credentials at `~/.opencode/auth.json` when `XDG_DATA_HOME` is
  unset (the default on Windows and macOS); its skill subdirectories (both the
  `skill` and `skills` spellings OpenCode accepts) are granted individually
  instead.
- Skill roots mirror OpenCode's own discovery globs rather than a subset, so
  every layout it supports stays reachable from a lane. Measured:

  | Skill layout | Action in a lane |
  |---|---|
  | `~/.claude/skills/<skill>` | allow |
  | `~/.agents/skills/<skill>` | allow |
  | `~/.opencode/skills/<skill>` | allow |
  | `~/.opencode/skill/<skill>` | allow |
  | `<xdg-config>/opencode/skill/<skill>` | allow |
  | `<project>/.claude/skills/<skill>` | allow |
  | `<project>/.agents/skills/<skill>` | allow |
  | `<project>/.opencode/{skill,skills}/<skill>` | allow |
  | `$XDG_CACHE_HOME/opencode/skills/<skill>` (URL-sourced) | allow |
  | `~/.opencode` (the tree itself) | **deny** |
  | `$XDG_CACHE_HOME/opencode` (the cache parent) | **deny** |

  Directories listed in `skills.paths` are granted too, resolved exactly as
  OpenCode resolves them. URL-sourced skills (`skills.urls`) are covered too,
  but conditionally and as a superset: OpenCode caches them under
  `$XDG_CACHE_HOME/opencode/skills` and base-allows each pulled directory, so
  the lane is granted that ROOT — and only when the config actually declares
  `skills.urls`, since otherwise a lane would end up more permissive than an
  ordinary session. Because the grant covers writes and OpenCode skips a
  download whose destination exists, a lane could pre-place content a later
  session would load as a skill; that is accepted only under an explicit
  `skills.urls` opt-in. Never the cache parent, which holds the `bin/`
  directory the host executes from.
- Explicit configuration mostly wins: any `permission.external_directory` entry
  in `opencode.json` is merged after the generated rules and overrides both the
  allowlist and the catch-all deny. The one exception is `"ask"`, which is
  applied as `"deny"` **inside a lane only** — top level or per agent, string
  shorthand or pattern map. A lane has no TUI, so an `ask` there cannot be
  answered by anyone and would hang the lane indefinitely; honouring it
  literally would silently reinstate the very bug this change fixes. The
  downgraded patterns are named in the advisory and the event record. Outside a
  lane, `"ask"` is untouched.
- Lane detection keys on the worktree's git BRANCH, not its path, so it also
  covers lanes placed by a `worktree.worktree_dir` override and by the Windows
  path-budget fallback (which relocates a lane to `<os-temp>/swwt/…` with no
  user configuration). An OpenCode instance bound to a directory nested below a
  lane root resolves to that lane root. The branch match is the COMPLETE grammar
  (`swarm/<purpose>/<sessionId>/<id>` or `swarm-lane/<sessionId>/<id>`, with the
  session segment constrained to OpenCode's `ses_…` form), not a `swarm/`
  prefix — a hand-made `git worktree add -b swarm/my-experiment` is left
  completely alone. The path fallback used for a detached HEAD is equally
  tight: it requires the full provisioned shape
  `<base>/.swarm-worktrees/<sessionId>/<id>`, so a hand-made worktree placed
  inside `.swarm-worktrees` is also left alone.
- Provisioning now REFUSES, with an actionable error, to create a lane whose
  branch lane detection could not later recognise. A lane that cannot be
  recognised is a lane that would hang, so an unrecognisable one is never
  created — regardless of where its session id came from. `lean_turbo_run_phase`
  and `epic_decide_phase` additionally prefer the real session id from the tool
  context over the model-supplied argument, and reject an out-of-grammar id
  up front.
- A worktree you create yourself at exactly
  `<parent>/.swarm-worktrees/ses_<letters-and-digits>/<id>` is treated as a lane
  even on your own branch. This residual is accepted deliberately: it takes a
  lane-shaped directory name to reach, and the same leniency keeps a real lane
  recognised after you check out a different branch inside it.
- Emitted rule patterns are canonicalised with a transcription of the host's own
  `Filesystem.normalizePathPattern`, so a lane reached through a symlink or a
  Windows junction still matches its own grant.
- Because a permission rule carries an action and not a message, the plugin
  emits one advisory (visible via `/swarm diagnose`) and appends a
  `lane_permissions` record to `.swarm/events.jsonl` naming the lane, the parent
  project, the full allowlist with justifications, and the exact `opencode.json`
  edit that widens it.
- A durable source-scanning guardrail now holds an exhaustive inventory of every
  `session.create(` call site in `src/` together with the directory expression it
  passes. Any new call site — or any change to an existing one's directory
  expression — fails until a human classifies it, and foreign-directory sites
  additionally require an explicit disposition.

**Ordinary sessions are completely unaffected.** The rules apply only when the
plugin's own directory resolves as a swarm worktree lane; otherwise the config
object is not mutated at all.

## Why

OpenCode partitions **all** permission state by directory: `Permission.state`,
`Agent.state`, `Plugin.state`, and `ToolRegistry.state` are each built through
the same directory-keyed `InstanceState` cache. A swarm lane session is created
against a new directory, so it starts with an empty `approved` list — every
prior "Allow always" is forgotten — and a private pending-prompt map. No TUI is
attached to a lane instance, so an `external_directory` prompt raised there can
never be answered, and the host's `Permission.ask` awaits its deferred with no
timeout. The lane blocks until the server restarts, while the user sees the same
prompt reappear indefinitely.

Pre-resolving the permission in config prevents the prompt from ever being
raised, which is strictly better than answering it.

## Migration

No action required; the default preserves the intended behavior and fixes the
hang.

- If a lane legitimately needs a directory outside the allowlist, add it to
  `opencode.json`:

  ```json
  { "permission": { "external_directory": { "/absolute/path/*": "allow" } } }
  ```

- `worktree.lane_permissions: "deny"` restricts a lane to its own worktree.
- `worktree.lane_permissions: "off"` disables the feature and **restores the
  previous hanging behavior**. It exists only as an escape hatch.

## Caveats

- The `permission.ask` plugin hook is **not** used, because it does not work.
  It is declared in `@opencode-ai/plugin` and listed in the OpenCode binary's own
  embedded documentation, but the shipped runtime (verified against opencode
  1.18.10) never triggers it: `Plugin.trigger` dispatches by name lookup and
  `permission.ask` is absent from the complete set of names it is called with,
  and `Permission.ask` itself contains no plugin call. Registering the hook would
  have been dead code, so the fix uses the `config` hook instead.
- A deny cannot explain itself — the permission system stores an action, not
  text. The explanation is therefore delivered out of band (advisory plus
  `.swarm/events.jsonl`), not in the model-visible denial.
- Sessions created against a foreign directory that is **not** a swarm worktree
  lane are out of scope and unchanged: `src/evaluation/ephemeral-agent-dispatcher.ts`
  reaches `os.tmpdir()` roots via `src/evaluation/runner.ts` and
  `src/evaluation/gate-audit.ts`. Those can hang the same way, but applying lane
  policy to a non-lane session would violate the requirement that ordinary
  sessions are untouched. The gap is recorded, with evidence, in the new
  guardrail's inventory so it cannot be forgotten.
- One directory family that OpenCode base-allows for every agent is **not**
  re-granted inside a lane: `config.references` directories, which the plugin
  cannot resolve from the config hook. A lane will be denied access to them; add
  an explicit `permission.external_directory` allow for each. The narrowing is
  asserted in the test suite so it stays deliberate, and is documented in
  `docs/configuration.md`. The other base-allowed families — OpenCode's temp
  directory, the skill directories, and the tool-output directory — are
  preserved. The OpenCode config directories are granted as well, but that
  is a deliberate widening: OpenCode does not base-allow them for an agent.
  OpenCode's plan storage (`<data>/plans`) is re-granted too — the host natively
  allows it to the built-in `plan` agent, and the catch-all would otherwise
  outrank that.
