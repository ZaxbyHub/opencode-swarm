---
issue: 3177, 3403
---

## Structured provider-failure classification and phase-fresh fallback selection for Lean Turbo lanes; all-or-nothing coder scope-claim activation

### #3177 — lean lane provider-error follow-ups

- **Classification now consumes the structured snapshot (#3177-A / #1896 invariant 9).** The provider error a lane dispatch surfaces now carries the canonical classification computed at read time (category, retry class, risk, status) instead of only the 512-byte-bounded display string. Consequences: a deterministic HTTP 403 whose provider-controlled message text mentions "429"/"rate limit" no longer burns the `fallback_models` chain (it used to advance through every fallback on a failure that can never succeed on any model), and a status-less rate limit whose keyword was truncated past the display bound now still fails over (it used to be classified permanent and never reach the chain).
- **Scoped fallback selection is keyed per phase (#3177-B).** Lane ids restart their numbering every phase, so phase N+1's `lane-1` used to resume phase N's advanced (or exhausted) chain state — either starting on the wrong model or failing instantly with "no dispatch attempted" and zero `session.prompt` calls. The scoped selection is now keyed by phase ordinal, so every phase starts fresh from the primary model.
- `classifyProviderFailure` honors a pre-classified snapshot only on the verified provider-message carrier (provenance-gated by the nested `providerError` marker, all enum fields known, abort-like errors still classified cancelled first, unknown enums fall through fail-closed). Existing carrier consumers (full-auto oversight/intercept) keep status-bearing behavior identical and gain the read-time verdict for status-less text.

### #3403 — coder child scope-claim atomicity and trust model

- **A failed coder scope-claim no longer leaves a half-applied activation (#3403 PRR-006).** The dispatch lineage write that precedes the durable claim is now generation-stamped; when the claim fails with anything other than `SCOPE_NOT_DECLARED` (e.g. `SCOPE_BINDING_ALREADY_CLAIMED` for a second claimant, persistence failure, ambiguity), exactly this write is rolled back — restoring any pre-existing adopted lineage rather than deleting it, and never clobbering a newer interleaved write (the rollback is conditional on the write generation, so a stale failure no-ops even when both attempts wrote the same parent). Previously the losing child's lineage stayed committed while its session identity/route bindings were permanently skipped, and every subsequent progress event re-threw.
- **The child-identity trust model is documented and pinned (#3403 PRR-009).** Both load-bearing sites (the delegation gate's `taskMetadata` and `claimScopeBindingForChildDurably`) now state which fields are host-typed vs tool-emitted and what a tool-emitted child id can cause, with a test pinning the documented claims and a test naming every session field a successful claim mutates (`agentName` overwrite to `coder`, PRM ladder reset, `currentTaskId`, `declaredCoderScope`). The v1 host contract itself is unchanged.
