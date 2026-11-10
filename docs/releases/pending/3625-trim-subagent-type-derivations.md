# Trim `subagent_type` identity derivations (route role + incremental-verify trigger gate)

## What changed

- `src/index.ts` (route registration in the `tool.execute.before` Task handler):
  the pending model route's `role` is now derived via
  `stripKnownSwarmPrefix(toolBeforeArgs.subagent_type.trim())` — the same
  one-token trim the sibling `swarmID` derivation already applies — instead of
  feeding the raw `subagent_type` spelling to the suffix extractor.
- `src/hooks/incremental-verify.ts` (trigger gate): the dispatched
  `subagent_type` is trimmed once at extraction, and all three trigger-match
  forms (canonical role, raw name, base-compat prefix-stripped form) derive
  from the trimmed spelling.
- New regression legs:
  - `tests/unit/index-task-model-routing-v2-apply-gate.test.ts`
    `padded-role-parity (#3625)` — dispatches `' Case_coder '` and asserts the
    stored route role equals `resolveTaskRouteModelChain`'s trimmed derivation
    (`coder`), and end-to-end that the chat boundary matches the route so the
    advanced fallback lands instead of a `mismatch` no-op.
  - `tests/unit/hooks/incremental-verify-negative-trigger.test.ts`
    `padded-trigger (#3625)` — whitespace-padded dispatches match configured
    `triggerAgents` entries through the canonical, raw-name, and base-compat
    forms, and a padded suffix near-miss (`' Case_test_engineer '` against
    `engineer`) stays gated.

## Why

Follow-up from PR #3617 (issue #3625): two sites still fed the raw
`subagent_type` spelling into suffix-based identity extraction, so a
whitespace-padded dispatched name (e.g. `' Case_coder '`) derived a different
identity than the same dispatch trimmed. `getCanonicalAgentRole`'s suffix scan
cannot recognize a real `_<role>` ending through surrounding whitespace, so:

- the stored `route.role` kept the padded spelling while
  `resolveTaskRouteModelChain` derives the bare role, making
  `resolveTaskChatModelOverride` return `mismatch` at the chat boundary (the
  route's fallback never applied); and
- a `subagent_type` with trailing whitespace matched no unpadded configured `triggerAgents` entry on any
  of the three incremental-verify trigger arms.

Both paths are unreachable with today's host (the v1 and v2 hosts resolve the
Task subagent by exact lookup before any child session exists, with no trim
anywhere), so this is belt-and-braces parity with the documented contract —
the derivations now match "the same identity the chat boundary reports" and
survive a future host that tolerates whitespace or aliases.

## Migration steps

No config key, schema, or public tool surface changed. One behavior change is
user-visible: a `triggerAgents` entry that is itself spelled with surrounding
whitespace (for example `' coder '`) matched an identically padded dispatch
before this change and no longer matches, because configured entries are not
trimmed. Remove the surrounding whitespace from any such entry.

## Known caveats

- Unchanged by design (out of scope per the issue): PRR-008 duplicate-advance
  hardening and the partial-v2-host advisory edge remain RECORD items in the
  PR #3617 body; route-registration `swarmID` was already trimmed by PR #3617.
- The stored route `agentName` still receives the raw dispatched string;
  `normalizeRoute` (`src/models/task-model-routing.ts`) trims it on write, so
  behavior is unchanged there.
- A padded dispatch whose fallback chain is exhausted now fails closed with
  `MODEL_FALLBACK_EXHAUSTED` at the chat boundary. Before this change the role
  mismatch made the boundary ignore the route. An
  unpadded dispatch with an exhausted chain already behaved this way. The host
  does not currently produce padded names.
- A malformed leading-whitespace name such as `'  _coder'` no longer matches
  trigger `coder`, because the trimmed `_coder` has no swarm prefix.
- A whitespace-only `subagent_type` now trims to `''` and can match a
  trigger entry that is itself `''`. Only an empty-string config entry can
  produce this.
