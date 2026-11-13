# Lane cost recovery (harness-recorded per-lane data)

#3605 AC4 (ABSORB-refined 2026-11-08): the cost/yield ledger's producer is
harness-recorded data — lanes do NOT self-report. The ZCode harness already
writes one rollup row per subagent session.

## Recovery query (ZCode harness db)

`~/.zcode/cli/db/db.sqlite`, table `turn_usage`, one row per subagent session;
join `session.parent_id` to the orchestrating session id to recover the lanes
of one review run:

```sql
SELECT s.id,
       tu.total_ms / 60000.0            AS elapsed_min,
       tu.tool_calls                    AS tool_uses,
       tu.model_request_count           AS requests,
       tu.input_tokens,
       tu.cache_read_input_tokens,
       tu.cache_creation_input_tokens,
       tu.output_tokens
FROM session s JOIN turn_usage tu ON tu.session_id = s.id
WHERE s.parent_id = '<orchestrating-session-id>';
```

Field semantics (measured 2026-11-08 over an 11-lane review):

- `input_tokens` is CUMULATIVE across the lane's whole run, not per turn — the
  per-request figure must be derived: `(input + cache_read + cache_creation) /
  model_request_count`.
- `reasoning_tokens` is 0 on 88% of subagent rollup rows and must NEVER be
  used as a denominator; `output_tokens` is overwhelmingly reasoning text, not
  report prose, and is excluded from context.
- The `actionable_findings` column is the review's own count for that lane
  (findings that survived reviewer validation) — append it per lane when
  exporting.

## Export + render

Export the rows to the 9-column TSV the ledger script consumes (`id`,
`elapsed_min`, `tool_uses`, `requests`, `input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`,
`actionable_findings`), then:

```bash
bash .opencode/skills/swarm-pr-review/scripts/cost-yield-ledger.sh <lanes.tsv> \
  > <run-dir>/cost-yield-ledger.md
```

Persist the rendered ledger in the review run artifacts (`<run-dir>/` — under Profile A
`.swarm/pr-review/<run_id>/`; under Profiles B/C the session/task workspace's
`pr-review/<run_id>/` directory, never `.swarm/`)
and state the paired `per-finding cost:` aggregate in the synthesis — cost and
yield are paired per row by design, so neither column can be read alone (the
two highest-cost lanes of the measured example produced the deepest findings).

## Considered and rejected (measured)

Moving explorer lanes' final reports to a file to save context was evaluated
and dropped: the final report is ~1,730 tokens of a ~594k-token average
context (~0.3% saving), and visible output of any kind is under 1% of lane
context — relocation cannot reduce intra-lane replay (a final report has no
later request within its lane). An independent critic reached the same
conclusion before the measurement. Recorded so it is not re-proposed.
