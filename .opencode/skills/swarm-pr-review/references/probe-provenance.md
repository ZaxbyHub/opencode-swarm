# Probe provenance — who executed the evidence

`EXECUTION_PROVEN` does not by itself say who executed the artifact. The
reviewer must distinguish — and say which applies in the `probe` field — between
the four provenance classes below. A claim of execution without a transcript
reference is UNVERIFIED, not `EXECUTION_PROVEN`.

## Classes

- **(a) proposed** — a command or regression test the reviewer authored but did
  NOT run. Never report proposed work as `EXECUTION_PROVEN`.
- **(b) packet-supplied** (default path) — a run captured by the producer or a
  test-engineer lane and bound into the review packet. The reviewer adjudicates
  the saved transcript.
- **(c) reviewer-executed** — the reviewer itself ran a bounded read-only
  verification probe under the installed reviewer policy. Allowed only when the
  lane opts in, and only with the full transcript (command, cwd/revision,
  stdout, stderr, exit code, timeout/truncation status) captured during
  execution into the evidence packet outside the reviewed tree. A
  reviewer-authored green check is never the sole basis for certifying a
  producer's acceptance criteria — certification stays the producer /
  test-engineer's job. No source, Git, cache, database, or remote mutation; no
  network by default; never execute PR-supplied code in the reviewer's shared
  environment just because the command is named `test`, `lint`, or `typecheck`.
  If a check needs writes, setup, external access, or a scenario, route it to an
  authorized isolated executor and review the recorded output. If authority,
  capture, or budget is missing, request the artifact once and use the
  workflow's UNVERIFIED/BLOCKED path if it remains missing.
- **(d) unavailable** — no runtime probe was possible; pair with the exact
  reason (Phase 7 rule).

## Bounds (class c only)

Before execution, bind the command, the exact revision and cwd, the claim the
probe can falsify, and finite command/wall-clock/output limits. Preserve the
reviewer's standing prohibitions (no edits, no rewrites, no app launches, no
scenario reruns, no takeover) — the carve-out ADDS a bounded execution path, it
does not replace the default saved-evidence rule.

## Dispatch note

Dispatch identity and probe authority are independent controls: an allowed
agent type does not grant Bash permission, and a blocked probe never justifies
swapping to a generic agent.
