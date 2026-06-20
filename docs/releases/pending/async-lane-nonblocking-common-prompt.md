fix(architect): non-blocking advisory-lane dispatch + common_prompt for compact lane payloads

What changed:
- The architect base prompt now has an explicit NON-BLOCKING read-only advisory-lane
  reflex: dispatch read-only exploration/review lanes with `dispatch_lanes_async`, record
  the `batch_id`, keep doing non-dependent work, then join with
  `collect_lane_results(wait: true)`. This is surgically carved out from the
  "ONE agent per message. Send, STOP, wait" rule, which still governs coder,
  test_engineer/reviewer Stage B completion gates, and the critic plan gate.
- `dispatch_lanes` and `dispatch_lanes_async` gain an optional `common_prompt` field.
  Shared context (PR diff, obligation ledger, scope) can be sent ONCE and is prepended
  server-side to each lane prompt, so per-lane prompts carry only their focus delta. This
  shrinks the model's emitted tool-call JSON and avoids the truncated/malformed dispatch
  calls (and "write JSON to a file" workarounds) that occurred with large inlined prompts.
- Tool descriptions and the swarm-pr-review / deep-dive / deep-research / council skill
  docs were updated to a consistent story: async = non-blocking + keep working; blocking
  `dispatch_lanes` = fallback only; keep lane prompts compact via `common_prompt`; the
  mechanism is a single `dispatch_lanes_async` call, not a Task/run_in_background pattern.

Why:
- The architect "sat and waited" on background explorer lanes (used blocking dispatch or
  idled), and produced bad/truncated dispatch JSON from oversized inlined prompts — on
  smaller models the dispatch tool call was truncated out of the message entirely so no
  lanes launched.

Migration: none. `common_prompt` is optional and backward-compatible.

Caveats: steering a non-deterministic model is probabilistic; `common_prompt` reduces the
output the model must emit before the call but is mitigation, not a guarantee on weak
models. Broader agent-prompt drift surfaced during the audit is tracked in issue #1445.
