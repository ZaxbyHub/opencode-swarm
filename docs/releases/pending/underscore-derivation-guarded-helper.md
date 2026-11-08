---
issue: 3331
---

# One guarded derivation for agent-name identity (underscore agents, Task-route fallback, v2 apply safety)

## #3331 — Task-route advance survives nameform mismatches; discards are observable

- The pending Task model route now records the RAW dispatched agent name
  (`agentName`), and the `session.error` fallback-advance arm resolves the model
  chain from it first — the same identity the `chat.message` boundary reports —
  so a hyphen/case spelling (e.g. `code-coder`, `Coder`) can no longer make the
  advance-side and chat-side chain signatures disagree and silently discard a
  completed fallback advance.
- When a live scoped selection IS discarded by a chain-identity change, a bounded
  debug-gated diagnostic (`OPENCODE_SWARM_DEBUG=1`) now names the scope — the
  discard is never silent. First seeds stay silent.
- On OpenCode 2 hosts the advanced model is applied only through the REGISTERED
  roster key (case-insensitive resolution; skip when unregistered) — a raw
  hyphen/case spelling can no longer mint a phantom agent through the
  create-or-update editor.

## #3322 — incremental-verify matches underscore trigger agents

- The incremental-verify trigger gate derives the canonical role through the
  shared suffix-based extractor instead of a naive first-underscore split, so
  `test_engineer` and double-prefixed forms (`mega_local_test_engineer`) match
  configured trigger agents instead of only the accidental raw-name arm.

## #3330 — one guarded helper; naive helper retired

- New `deriveSwarmIdentity(agentName)` (src/config/schema.ts) is the single
  ownership point for the (role, swarm-id) derivation, with the full #3324 guard
  set: slice only on a real `_<role>` suffix, raw-case-preserving ids
  (`Case_coder` → `Case`), fail-closed to the default swarm for doubled
  separators (`local__coder`) and multi-token prefixes.
- The 11 unguarded length-delta sites (curator/skill-improver factories,
  dispatch-lanes ×3, lean turbo ×4, full-auto oversight + intercept) and the
  guarded index site now route through the helper; `learning-health`
  participation normalization uses the canonical-role derivation (compound roles
  no longer mis-derive); the route's swarm id comes from the helper rather than
  the action-digest canonicalization.
- `extractSwarmIdFromAgentName` — the helper #2960 proved defective — is retired:
  no production caller, no naive-split pins. Two documented exceptions keep their
  own contracts: `full-auto-delegation.ts` (prefix-emptiness deny policy) and
  `action-identity.ts` (invariant-9 digest canonicalization, not a swarm-id
  consumer after this change).
- New census guardrail (tests/unit/guardrails/agent-name-derivation-census.test.ts)
  fails the build if a naive first-underscore split or an unguarded length-delta
  slice reappears outside the allowlist.
