# Config validation now tells you what to fix (issue #1886)

## What

When `opencode-swarm.json` fails validation, `/swarm diagnose` used to show only
a bare `"[opencode-swarm] Merged config validation failed:"` line — a colon with
nothing after it — so you couldn't tell which field was wrong. It now names the
exact failing path(s) and the reason, e.g.:

```
[opencode-swarm] Merged config validation failed: agents.architect.fallback_models: Too big: expected array to have <=3 items; agents.coder.fallback_models: Too big: expected array to have <=3 items
```

The same detail now appears for the `external_skills` and `gates` validation
advisories and for config load/prompt-read failures.

## Why

`advisoryWarn(message, data)` buffered only `message` for `/swarm diagnose` and
sent the actionable `data` (the Zod validation detail) to the debug-only logger.
Any advisory that put its detail in `data` therefore surfaced detail-less. The
config loader passed the full Zod error as that dropped `data`, so operators saw
a failure with no cause. (A common trigger: adding more than 3 `fallback_models`
to an agent — the schema caps that array at 3.)

## Fix

- `advisoryWarn` now folds a compact, single-line, length-bounded rendering of
  `data` into the buffered `/swarm diagnose` entry, in addition to the unchanged
  debug log. This closes the whole class structurally: no advisory can silently
  drop its detail from `/swarm diagnose`.
- The config loader flattens Zod errors to a readable `path: message` summary
  (`formatZodIssues`) instead of the nested `error.format()` object.

## Behavior / compatibility

- No config-schema change; the fail-secure fallback is unchanged (guardrails stay
  ENABLED when a config is rejected).
- The surfaced detail is issue **paths and messages** only — never a raw dump of
  your config values.
