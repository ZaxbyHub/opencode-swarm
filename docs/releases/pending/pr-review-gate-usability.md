# PR review gate: usable checkout, observation, and diagnostics

## What changed

The PR review mechanical gate (`/swarm pr-review`) stays fail-closed and
read-only, but it no longer blocks the very intake steps its own protocol
requires. Several mechanical sticking points that could stall a review before
it started are now smoothed:

- **Read-only shell wrappers are tolerated.** A single leading `cd <dir> &&`
  and a trailing `2>&1` — the forms models habitually emit — are stripped and
  the inner command is classified on its own. The wrapper grammar is
  fail-closed: `cd` targets may contain only a conservative path charset, so no
  shell metacharacter, `$`, or backtick can pass through the stripped region on
  any host (bash, cmd.exe, or PowerShell). State-transition commands
  (`git fetch/checkout/switch/branch`, `gh pr checkout`) still must run bare, so
  bind verification observes their effects. Compound composition (`;`, `|`,
  redirects, command substitution) remains rejected.

- **Blocked shell commands now explain themselves.** A blocked intake command
  returns a bounded diagnosis naming the precise reason (compound syntax, a
  `cd`-prefixed transition verb, a `git -C` transition, a post-bind fetch
  restriction, or an unlisted verb/binary) and the exact allowed form, instead
  of only restating that the mode is read-only.

- **New `pr_workflow_status` tool.** An architect-only, read-only observation
  tool reports the current HEAD, branch, working-tree cleanliness and dirty
  files, remotes, and a summary of the active gate (mode, bound head/base,
  depth tier, dispatch counts) for the caller's own session only. This replaces
  ad-hoc `.swarm` file reads for observing state under the gate.

- **`prepare_pr_workflow_checkout` self-discovery.** Called with no `paths`, the
  controller now discovers and preserves all dirty and untracked changes in one
  auditable stash; an already-clean tree is a no-op. Naming an exact dirty-path
  set is no longer required to get past a stray untracked file (which the gate's
  clean-tree check counts). Explicitly-named paths keep the exact-match
  contract.

- **`gh_evidence` degrades gracefully.** When the `gh` CLI is absent, the tool
  now returns actionable guidance — the constructed `api.github.com` REST URL and
  the read-only web-fetch path — instead of a bare "not found." Its PR field
  allowlist gained `labels`, `comments`, `assignees`, `milestone`, `mergedAt`,
  `createdAt`, `closedAt`, and `updatedAt`, and an unsupported-field error now
  names both the rejected field and the allowed set.

- **`git branch` listing and read-only helpers admitted.** Read-only
  `git branch` listing forms, `git`/`gh --version`, and `which`/`where` are now
  classified as read-only; the built-in `web_fetch`/`web_search`/`list` tool
  names are recognized under their underscore spellings. Every `git branch`
  mutation form stays blocked.

- **Banner de-spammed.** The "workflow active" banner prepended to architect
  text is now emitted in full on a per-session cooldown and as a short marker in
  between, so long reviews are not flooded. Suspension and interruption recovery
  notices remain on every part.

- **The review skill's own commands were corrected** to forms the gate admits
  (no `--jq` pipes or `$()` command substitution in intake), the post-bind
  parallel-work check now compares remote state read-only, and a "shell rules
  under the gate" reference was added.

## Why it matters

The gates were added to make PR review rigorous, but the mechanical intake path
had become effectively unrunnable for some agents: read-only git observation was
blocked wholesale, `gh_evidence` hard-failed without a fallback, and the
checkout-preparation tool required a dirty-file list the agent had no allowed way
to compute. These changes keep every fail-closed guarantee while making the
happy path reachable, and give the architect a first-class way to see and
understand why a step was blocked.
