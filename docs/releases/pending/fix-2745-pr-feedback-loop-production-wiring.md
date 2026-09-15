# PR feedback-loop production wiring (issue #2745)

## What changed

- Wired loop settlement and canonical reactivation behind the existing triple
  opt-in: `pr_monitor.enabled`, `pr_monitor.auto_pr_feedback`, and
  `pr_feedback_loop.enabled`.
- The pre-existing two-flag subscriber path still activates `PR_FEEDBACK`
  before oversight; this change connects the #2745 settlement and canonical
  reactivation gates after that initial activation.
- Added authenticated, per-root current-head lookup and isolated read-only
  critic oversight. Authorization, cancellation, and oversight-evidence
  failures now fail closed before an action can run.
- Made prompt/advisory delivery per-root, ordered after acceptance, deduplicated,
  and truthful about what was delivered. Flag-disabled configurations retain
  their prior behavior, and the loop does not publish PR comments automatically.

## Why

The feedback-loop stages existed but were not connected to the production
runtime: the default head evaluator returned no head and the production
dispatch/delivery seams were inert. This wiring makes the opt-in path usable
without weakening the existing safety gates or allowing cross-root delivery.

## Migration

No migration is required. Enable all three PR feedback-loop flags to opt in to
the new settlement/reactivation path; leaving any flag disabled preserves the
previous behavior.

## Known caveats

The loop remains fail closed when the authenticated GitHub lookup, read-only
critic, durable claim, cancellation check, evidence write, or configured
prompt/advisory channel is unavailable. No automatic PR publication is added.
Live exact-owner reservations prevent duplicate actions; a dead owner can be
recovered only before the side-effect start marker is durable. Once that marker
exists, uncertainty fails closed and pauses for human inspection rather than
replaying the action.
