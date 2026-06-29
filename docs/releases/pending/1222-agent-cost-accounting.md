# Issue 1222: Agent Cost Accounting

## What changed
- Cost accounting from assistant/step-finish events (tokens_input, tokens_output, tokens_reasoning, tokens_cache, cost_usd, cost_source)
- `/swarm costs [--json]` command for inspecting per-delegation cost
- `/swarm benchmark --ci-gate --max-cost-usd <n>` for budget-based CI gating
- `pricing.models` config schema for per-model cost fallback

Adds per-delegation token and cost fields to `delegation_end` telemetry and a new `/swarm costs` command for per-agent, per-task, per-gate, and per-retry-loop totals.

`/swarm benchmark --ci-gate` now accepts `--max-cost-usd <n>` to fail CI when cumulative telemetry cost exceeds a configured threshold. Cost estimates are optional and use `pricing.models` when providers return token usage without reported cost; missing data degrades to `cost_source: "unavailable"`.

Note: cache token accounting collapses read+write cache tokens into a single `tokens_cache` value; `pricing.models.*.cache_per_million` applies one rate and does not support asymmetric read vs. write cache pricing.
