# Encoding-robust ACCEPTANCE checks, model quota failover, and clearer diagnostics

## What changed

- The ACCEPTANCE-field coverage check that gates coder/reviewer dispatch is now encoding-robust: it canonicalizes Unicode (NFC) and folds the section sign `§` and its common Latin-1 mojibake to the word "section", so a good-faith copy no longer false-blocks on an encoding variant. When a mismatch does occur, the error now shows the first-divergence offset, the expected vs found text, and — when the spec text looks mojibake'd (a `??` run, a replacement character, or a Latin-1 byte sequence) — an explicit warning that `.swarm/spec.md` should be re-saved as UTF-8. The mismatch error no longer instructs a raw "copy byte-for-byte" (the compare is normalized, not raw bytes); the architect/coder prompt templates still describe the requirement as verbatim/byte-for-byte, which remains the right intent — the gate just no longer false-blocks on encoding variants of an otherwise-faithful copy.
- Provider quota / usage-limit exhaustion is now recognized as a distinct, retryable-and-failover-eligible error class (previously only a bare `429`/"rate limit" was caught). The transient classifier is single-sourced so the three former copies cannot drift again, and quota tokens are kept separate from the tool-output path so a shell `Disk quota exceeded` cannot trigger a bogus fallback.
- The critic-oversight, lean-turbo reviewer, and lane-runner dispatch stages now fail over to a role's configured `fallback_models` on a transient/quota error instead of failing the stage — closing the gap where a quota hit mid-run cascaded into malformed scope files. The evaluation dispatcher classifies quota and retries the same model (it never substitutes, to keep benchmark attribution correct).
- The non-transient circuit-breaker hard-stop message now includes the actual failure signal and category-specific remediation. For a `sandbox_wrapper_failure` it states the failure is sandbox provisioning (not the sub-agent refusing to act), points to `/swarm diagnose`, and explains that the circuit is in-memory and invocation-keyed — so a cache clear or bare session reset may not clear it, but a fresh agent invocation will.
- On the architect session, a silent model switch across an interrupt/resume, and a configured architect model that the UI has overridden, now surface a one-shot advisory instead of running silently out of sync. The last observed model is persisted so the cross-interrupt comparison is reliable.

## Migration

No configuration file or schema migration is required. The new `fallback_models` failover applies automatically to any role that already configures a fallback chain. If a spec authored in a web editor stored `§` as `??` on disk, re-save `.swarm/spec.md` as UTF-8 — the mismatch error now tells you when this is the cause.

Fixes #1896.
