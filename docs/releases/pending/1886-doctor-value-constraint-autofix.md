# `/swarm doctor` now detects value-constraint config failures + opt-in fallback trim (issue #1886)

## What

`/swarm doctor` (config doctor) previously only surfaced **unrecognized** config
keys. A value-constraint failure — e.g. an agent's `fallback_models` array
exceeding the schema maximum of 3 — produced **no finding and no fix**, so the
doctor reported "no issues" while the config stayed broken and swarm silently ran
on safe defaults.

Now the doctor:

- **Reports every value-constraint failure** on the raw config (naming the exact
  path and reason), so it explains *why* a config was rejected — not just unknown
  keys.
- **Offers an opt-in auto-fix** for an over-length `fallback_models` array that
  trims it to the schema maximum. Because trimming drops user-chosen models, it
  is applied **only** via the explicit `/swarm config doctor --fix` command —
  **never** by the passive startup auto-fix path. The finding lists exactly which
  models would be dropped.

## Why

Reported in #1886: a user's config was rejected because several `fallback_models`
lists had more than 3 entries, but neither `/swarm diagnose` nor `/swarm doctor`
said so. The companion diagnose fix surfaces the reason; this makes the doctor's
suggested `--fix` path actually resolve this class of failure.

## Behavior / compatibility

- No config-schema change (the `fallback_models` max stays 3; it is now a named
  constant `FALLBACK_MODELS_MAX` shared by the schema and the doctor so the trim
  can never drift from the constraint).
- The lossy trim is double-gated: an explicit `--fix` command **and** the
  existing config backup taken before any auto-fix. Startup auto-fix
  (`config_doctor_autofix`) reports the issue but never trims it, and now nudges
  the user to run `--fix` for any auto-fixable finding it declined to apply.
- Non-`fallback_models` value errors are reported only (never auto-fixed).
