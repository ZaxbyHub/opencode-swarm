# Guardrails: gate three advisory injections that fire on healthy sessions

## What

A static sweep of the advisory-injection subsystem found **67 producer sites
across 16 files**, of which roughly **51 have no gate at all** — they push into
the user-visible advisory queue unconditionally once their trigger fires. The
defect class:

> An injection that is **throttled** (chooses *which* text to inject) or merely
> conditional on its *trigger*, but never **gated** (has no condition that can
> suppress the injection entirely), and/or injects content-free payloads.

This ships the three that a healthy session was guaranteed to trip. The
remaining ~48 sites, two confirmed dead-code findings, and a classifier false
positive are tracked in **#1976** with full file:line evidence.

### 1. A delegating architect was told it might be stuck

The no-op work detector warns after N tool calls with no file modification. Two
facts made that guaranteed to misfire:

- the counter is keyed by `input.sessionID`, and a subagent's writes land under a
  **different** sessionID, so lane writes could never reset the architect's count;
- `Task` is not in `WRITE_TOOL_NAMES`, so delegating did not reset it either.

An architect that orchestrates and reads therefore climbed toward the warning
forever — in **every** mode, not just PR review: deep-dive, council, research,
consult, discover, issue tracing, plain planning.

A subagent dispatch now counts as progress. Both mechanisms are covered:
`Task` with a `subagent_type`, and `dispatch_lanes` / `dispatch_lanes_async`.
That second half is load-bearing — `/swarm pr-review` dispatches its lanes
through `dispatch_lanes_async` while the `task` tool is **blocked outright** by
the PR_REVIEW gate, so keying on `Task` alone would have left the originally
reported case unfixed.

The advisory text also dropped its `/swarm handoff` suggestion. Handoff resets
the session, discarding exactly the context an orchestrating architect has been
assembling; advice that destroys the user's work is worse than no advice. It now
says to state the blocker and report `BLOCKED`.

### 2. A clean repo was told about work that did not happen

`writeAdvisoryFile(...)` is called on the happy path of **every** plugin init
with `attempted` as a literal `true`, and it stores `prunedWorktrees: attempted`.
So a repo with zero orphans still produced an advisory whose only "content" was
that flag, and the hook emitted:

```
[INIT ORPHAN RECOVERY] Plugin init detected the following at <timestamp>:
  Stale worktree metadata pruned.
```

Two lines of zero information at the top of the architect's system message, once
per session, on every project. An emptiness gate now suppresses the advisory
unless there are warnings, errors, or something actually reclaimed.
`prunedWorktrees` deliberately does not count — it is true on every successful
init, so gating on it would suppress nothing.

The gate changes what is **said**, never what is **cleaned up**: the consume
marker and the file delete both still run.

### 3. The shared advisory drain had no hygiene

All ~67 producers feed one bare `string[]` with no push wrapper and no cap, and
only 5 of them dedupe — each with its own ad-hoc key. The single architect drain
concatenated everything verbatim. It now drops blank entries and collapses exact
duplicates (preserving first-occurrence order), and emits no `[ADVISORIES]`
wrapper when nothing survives — an empty wrapper would itself be the
content-free injection the rule exists to remove. Only **exact** duplicates
collapse; advisories differing by task id, lane id, or count all survive.

Two related fixes ship alongside it:

- **The queue clear was moved inside the `if (textPart)` guard.** It previously
  ran unconditionally, so a system message carrying no string text part silently
  destroyed the entire queue unread.
- **The runaway-output dedupe predicate now matches its own message.** It tested
  for the string `'runaway output'`, which no producer in `src/` ever emits —
  including the advisory it guards. The guard was permanently inert and the
  advisory re-pushed on every qualifying transform. Text and predicate now share
  one constant so they cannot drift apart again. The drain-level dedupe does
  **not** cover this case, because the message embeds a varying `${count}`.

### 4. Defensive reads in the orphan-recovery renderer

`readAdvisoryFile` does a bare `JSON.parse(content) as InitOrphanAdvisory` with
no runtime validation, so a partially-shaped file can be missing fields the type
declares required — and the file is deleted *before* those fields are read. An
advisory that passed the emptiness gate on one field while missing another used
to throw, losing the payload. Every field in the render block is now read
defensively.

Scope note: this covers **missing** fields. A type-confused file (say
`warnings: {}`) still throws; that shape is not producible by
`writeAdvisoryFile`, which always writes arrays. The throw is also caught by
`safeHook` in the hook composition chain, so it degrades to a warning rather
than breaking the transform.

## Why

A read-only review has zero writes and zero QA gates **by design**. Every one of
these detectors conditions on its trigger and at most throttles repetition; none
asks whether this is the kind of session where the absence of writes means
anything is wrong. So the guardrails read a correct review as a stuck session,
and told the user so.

## Migration

No breaking changes.

- The no-op advisory still fires for a session that only reads and never
  delegates — that is the stuck case it exists for. A regression test pins this
  so the fix cannot over-reach into silence.
- Its wording changed; anything asserting the old `/swarm handoff` text needs
  updating. `docs/releases/v6.33.1.md` is annotated as superseded.
- Orphan-recovery advisories with real content are unchanged.
- Known trade-off: because the drain now only clears what it actually emitted, a
  session whose system message *persistently* lacks a string text part retains
  advisories instead of discarding them. Judged better than the previous silent
  total discard — in that scenario every other injection into that message is
  equally undeliverable — but the queue still has no hard cap. Tracked in #1976.

## Invariant audit

- **Invariant 8 (module-level session state).** `toolCallsSinceLastWrite` and
  `noOpWarningIssued` (`src/hooks/guardrails/index.ts`) were module-level,
  session-keyed, and **unbounded** — they grew for the lifetime of the plugin
  process. Both are now FIFO-bounded at `MAX_TRACKED_NO_OP_SESSIONS` (200) with
  `evictNoOpStateIfOverBound()` called at every insertion site, mirroring the
  discipline the PR-workflow response gate uses. Evicting a stale session's
  counter is harmless: the detector simply restarts counting for it. The paired
  warning latch is dropped with the counter so an evicted session cannot return
  with a stale "already warned" flag and never warn again.
  No new module-level state is introduced by this change.
- **Invariant 10 (chat/system-message contract).** This change reduces
  chat-visible diagnostic noise; it adds none. The `[ADVISORIES]` block is now
  blank-free and deduped, one guaranteed content-free advisory is suppressed
  entirely, and the drain's create-a-system-message path is untouched, so
  `consolidateSystemMessages` behavior is unchanged. The non-architect drain
  branch — whose unconditional clear is deliberate and test-asserted, and is
  itself the v6.30.1 fix — is byte-identical to `main`.
- **Invariant 11 (tool/skill coherence).** No tool, agent, command, status, or
  transition is added or renamed; no registration surface changes.
