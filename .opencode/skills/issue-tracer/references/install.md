# Install and Version Reconciliation

This skill is distributed as ONE canonical source with thin per-agent adapters. This reference documents where each of the five supported agents discovers the skill, how user-level installs can shadow the project copy, and how to reconcile a stale copy against the canonical version stamp.

The canonical version is the `metadata.version` field in the canonical `SKILL.md` frontmatter. Treat that stamp as the source of truth: when two resolvable copies disagree on `metadata.version`, the lower one is stale and must be reconciled.

## Discovery per agent (project-level)

| Agent | Loads (project-level) | Resolves to |
|---|---|---|
| OpenCode | `.opencode/skills/issue-tracer/SKILL.md` | canonical |
| Claude Code | `.claude/skills/issue-tracer/SKILL.md` | adapter shim → canonical |
| OpenAI Codex | `.agents/skills/issue-tracer/SKILL.md` | adapter shim → canonical |
| ZCode | `.agents/skills/issue-tracer/SKILL.md` | adapter shim → canonical |
| GitHub coding agent | repo-root `AGENTS.md` pointer | canonical |

The adapter shims point to `../../../.opencode/skills/issue-tracer/SKILL.md` as the canonical workflow and add only short per-agent execution notes (tool bindings, fallback labels, publish routing); the protocol itself lives in the single canonical body, so a project checkout always executes one protocol.

### Agent Adapter table — how each row was filled

The canonical SKILL.md's Agent Adapter table maps each capability to a concrete tool per agent. Those rows were filled from each agent's current tool surface: OpenCode (`edit`/`write`, `todowrite`, `webfetch`, `task`), Claude Code (`Edit`/`Write`/`MultiEdit`, `TodoWrite`, `WebFetch`/`WebSearch`, `Agent`/`Task`), OpenAI Codex (`apply_patch`, `update_plan`, `web`, plus native fresh-context subagent dispatch), and the GitHub coding agent (`edit`, built-in task list, `web`, plus native fresh-context subagent dispatch). **ZCode** is mapped to the Codex-native tool surface (`apply_patch`/`update_plan`/`web`, plus native fresh-context subagent dispatch) because it is a Codex-family CLI that shares the project-level `.agents/skills/` discovery tree with Codex; if your ZCode build exposes different tool names, treat the table as capability-first and substitute your build's names.

## User-level installs can SHADOW the project copy

Several CLIs also search a user-level (home-directory) skills root in addition to the project root, for example:

- Claude Code: `~/.claude/skills/issue-tracer/`
- ZCode: `~/.zcode/skills/issue-tracer/`
- Codex: `~/.codex/skills/issue-tracer/` (or the runtime's configured user skills root)
- OpenCode: the user-level OpenCode config skills root

Resolution precedence between the project copy and a same-named user-level copy **varies by CLI and CLI version**, and some resolve the user-level copy first. That makes a **stale user-level copy the dangerous case**: it can silently shadow the up-to-date project canonical, so the agent runs an old protocol (missing, e.g., the Full-Resolution Contract or the Phase 4.2 sweep) while the repository looks correct. Do not assume project-wins; verify with the version stamp.

## Reconcile against `metadata.version`

Read the canonical stamp first:

```sh
grep -A2 '^metadata:' .opencode/skills/issue-tracer/SKILL.md | grep 'version:'
```

Then, for each CLI you use, compare the user-level copy's stamp to the project canonical and remove or refresh the user-level copy if it is older or absent-of-stamp (a legacy fork with no `metadata.version` is by definition stale):

```sh
# Claude Code
diff <(grep 'version:' ~/.claude/skills/issue-tracer/SKILL.md 2>/dev/null || echo 'version: none') \
     <(grep 'version:' .opencode/skills/issue-tracer/SKILL.md) \
  && echo 'in sync' || echo 'STALE user-level copy — remove ~/.claude/skills/issue-tracer or re-sync it'

# ZCode
diff <(grep 'version:' ~/.zcode/skills/issue-tracer/SKILL.md 2>/dev/null || echo 'version: none') \
     <(grep 'version:' .opencode/skills/issue-tracer/SKILL.md) \
  && echo 'in sync' || echo 'STALE user-level copy — remove ~/.zcode/skills/issue-tracer or re-sync it'

# Codex
diff <(grep 'version:' ~/.codex/skills/issue-tracer/SKILL.md 2>/dev/null || echo 'version: none') \
     <(grep 'version:' .opencode/skills/issue-tracer/SKILL.md) \
  && echo 'in sync' || echo 'STALE user-level copy — remove ~/.codex/skills/issue-tracer or re-sync it'
```

The safest default is to keep no user-level `issue-tracer` copy at all and let each project ship its own canonical, so version drift cannot occur. If you do keep a user-level copy, reconcile it whenever the project canonical's `metadata.version` changes.

Maintainer rule: bump `metadata.version` (canonical SKILL.md plus both adapter shims, in lockstep) in the same changeset as any canonical content edit — the stamp is the only reconciliation signal user-level copies have, and an unbumped edit silently defeats it.

GitHub coding agents load the repository's checked-in `AGENTS.md` and `.opencode/skills/issue-tracer/SKILL.md` directly, with no user-level home directory, so shadowing does not apply to that surface; their sessions can spawn fresh-context subagents, so the independent critic/review gates run as the preferred path there too.
