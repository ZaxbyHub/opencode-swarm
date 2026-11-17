---
issue: 3716, 3723, 3724
---

## Verification-surface, dispatch-resilience, and redaction residuals from the 3718/3719/3720 rounds

Collated fixes for #3716, #3723, and #3724 — the residuals filed from the
three most recent merged PRs:

- **The config-schema drift gate can now fail** (#3724 item 1): the drift
  job's `bun install` no longer runs package lifecycle scripts
  (`--ignore-scripts`), so a committed `opencode-swarm.schema.json` that
  drifted from the locked-toolchain generator is no longer silently
  regenerated to green before the check reads it. The `localWorkflowHashes`
  evidence entry for `drift-check.yml` is refreshed for the workflow edit.
- **A deterministic HTTP 403 no longer burns the epic fallback chain**
  (#3724 item 2): the epic phase-review rethrow preserves the
  provider-message carrier (`providerMessageErrorToError`), so the
  model-fallback chain classifies from the carrier snapshot — a 403 whose
  text carries rate-limit wording no longer classifies transient; genuine
  429s still fail over and carrier-less errors keep the raw-text arm.
- **A Lean Turbo lane that produced real output is no longer stranded**
  (#3724 item 3): a reply with non-empty text parts plus a provider error now
  settles under the same real-output contract as `dispatch-lanes` (lane
  completes, worktree merged back); provider errors with no text still fail
  closed.
- **Duplicate context owner records are rejected** (#3716 item 1): the
  required-check contract validator fails `CONTRACT_MALFORMED` on owner
  records sharing a context name instead of silently first-match-resolving.
- **The captured success set is producer-bound** (#3716 item 2): the
  `mergeGroup.contexts` derivation and the completeness loop share ONE
  producer-binding rule (all-success + unambiguous agreeing app slug for
  duplicates + repo-producer ownership for explicit slugs) — the name-only
  trust surface is gone.
- **A null sandbox executor no longer pins for the process lifetime**
  (#3716 item 3): the executor cache keeps healthy executors permanent but
  re-probes a null or rejected creation after a bounded TTL (60 s default,
  `SWARM_SANDBOX_EXECUTOR_FAILURE_TTL_MS` override, finite-positive values
  only) — the macOS `PROBE_FAILURE_TTL_MS` pattern applied to the executor
  seam, with a construction DI seam for hermetic testing.
- **Long-header JWS tokens are fully redacted** (#3723): both redaction sites
  (shell audit + failure-evidence display) use a single-pass, linear-time
  JWS span scan covering `x5c` certificate-chain headers of any length — on
  the display sweep it runs on BOTH the raw and the zero-width-condensed
  views; the payload and signature of a bare-placement token no longer
  survive in clear text, and the #3710 disclosed over-long-header residual
  is closed (its pin flipped to assert coverage).
