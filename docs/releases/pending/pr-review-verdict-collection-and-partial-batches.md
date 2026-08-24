# PR review verdict collection and partial batches

Fixes issue #2278.

This change truths up the PR review contract so reviewer and critic lanes can
be collected and settled correctly when work is split across partial retries.

## What changed for users

- Reviewer and critic batches may now own any non-empty subset of the current
  inventory, rather than requiring every retry to claim the full inventory
  again.
- Collection now validates the exact assigned verdict rows for each dispatched
  lane and records lane-atomic accepted and rejected IDs instead of deferring
  the mismatch until settlement.
- Authenticated collection receipts survive ordinary background-ledger
  compaction and process restart. They store item IDs once, stay within the
  checkpoint budget under retry pressure, and can be reconstructed only when a
  compact identity/digest/assignment-bound marker matches active lane ownership.
  Assignments whose full receipt is already over 64 KiB publish that marker
  immediately instead of leaving collection pending.
- Dispatch and gate normalization share the receipt format's 10,000-item
  assignment ceiling, so oversized assignments fail before collection begins.
- Verdict artifacts are indexed once per validation or settlement pass, keeping
  exact-row checks linear even at that boundary.
- Critic-to-reviewer row bindings use a versioned, prototype-safe key namespace,
  so valid IDs such as `__proto__` survive persistence and settlement.
- Transport and artifact-integrity failures now reject every provably assigned
  item too, so precise retry IDs are not limited to verdict-row syntax errors.
- A terminal assistant message also persists malformed-row rejections when the
  host status API is unavailable or omits the lane.
- Settlement revalidates the exact assigned row set, so completed records from
  an older plugin cannot bypass invented or surplus ID rejection after upgrade.
- Final settlement is item-based: successful batches compose by union, and the
  newest successful verdict for a given item wins.
- `DISPROVED` reviewer and critic rows are explicitly normalized to `NONE`
  severity, which keeps disprovals from masquerading as actionable findings.

## Why this matters

Before this fix, malformed reviewer or critic rows could survive collection and
only fail later, and partial retry batches could be rejected even when they
covered the remaining items correctly. That made the review workflow harder to
recover and easier to misreport.
