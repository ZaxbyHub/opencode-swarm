### Reliable signal-mode discovery, a new `/swarm pr-feedback` command, and PR-ref ergonomics

**What changed**

- **Signal-triggered modes are now reliably entered.** Commands like
  `/swarm deep-dive` and `/swarm pr-review` emit a `[MODE: X ...]` activation
  signal. Previously the architect was told to "show this output verbatim," and
  the mode was absent from the architect's MODE-detection table, so the
  orchestrator often just echoed the signal instead of loading the skill — users
  had to manually tell it to read the skill file. The command-delivery wrapper now
  recognizes a `[MODE: ...]` signal and instructs the architect to enter that mode,
  and a top-priority "signal-triggered mode" rule was added to MODE detection.
- **New `/swarm pr-feedback` command.** The `swarm-pr-feedback` skill existed but
  had no way to launch it. It is now wired end to end (command handler, registry
  entry, TUI shortcut, master command list, and a `MODE: PR_FEEDBACK` architect
  section). Use it to ingest and close known PR feedback (review comments, CI
  failures, merge conflicts, pasted notes) without running a fresh broad review.
- **PR references are more ergonomic.** Both `/swarm pr-review` and
  `/swarm pr-feedback` accept a full URL, `owner/repo#N`, or a bare PR number
  (resolved against the `origin` remote of the command's project directory), and
  you can append free-text instructions after the reference (e.g.
  `/swarm pr-review 155 focus on the auth refactor`). `pr-feedback` also accepts
  no PR reference (pasted-feedback session). The bare-number git remote lookup
  runs in the invoked project directory rather than `process.cwd()`, so it
  resolves correctly in plugin-host contexts; a PR-ref-shaped token that cannot
  be resolved returns an explicit error instead of being silently demoted to
  free-text feedback.
- **PR review/feedback are more autonomous.** The architect now has hard
  constraints to follow the skill exactly, check out the PR branch locally before
  exploring/fixing, run the triggered micro-lanes, and honor appended
  instructions — so these no longer need to be repeated by hand each run.
- **Drift prevention.** A new enforcement test ties every `[MODE: X]`-emitting
  command to its architect section and skill file and flags orphaned skills, and
  `swarm-pr-feedback` was added to the skill-mirror parity test. A latent bug was
  also fixed: disabling `design_docs` no longer also strips the `PR_REVIEW`/
  `PR_FEEDBACK` mode sections. A missing `swarm-design-docs` TUI shortcut was
  added to restore command-registration parity.

**Migration**: none. All changes are additive; existing `/swarm pr-review`
invocations behave as before (with the new optional trailing-instructions and
clearer unknown-flag errors).

**Caveats**: `/swarm pr-feedback` treats a leading token that is not a parseable
PR reference as pasted-feedback instructions rather than erroring — this is
intentional so no-PR feedback sessions work.
