# PR-review runtime recovery and checkout restoration

Profile A PR reviews now recover two narrow, recurring explorer presentation
shapes without weakening candidate validation: a closed terminal protocol-only
Markdown fence and one redundant trailing confidence token on an otherwise
valid CLEAN row. Repairs are recorded as salvaged lane provenance; wrong-family,
ambiguous, malformed, duplicate, and ownership-invalid rows still fail closed.

The review intake is also less brittle on Windows. `gh_evidence` accepts the
common `changed_files` spelling, checks standard GitHub CLI install locations
after PATH, and the read-only shell gate permits a literal pipe only inside a
closed quoted `gh api --jq` argument. Exact commit verification now uses the
portable `rev-parse --verify <sha>^0` plus `cat-file -t <sha>` sequence.

PR workflow checkout preparation now records the original branch and HEAD.
After terminal completion or abort, the same tool can restore that exact
checkout and pop the exact preserved stash under the checkout-mutation lock.
Dirty, ambiguous, drifted, missing-stash, switch-failure, and pop-failure cases
stop without reset/clean and keep recovery evidence intact. Terminal responses
include the exact receipt inventory, and receipts from older plugin versions
derive their original commit from the preserved stash (restoring a uniquely
matching local branch when available, otherwise detaching safely).

Controller guidance now keeps Profile A context in bounded dispatch prompts,
reconciles CI against the latest run for the exact head, and aborts/restores
after bounded lane retry exhaustion instead of probing unreachable downstream
gates.

No configuration migration is required.
