## SAST baseline reflow matching + audited absorption

`sast_scan` baseline diffing no longer reclassifies an unchanged pre-existing
finding as NEW when an adjacent line is edited or an identical same-rule line
is inserted above it: findings are matched against the phase baseline by a
position-independent reflow identity (file + rule + flagged-line content,
multiset-counted) and reported separately as `moved_findings` (never gating);
`pre_check_batch` carries moved findings into the reviewer triage bucket.

Re-capturing into an existing baseline with findings not previously in it is
now BLOCKED until the capture passes the new `baseline_refresh_rationale`
argument — for already-indexed and first-time-indexed files alike — which
records a per-finding who/when/rationale triage entry in
`.swarm/evidence/{phase}/sast-baseline.json` (schema 1.1.0): a bare
failure-response recapture can no longer silently accept a coder-introduced
vulnerability. Baseline creation (first write) remains free, as do merges
whose findings all match the baseline. Routine per-task captures of
first-time files now pass the rationale as a truthful pre-delegation
assertion (see the execute skill's 5b-BASE step). Baselines written before
this change load unchanged (exact matching only) and upgrade to 1.1.0 at
their next capture.
