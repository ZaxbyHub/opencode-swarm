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
- When a live scoped selection is discarded by a chain-identity change, a
  bounded debug-gated diagnostic (`OPENCODE_SWARM_DEBUG=1`) now names the scope
  and the discarded fallback index. First seeds stay silent. Note the
  diagnostic is debug-gated: without that env var set, the reseed is not
  logged (#3617 review F-06b wording correction).
- On OpenCode 2 hosts the advanced model is applied only through the REGISTERED
  roster key: the exact spelling wins; a case-insensitive match is honored only
  when UNIQUE; a case-colliding roster pair (e.g. swarms `Local` and `local`)
  skips the sticky apply with a diagnostic instead of silently writing
  whichever colliding key hashed first (#3617 review PRR-001). An unregistered
  spelling also skips with a diagnostic (both arms), and the no-route arm's
  "MODEL FALLBACK: switching …" advisory is no longer emitted on a v2 host
  when the apply will not land (#3617 review PRR-007).

## #3322 — incremental-verify matches underscore trigger agents

- The incremental-verify trigger gate derives the canonical role through the
  shared suffix-based extractor instead of a naive first-underscore split, so
  `test_engineer` and double-prefixed forms (`mega_local_test_engineer`) match
  configured trigger agents instead of only the accidental raw-name arm.
- Compatibility (#3617 review PRR-005/F-01): the pre-#3330 prefix-stripped form
  (the text after the first underscore) is kept as an explicit third matching leg, so pre-upgrade `triggerAgents`
  entries that only matched the naive split (`custom` for dispatched
  `acme_custom`, `oversight` for `critic_oversight`) keep firing.

## #3330 — one guarded helper; naive helper retired

- New `deriveSwarmIdentity(agentName)` (src/config/schema.ts) is the ownership
  point for the (role, swarm-id) derivation on the migrated call sites, with
  the full #3324 guard set: slice only on a real `_<role>` suffix,
  raw-case-preserving ids (`Case_coder` → `Case`), fail-closed to the default
  swarm for doubled separators (`local__coder`), multi-token prefixes, and
  separator-spelled prefixes (`acme-prod-coder` → default swarm).
- The 11 unguarded length-delta sites (curator/skill-improver factories,
  dispatch-lanes ×3, lean turbo ×4, full-auto oversight + intercept) and the
  guarded index site now route through the helper; `learning-health`
  participation normalization uses the canonical-role derivation (compound
  roles no longer mis-derive); the route's swarm id comes from the helper
  rather than the action-digest canonicalization.
- Lane dispatch: when the generated agent registry proves a prefixed agent
  spelling unregistered and its derived swarm id does not resolve, the lane is
  refused at launch even if the default swarm has a matching entry — base
  refused these, and launching against the default-swarm entry would run an
  agent name the host does not have (#3617 review F-05). An empty registry
  cannot prove anything unregistered, so that legacy shape still launches, as
  at base.
- `extractSwarmIdFromAgentName` — the helper #2960 proved defective — is
  retired: no production caller, no naive-split pins. Three documented
  exceptions keep their own contracts: `full-auto-delegation.ts`
  (prefix-emptiness deny policy), `action-identity.ts` (invariant-9 digest
  canonicalization, not a swarm-id consumer after this change), and
  `incremental-verify.ts` (the trigger compatibility leg above, kept
  deliberately naive-shaped and test-pinned).
- New census guardrail (tests/unit/guardrails/agent-name-derivation-census.test.ts)
  fails the build if any of its ENFORCED derivation shapes reappear outside the
  allowlist — and inside each allowlisted file at most one occurrence per
  shape is exempt (the justified derivation where it falls inside predicate
  scope; action-identity's two-operand slice is deliberately out of scope and
  pins an exact 0), each pinned by an exact per-file count, so a second
  derivation beside an exempt one also fails: `.replace(/^[^_]+_/, '')`, the retired
  `.match(/^([^_]+)_/)` helper form, `.split('_')[0]`/`.at(0)`, and
  `.slice(0, a.length - b.length - 1)` in both operand orders
  (#3617 review PRR-002 — the claim is scoped to exactly these shapes), each
  in any legal whitespace / optional-chaining spelling (`x . replace (…)`,
  `x.replace?.(…)`, `split('_')?.[0]`). Only whitespace and optional-chaining
  spelling variants are covered; other spellings — e.g. comments between
  tokens, template or escaped literals, non-canonical numeric literals, regex
  flags, extra arguments, computed member access, regexes held in variables —
  are out of scope.
