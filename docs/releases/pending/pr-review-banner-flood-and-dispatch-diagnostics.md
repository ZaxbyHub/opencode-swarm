# PR-review: stop the workflow-banner flood and make dispatch rejections actionable

## What

Two independent defects found by tracing a real `/swarm pr-review` session on
PR #1963, run **after** the banner-cooldown change (`845cc4b`) had shipped.

### 1. The workflow-active banner flooded the transcript

Measured directly from that session's transcript (2,005 lines):

| metric | value |
|---|---|
| lines that were only the short marker `--- [PR_REVIEW WORKFLOW ACTIVE] ---` | 968 |
| lines that were the full multi-line banner | 47 |
| **injected banner as a share of all non-blank lines** | **55.3%** |
| injected banner as a share of transcript characters | 39.9% |
| longest unbroken run of banner-only lines | 95 |

`845cc4b` added a 20-second per-session cooldown, and it worked exactly as
designed — the observed 47:968 full-to-short ratio is the cooldown doing its job.
That was the problem: the cooldown only chose **which** string to inject. It
never chose **whether** to inject. `experimental.text.complete` still mutated
every text part of every gated turn, including parts with no text in them at all
— which is what produced the marker-only runs.

This violated the repo's own contract, `AGENTS.md` invariant 10: *"Do not emit
diagnostic noise into chat-visible streams."*

Injection is now bounded on three independent axes:

1. **Blank parts are left untouched.** A banner labelling no content
   communicates nothing. This alone accounts for the large majority of the
   removed injections.
2. **Text that already opens with a banner is never re-decorated.** The check is
   anchored at the start of the part, so a reviewer lane quoting this repo's own
   banner literal mid-part is untouched.
3. **At most one injection per assistant `messageID`.** The host supplies
   `messageID` on every invocation and one assistant message spans the whole
   multi-step loop, so this is what collapses a burst of parts into a single
   user-facing notice.

The 20-second cooldown is retained, now purely to choose whether that one
injection is the full banner or the short marker. Suspended and user-interrupted
sessions still bypass the cooldown so their recovery notices are never
downgraded — they are re-armed on every message, which is what "always visible"
requires; repeating them on every *part* of a message never was.

For the reproduced session shape (10 messages × 30 parts, every third blank)
this is **10 injections instead of 300**.

**Note on a stale premise.** The cooldown was documented as unavoidable because
"the input event exposes only `{ sessionID }` — there is NO message/part ID".
That was false against the pinned host contract: `@opencode-ai/plugin@1.18.3`
declares `experimental.text.complete` as receiving
`{ sessionID, messageID, partID }`, all required. The handler's own parameter
type had narrowed them away, which made the comment self-confirming. The type is
widened and the comments corrected.

### 2. `dispatch_lanes_async` rejected valid dispatches without saying why

In the same session a capable model spent four `dispatch_lanes_async` calls
brute-forcing one parameter. It passed the correct merge base every time;
`base_ref=refs/heads/main` and `base_ref=main` were rejected, `origin/main` was
accepted. Its reasoning was sound throughout — it re-verified the merge base
twice and confirmed its value was right — but the rejection was always the same
sentence, naming neither the value the controller computed nor the value it
received:

> `BLOCKED: PR_REVIEW base_sha is not the exact merge base of base_ref and pr_head_sha`

The underlying cause is ref freshness: the merge base is recomputed with
`git merge-base -- <base_ref> <pr_head_sha>` against the **local** repository,
and the PR-review preflight fetches only `refs/pull/<N>/head` — never the base
branch. A local `main` is therefore only as current as the last fetch, and
resolves to a different merge base than `origin/main` for the same `base_sha`.
The skill text made this worse by listing `origin/main` and `main` as
interchangeable.

Fixed on four surfaces:

- **The rejection now prints its receipt** — the computed merge base, the
  `base_sha` that was passed, the ref, the directory, the stale-local-ref cause,
  and a copy-pasteable `git -C … merge-base` command. This matches the
  diagnostic style already used by `write-pr-review-trigger-eval` and
  `assertCurrentCheckoutHead`; `dispatch_lanes_async` — the tool a controller
  hits first — had the worst message of the three.
- **"Ref did not resolve" and "SHA mismatch" are now separate errors.** They were
  collapsed into one string, so a caller whose ref never resolved was told their
  `base_sha` was wrong.
- **The four PR-gating parameters are documented.** `pr_head_sha`, `base_sha`,
  `base_ref`, and `mode` previously carried no `.describe()` at all while every
  neighbouring field did, and the tool description never mentioned PR review.
  `base_ref` now states the remote-tracking requirement and why a local ref
  differs; `base_sha` distinguishes the merge base from the base-branch tip.
- **A bare, colon-less `mode` is rejected by name.** `mode: "swarm-pr-review"` —
  the exact value the old description advertised — silently skipped the
  merge-base bind and surfaced much later as *"exact merge-base scope was not
  verified"*, blaming the merge base for what was a mode-string typo. The
  accepted colon-suffixed stages are now enumerated in the schema.

The skill preflight gains an explicit `git fetch origin <base-branch>` step, and
the dispatch instruction pins the remote-tracking ref form.

## Why

Both defects burned user time and tokens on a workflow whose whole purpose is to
be cheaper than a manual review. The banner flood cost roughly 10,800 tokens of
pure banner in a single visible transcript excerpt, and because history is
resent every turn the cumulative billed cost across that session was on the
order of 92,000 tokens. The dispatch rejection cost four round trips and several
hundred lines of reasoning to discover a fact the error message already knew.

## Migration

No breaking changes.

- The banner still appears on every gated user-facing turn; it no longer repeats
  within a turn. It lands on the first substantive part of the message, which for
  a long agentic turn can sit well above the final text — a deliberate trade-off,
  since detecting the "terminal-looking" part is a fragile heuristic and the gate
  is tool-gated (`complete_pr_workflow` / `abort_pr_workflow`), not text-gated.
- A previously asserted behavior is deliberately reversed: banners no longer
  appear on empty text parts. The test that pinned it is inverted, with the
  measurement above recorded as the justification.
- `dispatch_lanes_async` accepts exactly the same valid inputs as before; only
  rejection messages, parameter descriptions, and the bare-mode case changed.
  Callers already passing a remote-tracking `base_ref` are unaffected.

## Invariant audit

- **Invariant 8 (module-level session state).** Two new module-level maps
  (`banneredMessages`, `fallbackInjections`) are keyed by `sessionID`, FIFO-evicted
  at `MAX_TRACKED_WAKE_SESSIONS`, and cleared in `resetBudget` alongside the
  existing maps — same discipline as `wakeBudgets` and `bannerStamps`.
- **Invariant 10 (chat/system message contract).** This change is what brings the
  gate back into compliance: injected banner text fell from 55.3% of non-blank
  transcript lines to one notice per turn. No new chat-visible diagnostic output
  is added. The hook registration at `src/index.ts` is unchanged, preserving the
  static assertion in `hook-composition.test.ts`.
- **Invariant 11 (tool/skill coherence).** `dispatch_lanes_async` gains no new
  parameters — only descriptions — so the tool map, manifest, and agent map are
  unchanged. The `swarm-pr-review` skill edits pass `bun run drift:check`.

## Recurrence guardrail

The defect class is *"a user-visible injection hook that is throttled — choosing
which text to inject — but never gated, choosing whether to inject at all."*

`tests/unit/hooks/pr-workflow-response-gate-banner-dedupe.test.ts` adds a
guardrail written against the observable outcome rather than any internal
mechanism: it drives a realistic gated turn (10 messages × 30 parts, every third
blank) and asserts total injections scale with messages, never with parts. It is
verified to bite — neutralizing the three suppression branches fails it, and four
other behavioral tests, and restoring them returns the suite to green.

## Post-review additions

An independent implementation review returned `NEEDS_REVISION`; both blockers
are closed here.

- **`mode` is normalized once, at the parse boundary.** The bare-mode guard
  trimmed its input while roughly twenty downstream `startsWith` / strict-equality
  branches did not, so `" swarm-pr-review:base"` passed the new guard, failed
  every `startsWith('swarm-pr-review:')` check, skipped the merge-base bind, and
  surfaced as *"exact merge-base scope was not verified"* — the same
  typo-blamed-on-the-merge-base failure this change set out to eliminate.
  Normalizing in one place closes the whole near-miss family instead of one
  literal at a time. Covered by a regression test verified to fail without it.
- **Bound documentation corrected, and eviction moved to the insert site.**
  `MAX_TRACKED_WAKE_SESSIONS` was documented as shared with one map when three
  now share it, and `evictBannerStampsIfOverBound` was named for one map while
  evicting three (renamed `evictBannerDedupeMapsIfOverBound`). `fallbackInjections`
  was bounded only incidentally — a new key was always followed by the eviction on
  the full-banner path, but that argument ran three branches deep and any early
  return added between them would have silently unbounded the map. Invariant 8
  now holds structurally.
- **Two test titles rescoped.** Both omit `messageID` and therefore exercise the
  defensive fallback path; their titles claimed suspended/interrupted sessions
  banner "every part", which is no longer true under the real host contract. They
  now state what they actually assert: that `forceFullBanner` prevents a
  downgrade to the short marker.

Two behavior changes were reviewed and accepted knowingly rather than fixed:

- **A mid-message interruption delays its recovery notice by one turn.** If the
  user interrupts after the message's first part was already bannered, the
  per-message dedupe suppresses the notice for the rest of that message; it
  appears on the next assistant message. The gate is tool-gated
  (`complete_pr_workflow` / `abort_pr_workflow` in `pr-workflow-gate.ts`), not
  text-gated, so nothing about enforcement depends on the banner.
- **The banner lands on the first substantive part, not the terminal-looking
  one.** A short preamble can carry the banner while the verdict-shaped final
  part carries nothing. Detecting the "terminal-looking" part is a fragile
  heuristic; the safety boundary is unaffected for the same reason as above.
