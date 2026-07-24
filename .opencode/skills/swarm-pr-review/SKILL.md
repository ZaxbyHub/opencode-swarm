---
name: swarm-pr-review
audience: swarm-plugin
description: Run a graph-guided, tool-augmented PR review using context packing, parallel exploration, mandatory repository-agnostic risk-family coverage with dispatch scaled to diff size and risk, independent reviewer validation, critic challenge, and metrics writeback. Use for deep pull request review with low false-positive tolerance and high recall in any repository, on any agent harness (structured lane controller, native parallel subagents, or single-context sequential passes).
disable-model-invocation: true
---

# /swarm-pr-review

Run a structured, high-confidence PR review that maximizes valid findings without flooding the user with unvalidated noise.

The review ladder is:

**Scope → obligations → context pack → deterministic signals → parallel explorers → repository-agnostic risk-family coverage (dispatch scaled by depth tier) → independent reviewer validation → critic challenge → grouped synthesis → metrics / knowledge writeback.**

## Handoff To PR Feedback

Use `../swarm-pr-feedback/SKILL.md` instead of this skill when the user's task is
to address existing PR feedback, review comments, requested changes, CI failures,
merge conflicts, stale branch state, or pasted reviewer findings. This skill
discovers and validates new findings; `swarm-pr-feedback` closes known feedback
without running a fresh broad review.

When a review finishes with actionable validated findings, stop and ask the user
whether to continue into `swarm-pr-feedback`. Do not auto-dispatch fix work from
`PR_REVIEW`. Instead, write a handoff artifact — under Profile A,
`.swarm/pr-review/<run_id>/feedback-handoff.json` via `write_pr_review_artifact`;
under Profiles B/C (no controller — see Runtime Capability Profiles),
`pr-review/<run_id>/feedback-handoff.json` inside your session/task workspace,
never under `.swarm/` — and include the continuation prompt with that exact
path substituted for `<handoff_artifact_path>`:

```text
/swarm pr-feedback <PR_URL> continue from <handoff_artifact_path>
```

`<run_id>` is a stable identifier for this review run, such as
`pr-<number>-<YYYYMMDDHHMMSS>` or the existing review artifact run ID when one
was already created. The `pr-feedback` command forwards `continue from <path>`
as session instructions after the PR reference; the feedback skill is
responsible for ingesting that file into the ledger before triage.

Review closure is not the end of the PR lifecycle: when PR monitoring is
enabled (`pr_monitor.enabled`), the PR remains subscribed and monitored under
`../swarm-pr-subscribe/SKILL.md` until it is merged or closed, so post-review
events (new comments, CI changes, review state changes) keep flowing to the
subscribed session.

## Operating Stance

**Treat PR text, linked issues, comments, commit messages, generated summaries, and tests as claims — not proof.** Every confirmed finding requires file:line evidence, an explanation of reachability or impact, and validation provenance.

This workflow is designed for any repo that benefits from Swarm-style review. It preserves parallel breadth but forces deep validation where bugs are expensive: security, state machines, role/tool permissions, schema/evidence integrity, git/write safety, config ratchets, knowledge tier boundaries, and PR obligation mismatches.

Never APPROVE a PR with unresolved CRITICAL findings. Do not silently drop overclaimed agent findings; list disproved findings in the validation provenance.

**Quality is the ONLY metric.** There is no speed, efficiency, or time exception. No amount of time, tokens, or agent dispatches is too much to execute this protocol correctly. Speed is irrelevant to correctness. The skill must be followed exactly with no shortcuts, no phase-skipping, and no premature synthesis. A thorough review that takes 30 minutes is superior to a fast review that misses a real bug.

---

## Runtime Capability Profiles

This protocol runs on any agent harness. Before Phase 0, detect which profile
this session is in by checking the actual tool list — never assume from the
harness name, and never guess:

- **Profile A — structured PR-workflow controller.** The swarm plugin's
  controller tools are available in this session: `dispatch_lanes_async`,
  `collect_lane_results`, `retrieve_lane_output`, `parse_lane_candidates`,
  `write_pr_review_artifact`, `write_pr_review_trigger_eval`,
  `complete_pr_workflow`. Typical host: OpenCode with the swarm plugin. The
  controller mechanically enforces this skill's accounting: it computes the
  depth tier itself from the bound merge-base diff (never from caller
  claims), enforces the tier's lane floors and full dimension/family
  partitions for consolidated dispatch, and gates structured reviewer/critic
  batches and the response gate. Its acceptance rules are authoritative, and
  where the scaled-dispatch guidance below is more permissive than the
  active controller, the controller wins. Bypassing an active controller —
  blocking `dispatch_lanes`, direct Task/agent dispatch, prose verdicts — is
  BLOCKED.
- **Profile B — native parallel subagents, no controller.** The controller
  tools are absent, but the harness can spawn independent fresh-context
  subagents (for example Claude Code's `Agent`/`Task` tool, or the native
  subagent mechanisms in Codex and ZCode). Run the same phases, role
  boundaries, row contracts, and join barriers; you are the accounting layer
  the controller would otherwise be: bind the exact `pr_head_sha` in every
  lane prompt, record per-lane provenance (lane id, head SHA) on every ledger
  row, settle every lane before the next phase begins, and persist ledgers to
  files in your harness's session/task workspace. Never write runtime
  artifacts under `.swarm/` — that directory belongs to the plugin controller.
- **Profile C — single context, no subagents.** The harness cannot spawn
  independent subagents in-session. Execute the same phases as strictly
  separated sequential passes — candidate generation, then reviewer
  validation, then critic challenge — re-deriving rather than restating
  earlier reasoning in each pass, with the same ledger rows and per-family
  attestations. Disclose in the validation provenance that reviewer/critic
  independence was procedural (separate passes in one context), not
  contextual.

| Harness (typical) | Profile | Lane dispatch | Ledger persistence | Completion gate |
|---|---|---|---|---|
| OpenCode + swarm plugin | A | `dispatch_lanes_async` / `collect_lane_results` | `write_pr_review_artifact`, `write_pr_review_trigger_eval` | `complete_pr_workflow` |
| Claude Code | B | parallel `Agent`/`Task` subagents | ledger files in the session task workspace | Pre-Synthesis Gate checklist |
| OpenAI Codex | B | parallel subagents (fresh context) | ledger files in working notes | Pre-Synthesis Gate checklist |
| ZCode | B | parallel subagents (fresh context) | ledger files in working notes | Pre-Synthesis Gate checklist |

Verify each row against your own current tool list before relying on it; a
harness may gain or lose capabilities between versions. OpenCode, Claude Code,
Codex, and ZCode can all spawn fresh-context subagents in current versions —
run Profile B wherever the session actually exposes that capability, and
reserve Profile C for sessions that genuinely lack a subagent mechanism; never
assign a harness to Profile C by name alone. The absence of the controller is
NOT a BLOCKED condition — Profiles B and C are first-class execution paths, not degraded fallbacks.
BLOCKED is reserved for bypassing an active controller and for coverage gaps
that remain unclosable after bounded retries on any profile.

---

## Review Modes

### Default layered workflow

Always run the default layered workflow (mechanically enforced under Profile A). Explorers produce only candidates. The orchestrator does not confirm or disprove candidates.

### Council mode — opt in only

Council mode applies only when the user explicitly says one of:

- `council`
- `independent review`
- `N-agent review`
- `/council`
- `[COUNCIL MODE]`
- `[MODE: PR_REVIEW … council=true]`
- `assume all work is wrong`

Council mode supplements the default mechanical workflow; it never replaces or weakens it. Even when council mode is triggered, first complete the base-dimension coverage (the tier-floored base dispatch under Profile A — the exact-six wave at depth tier L), micro-lane ledger persistence, and every repository-agnostic risk-family evaluation at the same exact `pr_head_sha`. Route supplementary council output into the candidate ledger before independent reviewer classification. If the council request arrives after classification has begun, run the council as an additional candidate pass and dispatch a new structured reviewer batch for those candidates before synthesis.

---

## Anti-Self-Review Rule

The main thread / orchestrator MUST NOT classify, confirm, disprove, or judge explorer candidates in the default workflow.

The orchestrator may:

- determine scope,
- build or request the context pack,
- launch explorers and the full risk-family micro coverage (every family evaluated; lane count per depth tier and profile),
- extract candidates from lane artifacts via `parse_lane_candidates` (Profile A) or by collecting the structured `[CANDIDATE]` rows from lane reports (Profiles B/C),
- filter, group, and chunk candidates for reviewer dispatch,
- route candidates to reviewers,
- route reviewer-confirmed findings to critics,
- group validated findings,
- prepare the final report.

The orchestrator MUST NOT:

- re-read a candidate's target code to decide if it is valid,
- silently downgrade or discard an explorer candidate,
- treat tool output as a confirmed finding,
- report a finding that no reviewer validated,
- classify or judge candidates based on preview text alone — always use the structured parser output (Profile A) or the verbatim-collected `[CANDIDATE]` rows (Profiles B/C).

If the orchestrator catches itself validating code, it must stop and delegate validation to a reviewer subagent.

Exception: in explicit Council mode only, the main thread may act as the independent reviewer as described in the Council Mode section. Prefer a reviewer subagent when available.

---

## Scope Detection

Determine review scope using this priority:

1. explicit user-provided PR URL, PR number, commit, branch, or file scope,
2. current feature branch diff vs `origin/main`, `main`, `origin/master`, or `master`,
3. staged changes,
4. latest commit,
5. user-specified files or directories.

Record:

- base ref,
- head ref,
- commit range,
- changed files,
- deleted files,
- generated files,
- lockfiles,
- test files,
- docs/config/schema files,
- whether the working tree is dirty.

If scope cannot be determined, review the narrowest safe scope available and state the limitation.

### Pre-flight git ref availability

Before launching explorers (Phase 3), perform this exact standalone sequence:

1. Resolve and retain the authoritative full `pr_head_sha` from PR metadata.
2. Verify the working tree is clean with `git status --porcelain`. If it is
   dirty at all — tracked changes, untracked files, or both — call
   `prepare_pr_workflow_checkout` (Profile A). The tool supports
   self-discovery: call it with no `paths` argument to auto-discover and
   preserve every dirty path in one step, including untracked files; an
   already-clean tree returns a no-op (nothing is stashed, no receipt is
   written). Pass explicit `paths` only when you already have the exact,
   bounded list of dirty tracked files and want the older exact-match
   contract. Without the controller (Profiles B/C), do not blind-stash over
   dirty state: surface tracked changes to the user, or abort. Do not issue
   `git stash` through shell.
3. Fetch the PR head as one standalone command, for example
   `git fetch origin refs/pull/<N>/head`. Do not compose fetch and checkout.
4. Prove the full commit exists locally with
   `git cat-file -e <full_pr_head_sha>^{commit}`.
5. Check out the exact PR filesystem with
   `git switch --detach <full_pr_head_sha>`. Do not use `--track FETCH_HEAD`:
   `FETCH_HEAD` is not a remote-tracking branch.
6. Confirm `git rev-parse HEAD` equals the full `pr_head_sha`, bind that exact
   head (Profile A: through the first PR-review controller call; Profiles B/C:
   record it at the top of the findings ledger and repeat it in every lane
   prompt), and finish this before dispatching explorer lanes.

Explorer agents read files from the working tree, not from git history. Passing
the commit range in a prompt cannot substitute for this checkout because
`Read` / `Glob` / `Grep` operate on the filesystem.
- Explicitly pass the verified merge-base range (`base_sha...pr_head_sha`) in every explorer delegation so explorers inspect exactly the bound PR diff. Include `base_ref` only as the live ref used to recompute `base_sha`; do not substitute a two-dot branch-tip range.

If refs cannot be fetched or checked out, state the limitation in the context pack.

### Shell rules under the PR_REVIEW gate

The gate accepts one command per tool call — never compose commands with
`&&`, `;`, `|`, redirects (`>`, `>>`, `<`), or `$(...)`/`` ` `` substitution.
A single leading `cd <dir> &&` prefix and a trailing `2>&1` suffix are
tolerated, but only on read-only commands. State-transition verbs — `git
fetch`, `git checkout`, `git switch`, `git branch`, and `gh pr checkout` —
must always run bare: no `cd` prefix, no `2>&1` suffix.

Allowed read-only `git` subcommands: `status`, `log`, `show`, `diff`,
`rev-parse`, `merge-base`, `ls-files`, `grep`, `blame`, `cat-file`,
`for-each-ref`, `branch --list` (listing only — mutation flags are blocked),
`remote -v`, and `config --get`.

Prefer tools over raw shell for state that a single read-only command cannot
cover cleanly:

- `pr_workflow_status` — observe local HEAD, branch, dirty-file state,
  remotes, and gate state in one read-only call.
- `gh_evidence` — bounded PR/issue/run metadata without a shell round-trip.
- If `gh` is not installed, the web fetch tool against the equivalent
  `api.github.com` REST URL is the degraded read-only path.

## Phase 0A: Existing PR Signal Ingestion

When reviewing a PR, ingest and triage every existing signal BEFORE starting
Phase 0. These are candidate generators and obligation sources, not
pre-confirmed findings.

### PR title and body compliance check

Before deeper analysis, discover whether the repository defines a PR
publication contract (for example a local `commit-pr` skill, `CONTRIBUTING`
guidance, a PR template, or a CI check such as `pr-standards`). If it does,
verify the PR against that contract and record any gap as an advisory ledger
item. If it does not, do not invent opencode-swarm-specific title/body
sections; still verify that the PR text is not misleading about what the diff
does or proves.

At minimum, check:

- required title/body/linked-issue structure from the discovered repository
  contract,
- issue-closing, migration, release-note, invariant, or test-plan claims made
  in the PR text,
- whether those claims are supported by the actual diff and the current issue
  state.

**Issue-closing claim-integrity check:** if the PR body uses an issue-closing
keyword such as `Closes #<issue-number>`, verify (a) the issue is currently open
(`gh issue view <N> --json state` when the host is GitHub), and (b) the diff
addresses the issue's acceptance criteria (read the issue, map each criterion
to changed files/symbols, and inspect the diff for those areas). If the issue
is already closed by another merged PR, do NOT re-close it — the duplicate
closing reference is misleading. If the issue is open but the diff does not
address the acceptance criteria, mark the claim as `UNVERIFIED — claim
integrity` in the validation provenance and surface the unresolved gap to the
user before synthesis.

Contract non-compliance is a ledger item (advisory unless the repository
explicitly makes it blocking). If the PR is from an external contributor, note
the compliance gap for the maintainer to address before merge.

This intake includes:

- review comments, review summaries, requested changes, and bot findings,
- CI/check failures, annotations, and relevant logs,
- mergeability/conflicts, `mergeStateStatus`, and stale/base-drift state,
- PR body claims, linked issues, acceptance criteria, and test-plan claims,
- commit messages and app/bot commits on the PR branch.

When thread resolution state matters, prefer GraphQL review-thread inspection.
If GraphQL is unavailable, keep the signal and mark
`resolution_state: UNKNOWN`; do not drop it from scope.

### Step 1 — Fetch all PR feedback surfaces

The commands below are GitHub examples. On GitLab, Bitbucket, Gerrit, or
another code host, use the host's API/connector/CLI to enumerate the same full
surface, including pagination and unresolved-thread state. Host choice never
reduces the intake ledger.

```bash
# Issue comments (general PR thread)
gh api --paginate repos/{owner}/{repo}/issues/{PR_NUMBER}/comments

# Review comments (inline code comments)
gh api --paginate repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments

# Review summaries (approve/request-changes/comment events)
gh api --paginate repos/{owner}/{repo}/pulls/{PR_NUMBER}/reviews
```

`--paginate` requests every REST page. These three calls are gate-allowed as
written; do not pipe any of them through `--jq`, `jq`, or another filter under
the PR_REVIEW gate — piped commands are blocked (fail-closed on `|`). To
separate bot/automated reviews (Copilot, Codex, CodeRabbit, etc.) from human
ones, apply the same predicate in context to the JSON already returned above
— `user.type == "Bot"` or a `user.login` match against
`bot|copilot|coderabbit|codex` (case-insensitive) — instead of re-fetching
with a shell-side `--jq` filter. `gh_evidence` with `target: "pr"` and
`fields: "comments"` is the sanctioned read-only tool path for the same PR
comment data when a tool call is preferred over a raw shell command. `gh pr
view --json comments,reviews` is convenience-only because those fields have
item caps; never use it as the authoritative "all signals" intake.

### Step 2 — Classify each comment

| Category | Action |
|----------|--------|
| **Human review with file:line evidence** | Add as candidate finding with `source: existing-review` — still needs reviewer validation |
| **Bot/automated finding with specific code reference** | Add as candidate finding with `source: bot-review` — high false-positive rate, treat as unverified |
| **General feedback / style preference** | Add as advisory obligation |
| **Resolved/outdated comment** | Skip — note in report under "Ingested Resolved Comments" |
| **Requested changes not yet addressed** | Add as HIGH-priority obligation |

### Step 3 — Merge into review pipeline

All ingested comments become candidate findings or obligations. They follow the
same Phase 3-8 pipeline as freshly discovered findings. Ingested findings are
NOT pre-confirmed — they still require independent reviewer validation per the
Anti-Self-Review Rule.

**Comment-ledger output:**
```
[INGESTED] | source | category | file:line (if applicable) | original_author | status: PENDING_VALIDATION / SKIPPED_OUTDATED / ADVISORY
```

### Anti-patterns
- ✗ Ignoring bot reviews because "bots produce false positives" — they also catch real issues
- ✗ Pre-confirming human review comments without independent validation — even senior reviewers make mistakes
- ✗ Skipping inline review comments and only reading the summary — inline comments contain the evidence

## Phase 0B: Mergeability and Branch-State Intake

Before investing effort in review lanes, verify the PR is mergeable and record
branch-state signals. `PR_REVIEW` remains read-only: do not resolve conflicts,
commit, push, rebase, merge, or reset from this mode. Instead, carry current
mergeability, stale-head, and branch-drift facts into the review ledger and the
feedback handoff artifact.

### Step 1 — Check merge state

The field names and values below are GitHub-specific examples. On another code
host, record the equivalent mergeability, conflict, required-check, base-drift,
and stale-head signals and preserve the same read-only behavior.

```bash
gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus
```

The response has two independent fields. Handle each:

**`mergeable` field** — whether GitHub can compute mergeability:
| Value | Meaning | Action |
|-------|---------|--------|
| `MERGEABLE` | No conflicts detected | Proceed — check `mergeStateStatus` below |
| `CONFLICTING` | Merge conflicts exist | Record the blocker, keep the review read-only, and hand conflict resolution to `swarm-pr-feedback` |
| `UNKNOWN` | GitHub still computing | Wait 30s, re-check |

**`mergeStateStatus` field** — overall branch state:
| Value | Action |
|-------|--------|
| `CLEAN` | All checks pass, no conflicts — proceed to Phase 0 |
| `BEHIND` | Branch behind base — note in report; non-blocking if merge queue handles it |
| `DIRTY` | Merge conflicts exist — keep reviewing, but record the conflict as a first-class blocker in the ledger and handoff artifact |
| `BLOCKED` | External blocker (branch protection, failing required check) — investigate and record the blocker |

### Step 2 — Record conflicts and blockers (when CONFLICTING or DIRTY)

When the PR has merge conflicts:

1. **Determine the PR's base branch and verify the state**, as separate
   standalone commands — never with `$(...)` command substitution, which the
   PR_REVIEW gate blocks:
   - Read the base ref: `gh pr view <PR_NUMBER> --json baseRefName` (or
     `gh_evidence` with `target: "pr"`, `fields: "baseRefName"`).
   - Fetch it by its literal value, substituted for `<base-ref>`:
     `git fetch origin <base-ref>`.
   - Re-check merge state: `gh pr view <PR_NUMBER> --json
     mergeable,mergeStateStatus,baseRefName,headRefName`.

2. **Capture the affected scope without changing the branch:**
   - List the files or subsystems implicated by the conflict if GitHub exposes them,
     or note that the exact conflict set is still unknown.
   - Identify whether the conflict appears mechanical (lockfile / generated output /
     simple overlap) or semantic (logic changed on both sides). This is triage
     signal for the follow-on feedback run, not permission to resolve it here.

3. **Record explicit next action for the handoff artifact:**
   - `CONFLICT-### | mechanical | likely resolvable during pr-feedback`
   - `CONFLICT-### | semantic | requires focused fix + validation during pr-feedback`
   - `STALE-### | behind base by policy` when the branch is only stale, not conflicted

4. **Document in report:** List the branch-state facts, why they matter to the
   review, and what `swarm-pr-feedback` must verify before it edits code.

### Conflict resolution anti-patterns
- ✗ Accepting "ours" or "theirs" for all conflicts without reading them
- ✗ Resolving semantic conflicts without understanding both sides
- ✗ Pushing resolution without running tests on the merged result
- ✗ Treating `PR_REVIEW` as the place to fix branch state — this mode stays read-only

## Phase 0B-bis: Pre-Handoff Parallel Work Snapshot

When the review surfaces findings that will likely need `swarm-pr-feedback`,
re-check for **parallel work** since the last fetch. The PR author, the bot
reviewer, or another swarm may have pushed commits while you were reviewing.
This is still read-only: capture the remote state so the handoff artifact starts
from the right branch facts.

### Step 1 — Compare remote state (read-only, no post-bind fetch)

Once the PR head is bound, the gate allows only the exact bound tracking
fetch (when one is armed), and a detached review HEAD has no tracking branch
to refetch against — `git fetch origin <pr-branch>` is blocked here. Compare
state through the read-only API instead, as one standalone command:

```bash
gh pr view <PR_NUMBER> --json headRefOid,commits
```

or the equivalent `gh_evidence` call with `target: "pr"` and
`fields: "headRefOid,commits"`. If the returned `headRefOid` differs from the
`pr_head_sha` bound at the start of this review, the remote has moved; the
`commits` field lists every commit's message and author to date, enough to
judge relevance to the pending findings. (The legitimate place to `git fetch`
is the pre-bind sequence under "Pre-flight git ref availability" above — this
step never repeats that fetch post-bind.)

### Step 2 — Evaluate new commits

For each new commit on the remote (identified by comparing `headRefOid` /
`commits` above against the SHA bound at the start of the review):

1. **Read the commit message from the `commits` field above.** For file
   scope, use one standalone read-only call —
   `gh api repos/{owner}/{repo}/commits/<sha>` — rather than a local
   `git show`: the new commit's object is not fetched locally post-bind.
2. **Compare against the pending handoff scope:**
   - Does the remote commit touch the same files as the validated findings?
   - Does the remote commit appear to already address a finding you planned to
     hand off?
   - Does the remote commit introduce a new branch-state fact the handoff should
     mention?
3. **Default stance: prefer the remote state as the next baseline.** When the
   bundled copy is available (plugin runtimes), run the
   `file:.swarm/bundled-skills/parallel-work-check/SKILL.md`
   protocol for the formal decision template; otherwise apply the three
   outcomes below directly. Record the outcome in the handoff artifact.

### Step 3 — Three outcomes

- **Parallel work supersedes:** Mark the older local checkout as stale in the
  handoff artifact and tell `swarm-pr-feedback` to re-check out the current
  remote head before editing.
- **Parallel work complements:** Carry both the validated findings and the new
  remote commits into the handoff artifact so `swarm-pr-feedback` can verify the
  combined state before patching.
- **Parallel work unrelated:** Note that the remote moved, but keep the same
  validated finding set.

### Anti-patterns

- ✗ Pushing your fix without checking if the remote already fixed it — causes
  duplicate work and may even fail the push if the commits conflict
- ✗ Force-pushing over parallel work because "I started this first" — the
  parallel agent may have access to context you don't (different swarm
  configuration, different model, different time budget)
- ✗ Blindly taking remote work without verifying it's actually better — the
  parallel work may be incomplete or take a different approach that doesn't
  match the original finding's intent

### Example: parallel swarm superseded local fix work

```
PARALLEL WORK CHECK (pre-fix):
- Branch: copilot/fix-legacy-hive-data-migration
- Local HEAD: 3c04997c fix: resolve PR #1238 review findings
- Remote HEAD: 79d7ec64 fix(knowledge-migrator): harden legacy migration loop
- Diverged: yes (remote is 2 commits ahead with more comprehensive fix)
- New commits on remote: 2
- Parallel swarm work detected: yes (different author)
- Decision: abandon-use-remote
- Rationale: Remote added 17 unit tests + try/catch error handling that
  surpassed my planned batch-rewrite. Verified by re-running the test suite:
  remote has 25/25 passing, my local plan would have produced 9/9.
```

---

# Default Review Workflow

## Phase 0: Context Pack and Review Signal Collection

Before launching explorers, build a compact `swarm-pr-review-context` in scratch or as a local artifact if file writes are allowed.

The context pack must include, when available:

```json
{
  "scope": {
    "base_ref": "...",
    "head_ref": "...",
    "commit_range": "...",
    "changed_files": [],
    "changed_hunks": [],
    "public_api_changes": [],
    "deleted_or_renamed_files": [],
    "generated_files": []
  },
  "pr_metadata": {
    "title": "...",
    "body_claims": [],
    "checkboxes": [],
    "linked_issues": [],
    "review_comments": [],
    "commit_messages": []
  },
  "obligations": [],
  "repo_graph": {
    "source": ".swarm/repo-graph.json or fallback search",
    "changed_symbols": [],
    "callers": [],
    "callees": [],
    "imports": [],
    "exports": [],
    "sibling_implementations": []
  },
  "deterministic_signals": {
    "ci": [],
    "tests": [],
    "coverage_delta": [],
    "lint_typecheck_build": [],
    "security_scanners": [],
    "dependency_audit": [],
    "secrets_scan": [],
    "mutation_testing": []
  },
  "swarm_artifacts": {
    "evidence_bundles": [],
    "knowledge_hits": [],
    "phase_state": [],
    "metrics": []
  },
  "risk_triggers": []
}
```

### Context pack rules

- Diff-only review is allowed for quick orientation, but not enough to confirm nontrivial findings.
- For every changed production file, identify at least one caller, consumer, import path, route entrypoint, or reason none exists.
- If `.swarm/repo-graph.json` exists, use it to seed impact cones.
- If no repo graph exists, build a shallow impact cone using imports, exports, symbol search, route registration, CLI registration, or test references.
- Pull in relevant `.swarm/evidence/`, `.swarm/state`, `.swarm/knowledge`, or hive/project knowledge entries when present.
- Historical knowledge may guide candidate generation but cannot confirm a finding by itself.
- Mark stale, quarantined, or cross-project knowledge as advisory until independently verified in this repo.

---

## Review Finding Persistence

Do not rely on conversation context to preserve review findings. On Profile A,
use `write_pr_review_artifact` with `kind: "findings"`; the controller creates
and appends `.swarm/pr-review/<run_id>/findings.jsonl` without granting generic
write authority over `.swarm/`. On Profiles B/C, append the same records to a
`findings.jsonl` ledger file in your harness's session/task workspace (never
under `.swarm/`), with the review head SHA recorded at the top of the file.

Each persisted finding record must include at least:

```json
{"finding_id":"F-001","status":"PENDING","file_line":"src/file.ts:123","evidence":"quote, command output, lane id, or reviewer rationale","next_action":"route_to_reviewer"}
```

Minimum field contract:

- `finding_id`: stable ID from the candidate/reviewer/critic ledger.
- `status`: one of `PENDING`, `CONFIRMED`, `DISPROVED`, or `PRE_EXISTING`.
- `file_line`: exact `file:line` reference, or `N/A` with reason when the
  finding is cross-file or artifact-only.
- `evidence`: compact source-backed proof, including lane/reviewer/critic IDs or
  command output references when available.
- `next_action`: the next required action, such as `route_to_reviewer`,
  `route_to_critic`, `report`, `suppress_with_reason`, or `handoff_to_feedback`.

Persist after every major validation boundary (Profile A via the controller
calls below; Profiles B/C by appending the same boundary-tagged records to the
ledger file):

1. **Post-explorer:** after Phase 3/4 candidate parsing and before reviewer
   dispatch, call `write_pr_review_artifact` with `boundary: "post_explorer"`
   and all candidates as `PENDING` with their lane provenance.
2. **Post-reviewer:** after Phase 6 reviewer validation, call the controller
   with `boundary: "post_reviewer"` and update each reviewed
   record to `CONFIRMED`, `DISPROVED`, `PRE_EXISTING`, or keep `PENDING` with a
   concrete `next_action` if more evidence is required.
3. **Post-critic:** after Phase 8 critic challenge, call the controller with
   `boundary: "post_critic"` and update final status,
   severity/action notes in `evidence`, and final reporting or handoff action.

Resume/reload procedure:

1. Before continuing any compacted or resumed review, read the latest
   `findings.jsonl` artifact and reconstruct the candidate/reviewer/critic
   ledger from disk before dispatching more lanes.
2. If the artifact is missing but a review context says prior lanes ran, stop and
   surface the missing artifact as a coverage gap instead of reclassifying from
   memory.
3. Append new records rather than overwriting history unless the artifact format
   explicitly tracks revisions; latest record for a `finding_id` wins during
   reload.

---

## Phase 1: Intent Reconstruction / Obligation Extraction

Reconstruct what the PR is obligated to deliver before looking for bugs.

Use deterministic precedence, highest to lowest:

1. PR checkboxes and acceptance criteria,
2. linked issues / tickets,
3. explicit user request in the current conversation,
4. commit scopes and commit messages,
5. test names and test assertions,
6. interface diff / exported API changes,
7. changelog, README, migration, or docs edits,
8. LLM synthesis only when no higher-precedence source exists.

Output an obligation list:

```text
O-001 | source | claim | affected files/symbols | status: UNVERIFIED | evidence refs: []
```

For each obligation, record:

- source,
- exact claim,
- affected files or symbols,
- verification status: `UNVERIFIED → IN_PROGRESS → MET / PARTIALLY_MET / NOT_MET / UNVERIFIABLE`,
- linked finding ID when unmet,
- reason if unverifiable.

Tests are claims. A passing or added test does not prove the obligation unless the reviewer inspects the assertion strength and relevant code path.

### Quantitative claim verification

PR body numerical claims (test counts, coverage percentages, assertion counts, performance benchmarks) are obligations, not proof. For each quantitative claim:

1. Extract the claim and its source (PR body, comment, commit message).
2. Verify against actual tool output or CI artifacts when available.
3. If the claim cannot be independently verified, mark the obligation `UNVERIFIABLE` with reason.
4. If the claim is disproved by evidence, create a finding linking the discrepancy.

Common patterns to verify:
- "N tests pass" → count actual test results from CI logs or test runner output
- "N% coverage" → compare against coverage report
- "No regressions" → verify against test runner failure count

---

## Phase 2: Deterministic Signal Ingestion

Ingest deterministic signals as candidate generators. They are never final findings.

Use available local artifacts first. Run safe read-only or standard project validation commands only when appropriate for the environment.

Candidate signal sources include:

- CI failures and logs,
- test failures,
- coverage delta,
- lint/typecheck/build output,
- `git diff --check`,
- dependency audit output,
- lockfile diff,
- CodeQL alerts,
- Semgrep or SAST findings,
- secrets scan findings,
- license scan findings,
- mutation testing output,
- package manager warnings,
- generated schema diffs.

Record each signal as:

```text
[TOOL_CANDIDATE] | tool | severity | file:line | claim | raw_signal_summary | confidence
```

Tool candidate rules:

- Confirm reachability before reporting.
- Confirm PR-introducedness before reporting as a PR blocker.
- Confirm that a framework, schema, middleware, caller guard, or test isolation rule does not already mitigate it.
- Do not report scanner output verbatim without reviewer validation.
- Redact secrets; never paste raw credentials into the final output.

---

## Phase 3: Parallel Base Explorer Lanes

### Review depth tiers (size × risk)

Before dispatching, classify the PR into a depth tier from the context pack.
Record the tier and the active capability profile in the ledger and in the
final validation provenance. The tier scales how many subagents you spawn —
never which review dimensions or risk families get evaluated:

| Tier | Diff shape | Dispatch shape (Profiles B/C) |
|---|---|---|
| S | ≤ ~50 changed lines, ≤ 3 files, no risk triggers | Consolidate: 1–2 explorer lanes covering all six dimensions (B), or one candidate-generation pass (C); Phase 4 risk families fold into the same lanes as an explicit per-family checklist |
| M | ≤ ~500 changed lines, or any risk trigger | Dedicated lanes for the triggered dimensions/families; consolidate the remaining thin dimensions into 1–2 lanes |
| L | > ~500 changed lines, > ~20 files, multi-subsystem, or security-sensitive surface | Full fan-out: one lane per dimension (six) and per-family micro dispatch in Phase 4 |

Risk triggers (any one escalates to at least tier M, and the triggered
dimension/family always gets a dedicated lane at M and above):
auth/identity/sessions/permissions/secrets/cryptography; untrusted-input
parsing or new input/output boundaries; subprocess/shell/filesystem execution;
concurrency, state machines, retries, caching; dependency, lockfile, install,
CI, or release changes; public API, schema, config, or migration changes;
payments or PII handling; generated, vendored, or binary artifacts.

Scaling is one-directional: a larger tier or an active controller may demand
more lanes than the table; nothing — repository size, elapsed time, token
cost, or predicted simplicity — permits fewer lanes than the classified tier,
and no tier permits skipping a dimension or family. Under Profile A the
controller computes the tier itself from the bound `base_sha...pr_head_sha`
diff (`--numstat` totals; an uncomputable diff fails strict to tier L) and
mechanically enforces the matching floors on every base and micro batch —
initial waves and retries alike: tier L requires the historical
full fan-out (six singleton base lanes, one micro-lane per family, on every
batch, not only the first), while
tiers S and M accept consolidated lanes that declare their complete
`owned_workflow_lanes` set — every dimension and family still owned exactly
once and attested per family. Risk triggers remain caller-side escalation on
every profile: dispatch MORE than the floor whenever a trigger warrants it.

### Dispatch

Under Profile A, launch all base lanes with `dispatch_lanes_async`. Pass the six
lane specs together, set `mode: "swarm-pr-review:base"`, assign each lane its
exact `workflow_lane` identifier from the table below, set `max_concurrent` to
`6`, bind the batch with the exact current `pr_head_sha`, record the returned
`batch_id`, and pass the exact reviewed merge base and its live base tip/ref as
`base_sha` and `base_ref`. Every later base retry, micro, council, reviewer, and
critic dispatch repeats those same exact bindings. The controller recomputes
`git merge-base -- <base_ref> <pr_head_sha>`, rejects mismatches, and replaces
caller `scope` text with the complete verified `base_sha...pr_head_sha` PR diff;
caller scope is retained only as a non-authoritative focus hint. Continue only non-dependent architect
work: refine the obligation ledger, inspect PR metadata, prepare micro-lane
trigger checks, and run deterministic read-only local tools. The runtime rejects
partial, duplicate, mislabelled, or non-explorer base waves. Do not synthesize
findings from running lanes. Keep each lane `prompt` compact: send the shared
review context (PR diff, obligation ledger, scope) ONCE via the `common_prompt`
field, or have lanes read it from a file by absolute path, instead of inlining
the same large blob into all six prompts — oversized inline prompts produce
malformed or truncated tool-call JSON and force clumsy file workarounds.

All six dimensions must be covered on every PR — "small PR", "docs-only", and
"CI-only" change what each dimension examines, never whether it is evaluated.
Every dimension ends in its own `[CANDIDATE]` rows or a fully populated
per-dimension `[CLEAN]` attestation. Under Profile A at depth tier L this is an exact six-lane gate, not a soft target: the controller rejects an initial base wave with fewer than six singleton lanes, and the review is BLOCKED until the missing lanes are dispatched and settled; "time-saving" is not an exception. At tiers S and M the controller instead requires the initial wave's `owned_workflow_lanes` to partition all six dimensions exactly once across at least the tier's lane floor (S ≥ 1, M ≥ 3, `max_concurrent` equal to the lane count), and settlement demands per-dimension attestation from every consolidated lane — a lane that fails any owned dimension fails them all. Under Profiles B/C, the depth tier governs lane count the same way — a tier-S diff may cover the six dimensions in one or two consolidated lanes — while dimension coverage and per-dimension attestation remain mandatory.

Under Profile B, dispatch the same wave as parallel subagents through your
harness's subagent tool: one subagent per dimension by default, consolidated
per the depth tier for small diffs. Every lane prompt must carry the exact
`pr_head_sha`, the verified `base_sha...pr_head_sha` range, its assigned
`workflow_lane` identifier(s), and the explorer context contract below; append
every returned report to the findings ledger with its lane id and head SHA
before any reviewer dispatch. Under Profile C, run the same lanes as
sequential candidate-generation passes with the same per-lane ledger records.
The join barrier is universal: all base lanes settle before Phase 4 completes
or synthesis begins, whichever layer enforces it.

**Incremental collection (Profile A):** While base lanes are running, poll with `collect_lane_results` (without `wait` (or `wait: false`)) to check progress and process settled lanes as they complete — call `retrieve_lane_output` for full text when `output_ref` is present, then extract candidates via `parse_lane_candidates`, update the candidate ledger, validate output quality — while continuing independent architect work (obligation refinement, micro-lane trigger checks, local reads) between polls. Only use `wait: true` if lanes are still pending and no more independent work remains. Under Profile B, harvest each subagent report as it completes and update the ledger between arrivals; block on stragglers only when no independent work remains.

Before Phase 4 or synthesis, all base lanes must be settled. `dispatch_lanes_async` accepts a maximum of 8 lanes per call; base lanes (6) and micro-lanes (Phase 4) are dispatched in separate calls by design. Do not let one lane's conclusions bias another lane.

**COVERAGE GATE — zero tolerance for unclosed gaps.** After `collect_lane_results`, verify every lane produced validated output. Two failure modes exist:
- **Mode A (empty output):** Lane returns 0 chars, `status: cancelled`, `output_digest` matches SHA-256 of empty string (`e3b0c442...b855`).
- **Mode B (intermediate reasoning only):** Lane reports `status: completed` with non-empty output, but the output is preliminary reasoning ("Now let me check...") with zero `[CANDIDATE]` rows and no parseable `[CLEAN] | workflow_lane | coverage_scope | evidence` attestation. The `output_digest` does NOT match the empty-string hash. `parse_lane_candidates` returns 0 candidates. This mode is MORE dangerous — the lane appears successful but produced no findings or clean proof.

For ANY lane that failed (either mode):
1. **Retry** (max 2 attempts) with materially different parameters — different session or prompt decomposition, while preserving the required structured async mode and exact head provenance.
2. If a base lane fails under Profile A, retry only the failed `workflow_lane` identifiers with `dispatch_lanes_async`, `mode: "swarm-pr-review:base"`, the same exact `pr_head_sha`, and explorer agents. The durable gate joins successful provenance across the initial wave and retry batches. While that controller is active, blocking `dispatch_lanes` and direct Task dispatch are not equivalent because they cannot satisfy the structured provenance gate. Under Profiles B/C, retry only the failed `workflow_lane` identifiers with a fresh subagent or pass, the same exact `pr_head_sha`, and a materially different prompt decomposition.
3. If no equivalent alternative can be verified, **STOP and surface the lane failure to the user as BLOCKED** with the lane id, scope, failure mode, retry attempts, and why equivalence could not be proven. Do not present partial findings, do not issue a review verdict, and do not synthesize from successful lanes. A low-quality partial review is worse than no review.

### Candidate extraction via parser

Under Profile A, after `collect_lane_results` returns for base lanes, process
each lane result that carries an `output_ref`. The orchestrator MUST use the
candidate parser rather than preview-text extraction:

1. For each `output_ref`, call `parse_lane_candidates` with `output_ref`,
   `producer: "swarm-pr-review"`, and `expected_family: "base_explorer"`. The parser reads
   the full artifact from disk (no preview truncation issue) and returns
   structured `ParseResultWithSidecar` records.
2. Filter the returned `candidates[]` by `producer: "swarm-pr-review"` plus the
   exact `source_batch_id` and `source_lane_id` from the base dispatch. Treat a
   family mismatch or parse error as a lane-output failure; family metadata is
   not the acceptance boundary.
3. Group the filtered candidates into reviewer-sized chunks:
   - by file area (group by the directory or module of the `file_line` field),
   - by category (group by the `category` field),
   - by count (target max 50 candidates per chunk; smaller chunks are fine).
4. Stage reviewer-sized chunks, but do not dispatch reviewers yet. Phase 4 must
   complete trigger accounting and settle every launched micro-lane first.

If a lane has `output_degraded: true`, `transcript_incomplete: true`, or no usable `output_ref`, apply the COVERAGE GATE (Phase 3). Do not use blocking or direct-Task fallbacks while the controller is active, mark affected candidates UNVERIFIED to proceed, or infer candidate absence from a preview. Under Profiles B/C, a truncated, empty, or attestation-free subagent report is the same lane-output failure and takes the same COVERAGE GATE.

After candidate parsing and before reviewer dispatch, persist the post-explorer
candidate ledger using the Review Finding Persistence contract. This is the
durable recovery point for context compaction before Phase 6.

**Profiles B/C row convention:** without the parser, the `[CANDIDATE]` row
format is the extraction contract itself. Explorers emit the rows directly in
their reports (see the Explorer Prompt Template reference); the orchestrator
collects them verbatim, validates each row's field count and lane id, and
treats malformed rows — or output with neither `[CANDIDATE]` rows nor a fully
populated `[CLEAN]` attestation — as a lane-output failure under the COVERAGE
GATE. If the parser is unavailable under Profile A, the same row convention
applies as a fallback, but the orchestrator SHOULD use the parser as the
primary extraction mechanism.

**lane id uniqueness for parallel dispatches:** When re-dispatching failed or
re-running explorer lanes, every `dispatch_lanes_async` or `dispatch_lanes`
lane `id` MUST be unique within that dispatch batch and should include lane and
attempt suffixes (e.g., `pr_review_explore_lane1_attempt2`). Never reuse an id
in the same batch unless intentionally replacing that exact lane before dispatch.

Explorers optimize for recall. Over-reporting is expected. Explorers produce candidates only.

The six dimensions are a fixed **check-type** partition, not an area
partition: every PR needs all six review dimensions, and the lanes
deliberately overlap by file, each receiving the same diff (via
`common_prompt` under Profile A) and viewing it through a different lens. Six
dimensions are this workflow's high-assurance coverage floor, not a claim that
research proves a universal optimal agent count — the published evidence
favors complementary, distinct-lens reviewers over duplicated generalists, and
finding rates rise with diff size, which is why dispatch (not coverage)
follows the depth tier. Repository policy may add scrutiny but may never
reduce the six dimensions. Coverage is guaranteed by all six dimensions
reading the whole diff, so the disjoint-partition rule that governs area-split
fan-outs does not apply.

| `workflow_lane` | Focus | Required checks |
|---|---|---|
| `intent-architecture` | Intent, scope, architecture, and integration | obligation mapping, design fit, callers/consumers, sibling patterns, docs and claimed-vs-actual behavior |
| `correctness-state` | Functional correctness, data/state flow, edge cases, and failure paths | input domains, nullability, ordering, transactions, error behavior, rollback, backwards behavior |
| `tests-falsifiability` | Tests, test validity, regressions, and claimed validation | assertion strength, negative paths, isolation, fixtures, deterministic timing, missing proof |
| `security-trust` | Security, privacy, trust boundaries, unsafe inputs/sinks, and supply chain | authorization, injection, secrets, provenance, dependency risk, data exposure, abuse paths |
| `reliability-performance` | Reliability, concurrency, retries, resource bounds, and performance | races, retry semantics, timeouts, lifecycle, caching, algorithmic cost, operational failure modes |
| `compatibility-delivery` | API/schema/config compatibility, maintainability, build/deploy, docs, and release behavior | public contracts, migrations, runtime/platform support, packaging, CI, rollout and recovery guidance |

### Explorer context contract

Every explorer must inspect or explicitly mark unavailable:

1. the changed hunk,
2. at least one caller, consumer, or downstream impact-cone node,
3. at least one callee, dependency, or upstream assumption,
4. at least one sibling implementation or prior pattern,
5. the nearest relevant test or missing-test location,
6. deterministic signal entries mapped to its files/symbols,
7. relevant Swarm knowledge/evidence entries, if present.
8. the exact bound review range to analyze (`base_sha...pr_head_sha`),

### Explorer output format

Explorers emit structured candidate records. The parser reads the full lane
artifact and extracts these records. The canonical record shape is:

```text
[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence: LOW/MEDIUM/HIGH
```

Under Profile A the parser normalizes this into a structured `candidates[]`
array. On Profiles B/C — and as a Profile A fallback when the parser is
unavailable — the explorer emits the `[CANDIDATE]` row format directly in the
lane output as the extraction contract.

Explorers must not use `CONFIRMED`, `DISPROVED`, or `PRE_EXISTING`.

A base lane that finds no surviving candidates must emit exactly one fully
populated clean row:

```text
[CLEAN] | workflow_lane | coverage_scope | evidence
```

Header-only `[CLEAN]` markers, prose-only "clean" claims, or empty output do
not settle the lane.

---

## Phase 4: Mandatory Repository-Agnostic Micro-Lanes

After base lanes settle, inspect the exact diff/context pack to focus every row
in the micro-lane map and print a mandatory ledger with one row per map row:

```text
[TRIGGER-EVAL] | trigger_row | MATCHED | focus_evidence
```

Focus evidence must name the changed files, manifests, imports/symbols, semantic
signals, or explicit absence conditions the lane should examine. `MATCHED` means
the family's evaluation is required, not that a keyword heuristic guessed
applicability.
Repository identity, technology stack, PR size, elapsed time, or predicted risk
never justifies skipping a row.

Every row in the map is a risk **family** that must be evaluated against the
diff on every PR, in every repository. What scales with the depth tier is the
dispatch shape — how many subagents carry that evaluation — never the
evaluation itself. Each family must end in its own attestation: `[CANDIDATE]`
rows naming the family, or one fully populated per-family `[CLEAN]` row.

**Profile A dispatch.** Launch the micro coverage with
`dispatch_lanes_async` and `mode: "swarm-pr-review:micro"`. At depth tier L,
dispatch one focused micro-lane for every row, each lane's
`workflow_lane` equal to its trigger ID; because the dispatcher accepts at
most eight lanes per call, split the
eleven mandatory micro-lanes across bounded async batches. At tiers S and M,
consolidated lanes may each own several families: set `workflow_lane` to one
owned trigger ID and declare the complete `owned_workflow_lanes` set — every
family owned exactly once across the dispatch, and every owned family
attested in that lane's output, or the lane fails for all of them. Include
the complete exact-set
`trigger_evaluation` ledger and the same exact current `pr_head_sha` in every
micro dispatch, in a separate batch from base lanes. The runtime rejects
unrelated or duplicate micro-lanes within a batch, and final ledger persistence
rejects any row whose completed owning-lane provenance is absent.
Poll incrementally, then settle every launched lane. Persist
the complete ledger with `write_pr_review_trigger_eval`; its rows use the stable
trigger IDs below, and every row includes its returned `source_batch_id` and
`source_lane_id`. Missing, extra, duplicate, `NO-MATCH`, or unprovenanced
rows make persistence fail and Phase 4 BLOCKED. The tool atomically writes
`.swarm/pr-review/<run_id>/trigger-eval.json`, separate from `findings.jsonl`;
pass the exact reviewed merge-base as `base_sha`, the exact live base branch
tip/ref used to compute it as `base_ref`, and the same `pr_head_sha` to the
writer. The writer runs bounded `git merge-base -- <base_ref> <pr_head_sha>` and
rejects any claimed `base_sha` that is not the exact result. It accepts only the
exact eleven-row `MATCHED` set, each row backed by a completed, non-degraded,
exact-head artifact from a lane that declared ownership of that family and
attested every family it owns. It never uses keyword
classification as permission to waive a family. Any head mismatch makes
persistence fail.
Do not add trigger results to the finding-status enum.

**Profiles B/C dispatch.** Scale the lane shape to the depth tier while
keeping all eleven family evaluations:

- Tier L: one focused lane per family, mirroring Profile A.
- Tier M: a dedicated lane for every risk-triggered family; consolidate the
  remaining families into one or two sweep lanes that each carry an explicit
  per-family checklist.
- Tier S: fold the full eleven-family checklist into the base wave's lanes
  (B) or into one consolidated micro sweep or sequential checklist pass (C).

Whatever the dispatch shape: the ledger keeps one `[TRIGGER-EVAL]` row per
family; each row's focus evidence names the lane or pass that evaluated it;
each family gets its own `[CANDIDATE]`/`[CLEAN]` attestation naming the family
id; and the completed ledger is persisted as `trigger-eval.json` in the
session/task workspace before reviewer dispatch. A family with no attestation
row is an unclosed coverage gap, exactly as if a Profile A lane had failed.

For each micro `output_ref` (Profile A), call `parse_lane_candidates` with
`producer: "swarm-pr-review"`, `expected_family: "micro_lane"`, and
`expected_micro_lane` set to the launch-micro-lane value from the
provenance-linked trigger row. When the artifact came from a consolidated
tier-S/M lane (its dispatch declared more than one `owned_workflow_lanes`
entry), also pass `expected_micro_lanes` set to that lane's complete
`owned_workflow_lanes` array — the same set already declared at micro
dispatch time. Without it, the parser has no way to tell a sibling owned
family's row from a genuinely out-of-scope one: every row belonging to the
lane's other owned families is treated as a parse error instead of being
skipped as out-of-scope, which can also invalidate that lane's own otherwise-valid
`[CLEAN]` attestation for the family being extracted. Omit `expected_micro_lanes`
only for a singleton (tier-L) lane. Accept a candidate only when its `producer`,
`source_batch_id`, and `source_lane_id` match an allow-listed tuple from the
original or retry micro dispatch and its `micro_lane` matches that trigger row;
never filter acceptance by `row_format_family`. A zero-candidate artifact is
clean only when the parser returns exactly one provenance-matching persisted
`clean_attestation` whose `micro_lane` matches the trigger row, zero parse
errors, zero malformed rows, and a complete, non-degraded source:

```text
[CLEAN] | micro_lane | coverage_scope | evidence
```

Header-only or malformed zero output is `UNATTESTED`; apply the COVERAGE GATE (Phase 3). Under Profile A, the structured async PR-workflow path is required to preserve `L1`, exact-head, batch, and workflow-lane provenance; the active controller rejects blocking and direct-Task substitutes, and Task-derived findings or CLEAN prose cannot satisfy Phase 4's controller ledger. Under Profiles B/C, acceptance is the row contract itself: accept a candidate or clean row only when its `micro_lane` field matches the trigger row it claims, and treat prose-only "clean" claims as `UNATTESTED`.

Each micro-lane receives:

- exact files and hunks in scope,
- related obligations,
- impact cone entries,
- relevant deterministic signals,
- related historical knowledge with quarantine/staleness status,
- expected invariants,
- structured candidate output — parser-extracted under Profile A; on Profiles
  B/C the micro-lane emits `[CANDIDATE]`/`[CLEAN]` rows directly as the
  extraction contract.

### Repository-agnostic mandatory micro-lane map

Every row is evaluated in every repository. Diff/context analysis focuses each
family's evaluation but cannot waive it: semantic applicability is not reliably
decidable from paths or keywords, so `NO-MATCH` is invalid. Repository policy
may require supplementary specialist review outside this canonical ledger, but
supplementary work never replaces these portable rows. The `unclassified-risk`
family is always evaluated to cover novel failure modes and classification
gaps.

> **Trigger-ID namespace — do not mix (issue #1931).** The `trigger_id` field
> passed to `write_pr_review_trigger_eval` accepts **only** the 11 micro-lane
> IDs in the table below. Three different namespaces appear in this skill and
> they are NOT interchangeable:
>
> | Namespace | Example values | Used where? | Valid as `trigger_id`? |
> | --- | --- | --- | --- |
> | Micro-lane IDs (this table) | `auth-identity-secrets`, `untrusted-input-boundaries`, ... | `workflow_lane` of `swarm-pr-review:micro` dispatch; `trigger_id` of trigger-eval rows | **YES — only these** |
> | Base-lane IDs | `intent-architecture`, `correctness-state`, `tests-falsifiability`, `security-trust`, `reliability-performance`, `compatibility-delivery` | `workflow_lane` of `swarm-pr-review:base` dispatch; validated by `enforcePrReviewBaseDimensions` | NO |
> | Dispatch modes | `swarm-pr-review:base`, `swarm-pr-review:micro`, `swarm-pr-review:reviewer`, `swarm-pr-review:critic` | `mode` field of `dispatch_lanes_async` | NO |
>
> The writer rejects unknown trigger IDs with the list of valid IDs. Short
> informal names (`correctness`, `security`, `deps`, `docs`, `tests`, `perf`)
> sometimes appear in prose summaries; they are shorthand, not literal IDs.

| Trigger ID | Scope | Trigger in diff or context pack | Launch micro-lane | Invariants to check |
|---|---|---|---|---|
| `auth-identity-secrets` | universal | authentication, authorization, identity, sessions, permissions, secrets, cryptography | Identity and secret boundaries | least privilege, confused-deputy paths, credential lifecycle, cryptographic misuse, safe defaults |
| `untrusted-input-boundaries` | universal | parsing, serialization, queries, templates/rendering, file or network input/output | Untrusted input and sink analysis | injection, traversal, SSRF, unsafe deserialization, output escaping, resource limits |
| `subprocess-platform` | universal | subprocesses, shell commands, filesystem operations, OS/runtime-specific code | Subprocess and platform safety | array argv, bounded execution, path containment, portability, cleanup, non-interactive behavior |
| `concurrency-state` | universal | queues, caches, retries, transactions, locks, state machines, async coordination | Concurrency and state transitions | races, atomicity, idempotency, retry accounting, rollback, stale state, bounded growth |
| `dependencies-build-release` | universal | dependency manifests, lockfiles, installers, build scripts, CI, packaging, deployment | Dependency and delivery integrity | provenance, version/lock consistency, install safety, platform matrices, rollback and release completeness |
| `api-schema-migrations` | universal | public API, wire/schema/config/storage formats, migrations, feature flags | Compatibility and migration safety | backward/forward compatibility, defaults, validation, mixed-version operation, recovery |
| `test-infrastructure` | universal | tests, mocks, fixtures, harnesses, coverage, CI matrices | Test validity and isolation | meaningful assertions, contamination, determinism, negative paths, cross-platform proof, test theater |
| `ui-accessibility-i18n` | universal | user interfaces, interaction flows, rendering, accessibility, localization | UI and human-interface quality | keyboard/screen-reader behavior, focus, error states, responsive behavior, locale-safe formatting |
| `privacy-observability` | universal | telemetry, logs, analytics, traces, retention, diagnostics | Privacy and observability safety | minimization, redaction, consent, retention, stable metrics, non-gameable evidence |
| `generated-provenance` | universal | generated, vendored, binary, model-produced, codegen or checked-in build artifacts | Generated artifact provenance | reproducibility, source linkage, tamper evidence, reviewable diffs, licensing and stale output |
| `unclassified-risk` | universal | any changed artifact or behavior not confidently classified by the rows above | Unclassified high-risk fallback | full change-path review, hidden trust boundaries, novel failure modes, missing specialist classification |

Micro-lane output format:

```text
[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence
[CLEAN] | micro_lane | coverage_scope | evidence
```

---

## Phase 5: Swarm-Native Verifier Routing

Use Swarm-native agents and artifacts when available. If exact agent names are unavailable, route the same task to the closest equivalent reviewer/critic role. On harnesses without the plugin, most `.swarm/` artifacts will not exist: mark those rows N/A in the validation provenance rather than fabricating them.

| Swarm verifier / artifact | When to use | Purpose |
|---|---|---|
| `critic_drift_verifier` | obligation-vs-code, docs-vs-code, phase/gate changes, schema/config changes | detect drift between stated behavior and actual implementation |
| `critic_hallucination_verifier` | external APIs, package claims, URLs, CLI flags, GitHub behavior, model/tool names | verify claims against source or mark as unverified |
| `curator_phase` | before exploration and after synthesis | retrieve relevant lessons; write back confirmed true positives / false positives |
| `test_engineer` | confirmed/borderline correctness, security, state, schema, or config findings | propose or run falsification probes and regression tests |
| `.swarm/repo-graph.json` | all nontrivial code changes | build impact cones and sibling-pattern checks |
| `.swarm/evidence/` | schema, phase, state, council, and guardrail changes | verify evidence compatibility and serialized provenance |
| Tool-returned `.swarm/evidence/` artifacts | after synthesis | record review quality only at paths actually returned by invoked evidence tools; never invent a metrics path |

Verifier output is advisory until incorporated by the independent reviewer or critic.

---

## Phase 6: Independent Reviewer Confirmation

**Reviewer-dispatch join barrier:** reviewer dispatch MUST NOT begin until the micro-lane ledger is
complete and persisted, every launched micro lane is settled with all eleven
families attested (under Profile A: all eleven micro-lanes settled), and every
accepted micro result has parser-derived provenance (Profile A) or a valid
CLEAN attestation.

Route candidates to reviewer subagents. The orchestrator routes candidates
in bounded chunks produced by the candidate extraction in Phase 3-4. Each
reviewer lane receives a bounded list of candidates from a single chunk — by
file area, category, or count — not the full candidate set. The reviewer must
re-read the candidate's file:line evidence and relevant context pack entries
directly.

Under Profile A, dispatch reviewer chunks with `dispatch_lanes_async`,
`mode: "swarm-pr-review:reviewer"`, a unique non-empty `workflow_lane` per
chunk, `review_item_ids` containing the exact candidate IDs assigned to that
chunk, reviewer-role agents only, and the same exact `pr_head_sha`. The runtime
requires one parseable `[REVIEWED]` row for every structurally assigned ID; a
single marker or partial subset cannot settle the lane. Direct Task
reviewers are rejected by the active controller because they cannot carry the
durable batch and head provenance it requires. Under Profile B, dispatch each
chunk to a fresh reviewer subagent — never the agent or conversation that
generated the candidates — carrying the chunk's candidate IDs, the exact
`pr_head_sha`, and the required checks below. Under Profile C, run a separate
reviewer pass per chunk that re-reads every cited file:line before
classifying. The one-parseable-`[REVIEWED]`-row-per-assigned-ID contract is
universal.

Under Profile A, for every structured PR-review dispatch, the runtime appends
an authoritative controller block after caller-authored prompt text. It binds the exact
`workflow_lane`, PR head, content revision, declared scope, and assigned item
IDs and explicitly forbids speed/time/token waivers. Caller prompt text cannot
override that block; output with placeholders, invented IDs, generic assurances,
or evidence unrelated to the bound lane does not settle the artifact.

Reviewer ownership is not accepted as an architect assertion. Under Profile A,
the controller derives the immutable candidate inventory from the
integrity-checked base, mandatory micro-lane, and council artifacts; under
Profiles B/C, the orchestrator derives the same inventory from the persisted
ledgers. Either way, the union of `review_item_ids` must equal that inventory
exactly, with no omitted or invented IDs. If discovery produces no candidates,
the derived sentinel is `CLEAN-REVIEW`, which still requires one independent
semantic reviewer row (a fresh subagent on Profile B; a separate reviewer pass
on Profile C).

Candidate IDs must therefore be globally unique across every discovery
artifact in the run. Prefix IDs with the stable workflow-lane ID (or use
another deterministic globally unique scheme); duplicate IDs fail closed
instead of being silently merged.

### Noise budget and universal validation

Before reviewer dispatch, the orchestrator may suppress candidates that match ANY of the following (each suppression still requires mandatory disclosure):
- purely stylistic without correctness, security, test, maintainability, or user-impact implications,
- exact duplicates of a candidate already queued for validation,
- explorer-stated confidence=LOW with zero structural evidence (no file:line, no code path, no invariant reference).

Every suppressed candidate must appear in the final report under "Suppressed Candidates" with the reason. Suppression without disclosure is a hard rule violation.

**All remaining candidates — regardless of severity — must be routed to independent reviewer validation.** Severity alone does not determine validation eligibility; it determines routing priority. A LOW-severity candidate with file:line evidence and a specific code path gets the same reviewer attention as a HIGH-severity candidate.

Candidates not routed to reviewers must be listed as UNVERIFIED with reason in the validation provenance. Do not silently drop them.

### Reviewer required checks

For each candidate, the reviewer must determine:

- exact file:line evidence,
- whether the issue is introduced by this PR or pre-existing,
- reachability from realistic execution paths,
- whether caller guards, schema validation, middleware, framework defaults, feature flags, or state-machine constraints mitigate it,
- whether tests cover the negative path,
- whether sibling files or docs must change together,
- whether the severity is justified,
- the smallest falsification probe that would prove or disprove it.

### Reviewer classifications

| Classification | Meaning |
|---|---|
| `CONFIRMED` | Evidence is real, reachable or structurally proven, and introduced or exposed by this PR |
| `DISPROVED` | Candidate claim is incorrect, unreachable, mitigated, or based on a misunderstanding |
| `UNVERIFIED` | Available evidence is insufficient to determine validity |
| `PRE_EXISTING` | Issue exists on the base branch and is not materially worsened by this PR |

### Evidence classifications

| Type | Definition |
|---|---|
| `STRUCTURALLY_PROVEN` | File:line evidence directly demonstrates the bug or violated invariant |
| `EXECUTION_PROVEN` | A test, trace, reproduction, or command demonstrates failure |
| `STATIC_TRACE_PROVEN` | Static analysis plus reviewed path/context demonstrates reachability |
| `PLAUSIBLE_BUT_UNVERIFIED` | Pattern suggests risk, but reachability or mitigation is unresolved |

Reviewer output format:

```text
[REVIEWED] | candidate_id | classification | evidence_type | final_severity | introduced_by_pr: YES/NO/UNKNOWN | file:line | rationale | falsification_probe | reviewer_id
```

For the mechanically derived `CLEAN-REVIEW` sentinel, use the same exact row
with `DISPROVED | STRUCTURALLY_PROVEN | NONE | UNKNOWN | N/A` and concrete
rationale/probe/reviewer fields; the sentinel means the reviewer independently
found no surviving actionable candidate, not that reviewer validation was
skipped.

Every reviewer response must end with one parseable `[REVIEWED]` row per
assigned candidate. A malformed `[REVIEWED]` row is not a verdict: re-dispatch
with the exact contract (max 2), then mark the reviewer dimension BLOCKED if no
valid row returns.

`DISPROVED` findings must include the reason. `PRE_EXISTING` findings must include the base-branch evidence if available.

After reviewer lanes settle, persist the post-reviewer finding ledger before
critic routing or synthesis. The artifact must preserve `CONFIRMED`,
`DISPROVED`, `PRE_EXISTING`, and still-`PENDING` records with reviewer IDs and
next actions.

---

## Phase 7: Falsification Probe Requirement

Each confirmed nontrivial finding must include at least one falsification artifact:

- runnable failing command,
- proposed regression test,
- mutation that current tests fail to kill,
- static-analysis trace,
- minimal execution path,
- exact reason no runtime probe is available.

Nontrivial means any finding that affects correctness, security, state transitions, write authority, git safety, config, schema/evidence integrity, model/tool permissions, external fetches, persistence, or user-visible behavior.

A finding may still be reported without a runnable command if it is structurally proven, but the report must state why a runtime probe was not available.

---

## Phase 8: Critic Challenge

Route every reviewer-confirmed HIGH or CRITICAL finding to a critic. Also route borderline MEDIUM findings when they involve security, state machines, write authority, evidence integrity, model/tool permissions, git safety, or config ratchets.

The controller conservatively derives critic ownership from semantic reviewer
rows: every reviewer-confirmed CRITICAL, HIGH, or MEDIUM item is mandatory
critic inventory. This intentionally over-routes ordinary MEDIUM items because
machine enforcement cannot safely infer every repository-specific trust
boundary from prose. Completion is blocked until that exact derived inventory
has valid critic rows.

Reviewer and critic retries cannot be combined as complementary partial verdict
sets. Each phase requires at least one fully successful exact batch covering its
entire mechanically assigned inventory on one revision. A later degraded,
truncated, stale, wrong-identity, or malformed batch cannot replace an earlier
valid batch or suppress critic routing.

Any newer reviewer batch invalidates every older critic batch, even when the
new reviewer rows happen to be identical. Dispatch a fresh critic wave from the
latest coherent reviewer batch; critic evidence can never predate the reviewer
evidence it purports to challenge.

Under Profile A, dispatch critic chunks with `dispatch_lanes_async`,
`mode: "swarm-pr-review:critic"`, a unique non-empty `workflow_lane` per
chunk, `review_item_ids` containing the exact finding IDs assigned to that
chunk, critic-role agents only, and the same exact `pr_head_sha`. The runtime
requires one parseable `[CRITIC]` row for every structurally assigned ID and
requires one coherent fully successful exact reviewer batch before a critic wave.
Under Profile B, dispatch each critic chunk to a fresh subagent that was
neither the explorer nor the reviewer for those findings; under Profile C, run
a separate critic pass. The one-parseable-`[CRITIC]`-row-per-assigned-ID
contract and the reviewer-before-critic ordering are universal.

The critic must challenge:

- severity inflation,
- weak or incomplete evidence,
- missing mitigating context,
- false reachability assumptions,
- framework or middleware defaults,
- schema validation gates,
- state-machine constraints,
- feature flags or dead code,
- pre-existing status,
- non-actionable or unsafe fix recommendations,
- sibling-file gaps,
- whether multiple comments should be grouped into one root cause.

Critic output format:

```text
[CRITIC] | finding_id | UPHELD/DOWNGRADED/DISPROVED/NEEDS_MORE_EVIDENCE | final_severity | reason | required_report_change
```

## Verdict row contract

The `[CRITIC]` row in the format above is **mandatory contract**, not advisory output. A critic response that does not end with that exact row format is treated as a planning preamble, not a verdict, and must be re-dispatched. Do not proceed past Phase 8 join barrier until each dispatched critic lane has produced a parseable `[CRITIC]` row.

**Re-dispatch trigger:** when a critic lane response is missing the verdict row, the orchestrator must automatically re-dispatch that lane with the explicit instruction: "Your final line MUST be exactly the Phase 8 contract row: `[CRITIC] | finding_id | UPHELD/DOWNGRADED/DISPROVED/NEEDS_MORE_EVIDENCE | final_severity | reason | required_report_change`. A response without that exact row will be treated as a planning message and re-dispatched." Do not synthesize findings from the planning preamble; only from the re-dispatched verdict.

`NEEDS_MORE_EVIDENCE` is deliberately non-terminal and never satisfies critic
settlement. Re-dispatch a narrower critic/probe lane or report the dimension
BLOCKED. Terminal critic rows are cross-field checked: `DISPROVED` requires
`NONE`, `UPHELD` requires CRITICAL/HIGH/MEDIUM, and `DOWNGRADED` cannot remain
CRITICAL.

**COVERAGE GATE alignment:** Critic lane failures apply the COVERAGE GATE (Phase 3) — under Profile A via `dispatch_lanes_async` with `mode: "swarm-pr-review:critic"` and the same exact `pr_head_sha`; under Profiles B/C via a fresh critic subagent or pass. Do NOT mark findings UNVERIFIED or continue past the gap. The orchestrator NEVER fabricates a critic verdict by parsing prose, by tolerating a planning preamble, by presenting partial findings, or by silently accepting reduced coverage.

Refuted findings become `DISPROVED` or `ADVISORY`, depending on critic rationale. Downgrades must be listed in the final validation provenance.

After critic lanes settle, persist the post-critic finding ledger before final
synthesis. This artifact is the source of truth for resumed reporting and for
any later `swarm-pr-feedback` handoff.

---

## Runtime-Aware False-Positive Guard Checklist

Before confirming any finding, the reviewer and critic must check all that apply:

- [ ] Schema validation gate: does schema validation reject malformed input before the flagged line?
- [ ] Middleware interception: does middleware handle the request or command before the flagged path?
- [ ] Framework default mitigation: does the framework inherently prevent this class of issue?
- [ ] Caller context correctness: who invokes this code, and can untrusted input reach it?
- [ ] Execution reachability: is the path reachable, or behind a feature flag, dead branch, build-only path, or commented-out code?
- [ ] State-machine constraints: do ordering rules, locks, mutexes, phase gates, or transition guards prevent the state?
- [ ] Permission boundary: does role/tool mapping prevent the operation?
- [ ] Data lifetime: is the flagged state persisted, serialized, logged, or only transient?
- [ ] Cross-platform behavior: does Windows/macOS/Linux path or shell behavior change the result?
- [ ] Test environment mismatch: is the finding only true under a mock or fixture that cannot occur in production?

If a mitigation applies and was not accounted for, downgrade to `ADVISORY`, `UNVERIFIED`, or `DISPROVED`.

---

## Phase 9: Synthesis, Grouping, and Noise Budget

Before final output:

- group duplicate candidates by root cause,
- report one finding per root cause,
- attach all affected file:line references under that finding,
- separate ship blockers from advisory notes,
- suppress pure style/nit findings unless they indicate correctness, security, test, maintainability, or user-impact risk,
- distinguish PR-introduced from pre-existing,
- distinguish confirmed from plausible-but-unverified,
- include disproved agent/tool claims,
- keep final comments actionable.

### Finding ID format

```text
F-001 | severity | category | root cause | affected file:line refs | reviewer | critic status
```

### Suggested final grouping

1. Ship blockers,
2. Important non-blockers,
3. Test / coverage gaps,
4. Pre-existing issues,
5. Unverified plausible risks,
6. Disproved candidates / false positives,
7. Clean lane summary.

---

## Phase 10: Metrics and Knowledge Writeback

At the end of the review, include review quality metrics in the final report's
validation provenance. Persist them only through an invoked evidence tool and
record the exact `.swarm/evidence/` path returned by that tool; if no invoked
tool supports metrics (including all of Profiles B/C), state `NOT PERSISTED —
no metrics evidence writer` and keep the metrics block in the final report and
session ledger rather than naming a nonexistent command or path.

Record:

- raw candidates by base lane,
- raw candidates by micro-lane,
- deterministic tool candidates,
- reviewer-confirmed findings,
- reviewer-disproved findings,
- reviewer-unverified findings,
- critic-upheld findings,
- critic-downgraded findings,
- critic-disproved findings,
- final reported findings,
- suppressed non-actionable candidates,
- recurring false-positive patterns,
- commands or probes used,
- token/time cost if available,
- accepted/fixed findings when known.

Knowledge writeback rules:

- Write back only validated true positives or validated false-positive patterns.
- Include file patterns, invariant, evidence, and why it was confirmed/disproved.
- Mark repo-specific lessons as project-tier unless there is strong evidence they generalize.
- Never promote quarantined or unvalidated knowledge to hive-tier.
- Never store secrets, private tokens, or raw sensitive logs.

---

## Phase 11: Post-Fix Re-verification

When the PR author pushes fixes after a review, perform a targeted re-verification before updating the verdict.

### Re-verification scope

Only re-verify findings the author claims to have fixed. Do not re-run the full review pipeline.

### Re-verification steps

1. For each finding the author claims fixed:
   a. Read the changed file(s) from the updated branch at the specific lines referenced in the original finding.
   b. Verify the fix addresses the root cause, not just the symptom.
   c. Check that the fix does not introduce a new issue in the same area.
2. Run CI checks on the updated branch to confirm no regressions.
3. For findings the author did not address, carry forward the original finding with unchanged status.

### Re-verification output

```
[REVERIFIED] | finding_id | FIXED / PARTIALLY_FIXED / NOT_FIXED / NEW_ISSUE | evidence | updated_severity
```

- `FIXED`: the root cause is resolved and no new issue introduced.
- `PARTIALLY_FIXED`: the root cause is partially addressed or a residual concern remains.
- `NOT_FIXED`: the root cause persists unchanged.
- `NEW_ISSUE`: the fix introduced a new problem at the same location.

Update the verdict only after re-verifying all previously blocking findings.

---

For the full parser-based candidate extraction dry-run example, read `references/parser-dry-run.md`.

---

# Council Mode Workflow

Council mode is opt-in only and adversarial.

When triggered:

1. Build the same context pack as default mode.
2. After the default base-dimension and risk-family coverage is complete, launch all supplementary council agents. Under Profile A, use one `dispatch_lanes_async` call with `mode: "swarm-pr-review:council"`, the same exact `pr_head_sha`, and one unique `workflow_lane` per council member; continue independent context preparation while they run, polling with `collect_lane_results` (without `wait`) to process settled agents incrementally, and use `wait: true` only when no independent work remains. All agents must be settled and their candidates added to the ledger before reviewer classification; under Profile A the runtime enforces this join barrier, and blocking, sequential, or direct-Task fallback is not equivalent to the structured council dispatch — bypassing the active controller is `BLOCKED`. Under Profile B, dispatch council members as parallel subagents with the same marker contract and settle them all before reviewer classification; under Profile C, run each council lens as a separate sequential pass.
3. Each council agent assumes all work is wrong until code evidence proves otherwise.
4. Each agent hunts within its lane only.
5. Agents return the same mechanically parseable candidate contract as other discovery lanes: one `[CANDIDATE]` row per `EVIDENCE_FOUND` or `SUSPICIOUS` claim, or a fully populated `[CLEAN] | workflow_lane | coverage_scope | evidence` row when no candidate survives. Council prose without one of those markers does not settle the lane.
6. Agents must not return `CONFIRMED`, `DISPROVED`, or final severity; candidate severity remains provisional until reviewer classification.
7. The independent reviewer then classifies every council candidate as `CONFIRMED`, `DISPROVED`, `UNVERIFIED`, or `PRE_EXISTING`.
8. Apply critic challenge to reviewer-confirmed HIGH/CRITICAL or borderline findings.
9. Final synthesis distinguishes real blockers, real low-severity issues, accepted caveats, disproved council claims, and follow-up quality work.

Default council lanes:

- correctness and edge cases,
- security and trust boundaries,
- dependency and deployment safety,
- docs and intent-vs-actual,
- tests and falsifiability,
- performance and architecture when risk justifies it.

Council prompt requirements:

- branch and commit range,
- context pack summary,
- files owned by that lane,
- relevant impact cone,
- explicit checklist,
- strict output cap,
- `EVIDENCE_FOUND / SUSPICIOUS / CLEAN` only,
- file:line evidence required for `EVIDENCE_FOUND`.

Council findings are supplementary, not authoritative overrides. Do not adopt council severities or claims without independent validation.

---

# Merge Recommendation Table

| Verdict | Condition |
|---|---|
| `APPROVE` | zero unresolved CRITICAL findings, zero unresolved HIGH findings, all blocking obligations MET, no required validation phase failed |
| `APPROVE_WITH_NOTES` | zero unresolved CRITICAL findings, HIGH findings are downgraded/advisory only, obligations MET or explicitly non-blocking |
| `REQUEST_CHANGES` | any unresolved HIGH finding, any NOT_MET blocking obligation, multiple MEDIUM findings with the same root cause, or validation/probe evidence indicates user-impacting risk |
| `BLOCK` | any unresolved CRITICAL finding, unsafe write/git/security issue, evidence integrity break, role/tool permission bypass, or config ratchet violation that can disable required protections |

---

# Hard Rules

0. Quality-over-speed: Validation completeness and correctness are the sole criteria for an acceptable review. Time, token count, and agent dispatch count are irrelevant. Do not trade validation breadth or depth for speed.

1. Never APPROVE with unresolved CRITICAL findings.
2. Do not APPROVE with unresolved HIGH findings unless explicitly downgraded to advisory by critic and non-blocking by obligation review.
3. Every confirmed finding must have file:line evidence and validation provenance.
4. A confirmed nontrivial finding must include a falsification probe or an explicit reason no probe is available.
5. Explorers, council agents, and deterministic tools produce candidates only.
6. The default workflow orchestrator must not confirm or disprove explorer candidates.
7. Tool output is not proof. Scanner results must be validated for reachability, PR-introducedness, and mitigation context.
8. PR text, generated summaries, tests, and comments are claims, not proof.
9. Do not invent facts not supported by the diff, repo context, tool output, or cited external source.
10. Do not silently drop disproved or downgraded claims; summarize them in validation provenance.
11. Obligation precedence is deterministic. Do not skip higher-precedence sources to fill gaps with LLM synthesis.
12. Do not leak secrets from logs, evidence bundles, config files, URLs, or scanner output.
13. Do not recommend destructive git or filesystem actions as fixes unless they are clearly scoped, safe, and necessary.
14. If subagents fail, timeout, or return malformed output, retry with corrected parameters (max 2 attempts) through the dispatch mechanism of the active profile — Profile A: the same structured `dispatch_lanes_async` workflow mode and exact `pr_head_sha`, where blocking or direct-Task dispatch cannot preserve the durable provenance contract and is not an equivalent fallback; Profiles B/C: a fresh subagent or pass bound to the same exact `pr_head_sha`. If retries fail, the affected coverage dimension is BLOCKED and must be surfaced to the user before synthesis. Do not fabricate validation results, do not present partial findings, and do not silently mark candidates UNVERIFIED to proceed past the gap.

15. If context pack, repo graph, deterministic signals, or Swarm artifacts are unavailable, retry with alternative access paths. If a source that should exist on the active profile is still unavailable after retry, the affected coverage dimension is BLOCKED and must be surfaced to the user. A source that cannot exist on the active profile (for example `.swarm/` artifacts outside Profile A) is marked N/A in the validation provenance instead — N/A is disclosure, never a waiver of the dimensions and families that must still be covered. Do not proceed to synthesis with unclosed coverage gaps under a "best available evidence" rationale — the architect is not authorized to produce a degraded review.

---

# Pre-Synthesis Gate — Mandatory

Before writing the final output, print this checklist with filled values. Every blank field means the final output is invalid.

```text
[VALIDATION] scope selected: ___
[VALIDATION] capability profile (A/B/C) and depth tier (S/M/L): ___ / ___
[VALIDATION] context pack built: YES/NO — ___
[VALIDATION] obligation count: ___
[VALIDATION] repo graph / impact cone source: ___
[VALIDATION] deterministic signals ingested: ___
[VALIDATION] lane dispatch mechanism: controller / native subagents / sequential passes — ___
[VALIDATION] base dimensions covered with attestation: ___ / 6 (lanes dispatched: ___)
[VALIDATION] base explorer lanes returned: ___ / ___
[VALIDATION] micro risk families evaluated and attested: ___ / 11 OR BLOCKED — <missing rows> (micro lanes dispatched: ___)
[VALIDATION] Swarm verifier routing used: ___
[VALIDATION] raw candidates: ___
[VALIDATION] tool candidates: ___
[VALIDATION] reviewer lanes dispatched: ___
[VALIDATION] reviewer lanes returned with parseable `[REVIEWED]` rows: ___ / ___
[VALIDATION] findings confirmed by reviewer: ___
[VALIDATION] findings rejected by reviewer as false positive: ___
[VALIDATION] findings marked PRE_EXISTING: ___
[VALIDATION] findings left UNVERIFIED: ___
[VALIDATION] findings escalated to critic: ___
[VALIDATION] critic dispatched: ___ OR "SKIPPED — no reviewer-confirmed HIGH/CRITICAL or borderline findings"
[VALIDATION] critic returned: ___ OR "N/A"
[VALIDATION] findings upheld by critic: ___
[VALIDATION] findings downgraded by critic: ___
[VALIDATION] findings disproved by critic: ___
[VALIDATION] falsification probes included: ___
[VALIDATION] grouped root-cause findings: ___
[VALIDATION] metrics / knowledge writeback: ___
[VALIDATION] all explorers verified to diff against PR branch, not HEAD: YES/NO
[VALIDATION] noise-filter suppressed candidates: ___ (count, each with reason in final report)
[VALIDATION] all non-suppressed candidates routed to reviewer: YES/NO
```

If any reviewer lane lacks a parseable `[REVIEWED]` row after bounded
re-dispatch, the reviewer dimension is BLOCKED. Do not infer or silently
downgrade a verdict.

**COVERAGE GATE CONDITION:** If ANY validation dimension shows incomplete coverage (lanes that failed and were not closed by retry or verified equivalent alternative, CI that did not run, tools that were unavailable after retry), the Pre-Synthesis Gate FAILS — apply the COVERAGE GATE (Phase 3). Do not proceed to final output. Surface unclosed gaps with exact failing dimensions and retry/equivalence evidence.

---

# Final Output Format

Produce the final review in this order:

## PR intent

Summarize the obligations and user-visible intent.

## Implementation summary

Summarize what changed, including major files, public APIs, schemas, configs, tests, and Swarm artifacts.

## Intended vs actual mapping

| Obligation | Source | Actual evidence | Status | Linked finding |
|---|---|---|---|---|

Use `MET`, `PARTIALLY_MET`, `NOT_MET`, or `UNVERIFIABLE`.

## Validation provenance

Include:

- context pack limitations,
- explorer lanes launched and returned,
- micro-lanes triggered,
- deterministic signals ingested,
- reviewer identity / role for each finding,
- critic result for each escalated finding,
- findings DISPROVED by reviewer with reason,
- findings DOWNGRADED by critic with reason,
- findings left UNVERIFIED with reason.

If zero findings, explicitly state:

```text
No confirmed findings — all validated lanes CLEAN.
```

Then provide a lane-by-lane clean summary.

## Confirmed findings

For each finding:

```text
F-001 — Severity — Category — Root cause
Files: path:line, path:line
Status: CONFIRMED / critic status
Evidence type: STRUCTURALLY_PROVEN / EXECUTION_PROVEN / STATIC_TRACE_PROVEN
Why it matters:
Validation:
Falsification probe:
Suggested fix:
```

## Pre-existing findings

List separately from PR-introduced findings.

## Unverified but plausible risks

Only include if useful and clearly labeled as unverified.

## Test / coverage gaps

Focus on missing tests that would catch real risks, not generic coverage requests.

## Disproved candidates and false positives

List concise reasons for notable false positives from explorers, tools, council agents, or reviewers.

## Verdict

Use one of:

- `APPROVE`
- `APPROVE_WITH_NOTES`
- `REQUEST_CHANGES`
- `BLOCK`

## Merge recommendation

Explain the recommendation in one short paragraph and list required actions before merge if applicable.

## Feedback handoff

When the review produced actionable validated findings or operational blockers,
call `write_pr_review_artifact` with `kind: "handoff"` (Profile A). The controller writes
`.swarm/pr-review/<run_id>/feedback-handoff.json` only when its finding IDs
exactly match the latest confirmed `handoff_to_feedback` records. On Profiles
B/C, write the same handoff content to the session/task workspace path
described in "Handoff To PR Feedback" and reference that path in the
continuation prompt. Include:

- the handoff artifact path,
- the preserved finding IDs and provenance that `swarm-pr-feedback` must carry
  forward,
- and an explicit question asking whether to continue into
  `swarm-pr-feedback`.

Use this exact continuation prompt format, substituting the exact path from
whichever profile applies (`.swarm/pr-review/<run_id>/feedback-handoff.json`
under Profile A, or the session/task workspace path under Profiles B/C — never
mix the two):

```text
/swarm pr-feedback <PR_URL> continue from <handoff_artifact_path>
```

---

For reviewer, critic, and explorer prompt templates, read `references/prompt-templates.md`.

Under Profile A, after metrics and durable review artifacts are complete, but
before emitting the user-facing final report, call `complete_pr_workflow` with
mode `PR_REVIEW` and the same exact
`pr_head_sha`. The tool refuses to clear the session gate while required base,
trigger, declared reviewer/critic, or open-lane obligations remain incomplete.
While the gate remains active, the runtime prepends a workflow-active banner
to architect text parts (the model's text is preserved below the banner) and
re-wakes an idle parent session. A
user interruption pauses every automatic wake path until a later explicit user
turn settles; the durable gate remains available to continue or abort. Only
emit the final report after the completion tool confirms that the gate cleared.

Under Profiles B/C, no mechanical response gate exists: the Pre-Synthesis Gate
checklist is the completion gate. Emit the final report only after every
checklist line is filled, every dimension and family is attested, and every
BLOCKED item is surfaced.

## Aborting an unrecoverable review (Profile A)

The mechanical gate can leave the session stuck if the PR head cannot be
fetched or checked out — for example when a compound `git fetch … && git
checkout …` is repeatedly rejected as read-only shell syntax (the runtime
requires each git intake command to be a single standalone command), when
the PR ref is missing, or when the working tree is on the wrong branch and
the merge-base bind can never verify. In that state the response gate
suspends further auto-resumes after a small number of consecutive
unproductive wakes, and the only exits are:

1. **Diagnose and retry the canonical standalone sequence.** Run
   `git fetch origin refs/pull/<N>/head`, verify
   `git cat-file -e <full_pr_head_sha>^{commit}`, then run
   `git switch --detach <full_pr_head_sha>`. Do not use `--track FETCH_HEAD`.
   Confirm `git rev-parse HEAD` equals the authoritative PR head, then recompute the exact
   merge base with `git merge-base -- <base_ref> <pr_head_sha>` (single
   command) and retry the `swarm-pr-review:base` dispatch with the exact
   `pr_head_sha`, `base_sha`, and `base_ref`.
2. **Call `abort_pr_workflow`** with `mode: "PR_REVIEW"` and a one-line
   `reason` describing the blocker. The tool clears the durable gate state
   and stops the auto-resume loop. It refuses while PR workflow lanes are
   still in flight (collect their results with `collect_lane_results`
   first) and refuses once a PR_FEEDBACK workflow is armed for publication
   — in PR_REVIEW those refusals do not apply because there is no armed
   publication state. An audit event is appended to `.swarm/events.jsonl`.
3. **Ask the user to run `/swarm abort-pr-workflow`** (a human-only
   restricted command; the agent cannot invoke it via `swarm_command`).
   This is the recovery path when the wake budget has suspended and the
   architect cannot make further tool progress.

Abort is a recovery tool, not a coverage shortcut. Use it only when the
bind/checkout path is genuinely unreachable; never use it to skip a
coverage obligation that is merely expensive or inconvenient.

On Profiles B/C there is no durable gate or auto-resume loop to clear: if the
head bind is genuinely unreachable, report the blocker to the user and stop.
