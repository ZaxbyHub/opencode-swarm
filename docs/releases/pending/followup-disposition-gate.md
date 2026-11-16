# Follow-up issues: a necessity gate and one collated issue per PR

PR-feedback rounds no longer turn every unfixed review finding into its own GitHub issue.

## Changes

- **`contributing.md`: new "Filing follow-up issues" section.** It applies to agents and contributors alike.
  - **One disposition per item the PR does not fix:** `ABSORB`, `FILE`, `RECORD` or `ASK`. Items the PR introduced are fixed in the PR; small pre-existing in-scope items are fixed only with the maintainer's go-ahead.
    - `ABSORB` means commenting on an existing issue.
    - `RECORD` means a "Considered, not filed" row in the PR body, for items that are unverified (unless they claim a wedge, fail-open gate, security, or data-loss consequence, which go to `ASK`) or have no real consequence, or that the maintainer declined. It closes the item without opening an issue.
    - Verified, consequential items that are judged not material go to the maintainer as an `ASK`; the agent never closes them alone.
  - **A four-part necessity gate before filing:** verified, consequential, material, and untracked/not fixable here.
  - **One collated `Follow-up from PR #N: <theme>` issue per PR.** More than two follow-up issues from one PR needs the maintainer's go-ahead (Priority items excepted).
  - **Priority versus Improvement tiers.** Improvement items are proposed for approval, not filed automatically.
  - **The filing checklist gains a follow-up line.**
- **swarm-pr-feedback skill:**
  - The closure ledger now records a follow-up disposition for every unfixed item.
  - The "never defer" rule now routes every unfixed item through the new `references/followup-dispositions.md`, which holds the gate, the collation budget, the tiers and the PR-body table.
  - `SKILL.md` stays at its progressive-disclosure line budget, and its `swarm-contract-digest` stamp is refreshed.

## Why

Before this change, unfixed findings were routinely filed as follow-up issues, often one per finding. About 100 issues mentioning a follow-up were opened in the 45 days before this change, and the only ones closed without a fix were closed because they were consolidated into a larger issue. Two things drove that:
- no rule said what deserves an issue or how to group them;
- the never-defer rule gave no documented outcome between fixing an item and filing it.

Common practice for AI-assisted review is to report residual findings on the PR rather than file one issue per finding, because most review comments never lead to a code change.
