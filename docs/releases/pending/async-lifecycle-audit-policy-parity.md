# async lifecycle r11–r13 audit repair III: policy parity and bounded event fan-out

## What

Third batch of the independent source audit repairs for the native
OpenCode-2.3 async subagent lifecycle (the explicit plan-gate intent
classification, P2-1, shipped in the first batch's fragment).

### P1-3 — the sounding-board caller category was lost on the async path

The synchronous Task handoff applied
`applySoundingBoardResponsePolicy(rawResponse, afterCtx.args)` — the
architect-owned `category` metadata reached the parser. The async completion
path called the same parser WITHOUT the args, so the explicit category the
architect supplied at dispatch was lost, and model free text decided the
category (including the always-surface stickiness of `UNNECESSARY`).

The validated caller category is now persisted on the delegation record at
dispatch time (`soundingBoardCategory`, bound to the exact call/child
identity; only the explicit `category` field counts, normalized, and only
when it is a real protocol category — invalid or missing values fall back
conservatively). The async closeout feeds it to the SAME shared parser as
the sync transport. The always-surface rules are preserved exactly: an
always-surface caller category surfaces a model `UNNECESSARY` as `APPROVED`;
an ordinary category keeps `UNNECESSARY` sticky; a missing category can
never preserve `UNNECESSARY`.

### P1-4 — a hanging event consumer could starve the completion observer

`dispatchEventConsumerIsolated` contained THROWN errors but awaited each
consumer's promise unboundedly: a consumer whose promise never resolved
(e.g. a wedged `prWorkflowResponseGate.event`) blocked every later consumer —
including the durable background completion observer. The wait is now
bounded (10 s default; 60 s for the completion observer, whose settlement
chain performs real durable work). An abandoned consumer keeps running in the
background; its eventual outcome is observed — a late rejection is reported
through the same bounded warning path, never an unhandled rejection. Recovery
of a completion lost to the budget remains the observer's own durable replay
machinery.

### P2-3 — the architecture documentation now states what is actually proven

`docs/architecture/async-lifecycle.md` gained a durable-closeout-journal
section (new section 6a) describing which transitions are durable, which side
effects are idempotent-durable vs claim-guarded vs at-least-once telemetry,
the recovery triggers (maintenance points, `reconcilePending`, consumed
records with pending steps, the in-flight guard), the behavior on corrupted
stores, and the guarantees NOT claimed (no general exactly-once across
non-transactional sinks; the plan-critic binding verifies against plan.json,
not against a plan copy inlined into the prompt; the async context-map
`task_goal` limitation). The r11–r13 sections were revised to reflect the
audit repairs instead of the superseded fresh-claim semantics.

## Why

Policy parity: the architect's explicit decision metadata is a protocol
input, not a suggestion — losing it on one transport means the two transports
render different verdicts for the identical dispatch. Fan-out: the event hook
is the delivery path for trusted completions; an unbounded await on ANY
independent consumer makes the whole plugin's completion processing
hostage to that consumer.

## Testing

- tests/unit/background/sounding-board-category-parity.test.ts — caller
  category wins over model text, always-surface `UNNECESSARY` matrix,
  conservative fallback, replay/restart determinism, parallel children with
  distinct categories (no swap).
- tests/unit/index-issue-2491-sounding-board.test.ts — the persistence
  validator (`validSoundingBoardCallerCategory`) including the
  never-scavenge-from-prompt rule.
- tests/unit/index-event-fanout-isolation.test.ts — a permanently hanging
  consumer cannot block the fan-out; late settlement reports visibly without
  an unhandled rejection; concurrent events do not serialize on a hung
  sibling.
