# Claude Code Swarm Mode

> **For this repository, [AGENTS.md](./AGENTS.md) is the root engineering contract. Read it before any code change.** The long-form rationale and historical failure map live in [`docs/engineering-invariants.md`](./docs/engineering-invariants.md). When swarm mode is enabled, `AGENTS.md` still applies; swarm-mode instructions add workflow structure, not exceptions to the engineering invariants.

Normal behavior is the default.

If `.claude/session/swarm-mode.md` exists, swarm mode is enabled for the current session and you must read that file before starting complex work.

When swarm mode is enabled:
- Quality is the only success metric.
- There is no time pressure.
- Do not compress a workflow just because the task is large.
- Prefer parallel subagents for disjoint investigation and review work.
- Keep implementation, validation, and final judgment in separate contexts when possible.
- Explorer-style work is for breadth and candidate generation.
- Reviewer-style work is for validation of candidate findings or implementation quality.
- Critic-style work is for final challenge of reviewer-confirmed findings or high-impact implementation conclusions.
- Do not let the same context both invent and approve a finding when a separate verification pass is possible.
- No approval without positive evidence of what was checked.
- No high-severity finding without exact evidence and, when relevant, runtime-aware verification.
- Preserve Claude Code speed by parallelizing broadly and reserving the deepest validation for high-risk or ambiguous work.
- Across many different repositories, explore local patterns first rather than assuming one project's conventions apply to another.

If `.claude/session/swarm-mode.md` does not exist, behave normally.

## Permanent project directives (do not override)

These directives were explicitly requested by the project owner and persist across all
sessions, contributors, and agents. They are not workflow preferences — they are
correctness gates.

1. **We never defer work.** Optional or background-flavored work is never silently dropped
   onto a fire-and-forget microtask, a "later" todo, or an untracked follow-up. If a result
   is needed by a downstream step, test, or user, the work is done as real, reachable,
   verifiable work — either awaited in-band or scheduled through a real durable task that
   is tracked to completion. "Defer" is never a synonym for "skip." A deferred task whose
   output is consumed must be observable and verifiable.

2. **We never ship unwired code.** Every new tool, transition, status, hook, command,
   agent-map entry, or new code path is wired end-to-end before a change is considered
   complete: export → plugin registration → tool/agent map entry → help/docs surface →
   test coverage. Dead exports, orphan transitions, unregistered tools, status enums with
   no producer/consumer, and untested branches count as unwired code and are blockers —
   not polish items for a later PR.

## graphify

This project has a knowledge graph with god nodes, community structure, and cross-file
relationships. It lives in `graphify-out/` in the **primary checkout only** and is
gitignored — it is a 30MB build artifact, not source. The `/graphify` skill lives at
`.claude/skills/graphify/SKILL.md`.

**Resolving the graph path (works in the primary checkout AND in every linked worktree):**

```bash
GRAPH="$(dirname "$(git rev-parse --git-common-dir)")/graphify-out/graph.json"
```

In the primary checkout this resolves to `./graphify-out/graph.json`; inside a
`.claude/worktrees/<name>/` checkout it resolves to the primary's absolute path. Always pass
`--graph "$GRAPH"` — a bare `graphify query` resolves `graphify-out/` relative to the cwd and
finds nothing in a worktree.

> **Worktrees must not build their own graph.** graphify's own git hooks are *not*
> worktree-aware in the installed build (0.8.47), and git shares one hooks directory across
> all worktrees, so a commit inside a worktree would rebuild a rogue worktree-local
> `graphify-out/` that shadows the primary graph and goes stale silently. A guard that exits
> when `git-dir != git-common-dir` is patched into `.git/hooks/post-commit` and
> `post-checkout`.
>
> `.git/hooks` is **not tracked**, so the guard does not survive a fresh clone. After cloning
> (or any time `graphify hook install` writes the hooks fresh), run:
>
> ```bash
> sh .claude/skills/graphify/install-hook-guard.sh
> ```
>
> It is idempotent and safe to run any time. Verified: `graphify hook install` is a no-op when
> the hooks already exist, so it does *not* clobber the guard — but on a fresh clone it
> installs unguarded hooks, which is what this script repairs.

Rules:
- For codebase questions, first run `graphify query "<question>" --graph "$GRAPH"` when that
  file exists. Use `graphify path "<A>" "<B>" --graph "$GRAPH"` for relationships and
  `graphify explain "<concept>" --graph "$GRAPH"` for focused concepts. These return a scoped
  subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Treat results as orientation, not proof. The graph is AST-only (no semantic/LLM edges), so
  it maps structure and doc headings well but does not capture runtime behavior. Confirm any
  load-bearing claim against the actual source before acting on it.
- Read `GRAPH_REPORT.md` (next to graph.json) only for broad architecture review, or when
  query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` **from the primary checkout** to refresh the
  graph (AST-only, no API cost). A post-commit hook does this automatically there.
- If the graph is missing entirely, build it with `graphify update .` in the primary checkout
  (~10 min, no API cost). Never build one inside a worktree — a worktree-local
  `graphify-out/` shadows the primary and goes stale silently.
