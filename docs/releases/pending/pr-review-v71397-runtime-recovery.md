# PR-review runtime recovery and checkout restoration

Profile A PR reviews now recover two narrow, recurring explorer presentation
shapes without weakening candidate validation: a closed terminal protocol-only
Markdown fence and one redundant trailing confidence token on an otherwise
valid CLEAN row. Repairs are recorded as salvaged lane provenance; wrong-family,
ambiguous, malformed, duplicate, and ownership-invalid rows still fail closed.

The review intake is also less brittle on Windows. `gh_evidence` accepts the
common `changed_files` spelling, checks standard GitHub CLI install locations
after PATH, and the read-only shell gate permits a literal pipe only inside a
closed double-quoted `gh api --jq` argument without cross-shell-ambiguous
backslash- or caret-escaped quotes. Exact commit verification now uses the portable
`rev-parse --verify <sha>^0` plus `cat-file -t <sha>` sequence.

PR workflow checkout preparation now records the original branch and HEAD.
After terminal completion or abort, the same tool restores the common recorded
checkout and reapplies every pending receipt by immutable stash OID under a
project-wide checkout-mutation lock. PR-feedback branches may advance only as
descendants of their recorded commit; divergent, cross-session, dirty,
mixed-destination, missing-stash, switch-failure, and apply-failure cases stop
without reset/clean and retain durable recovery evidence. Applied receipts are
deleted only after a separate durable verification marker is written, so an
interrupted multi-receipt restore resumes safely while completed cleanup remains
idempotent even when receipt deletion fails or the restored branch later
advances. Applied stashes remain as explicitly
reported safety backups because Git cannot atomically delete a non-top stash by
immutable identity; the controller never risks dropping a renumbered selector.
Receipts are size/count/path bounded before checkout mutation, including
expansion-heavy discovery paths, so the plugin never writes a receipt beyond
its own restore reader boundary. Preparation now validates every existing
receipt and pending stash through the same authoritative restore contract
before preserving more changes, preventing stale files from creating a new
unrestorable receipt. Git output capture is
bounded, terminal responses include the exact receipt inventory, and older
receipts derive their original commit from the preserved stash (restoring a
uniquely matching local branch when available, otherwise detaching safely).

Council discovery now records the same repair provenance as base and micro
lanes, and read-only `gh api --jq` intake accepts literal pipes only when the
pipe is protected by unambiguous double quotes on every supported shell.

Controller guidance now keeps Profile A context in bounded dispatch prompts,
reconciles CI against the latest run for the exact head, and aborts/restores
after bounded lane retry exhaustion instead of probing unreachable downstream
gates. A recovery abort may clear either an unbound or bound workflow once all
lanes have settled, while publication-armed feedback workflows remain protected;
this prevents post-bind discovery failures from stranding the controller.

No configuration migration is required.
