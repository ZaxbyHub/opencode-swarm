# PR Incident Playbook

## Release-please manifest desync

`.release-please-manifest.json` is the version source of truth for release-please. If it desyncs from the actual published release (e.g., `7.26.0` in manifest but `v7.27.1` on GitHub), release-please will propose a version that goes backwards.

**Common cause:** An older release PR (e.g., `chore(main): release 7.26.0`) merges after a newer one (`chore(main): release 7.27.1`). Both PRs modify the manifest, so the later one to merge wins — regardless of which version is higher.

**Detection:** If a release-please PR proposes a version that seems too low, check:
1. `gh release list --limit 5` — what's the latest published release?
2. `git show origin/main:.release-please-manifest.json` — what does the manifest say?
3. If different, the manifest is desynced.

**Fix:** Open a PR that updates `.release-please-manifest.json` to match the actual latest release (e.g., `"7.27.1"`). Close the incorrect release PR with explanation. After the manifest fix merges, release-please will auto-create a correct release PR.

## Push protection scan

GitHub push protection blocks commits containing literal secret patterns. This bit the
first commit of PR #1472 — a test file with a literal `sk_live_*` Stripe fixture
pattern was pushed before the string-concatenation workaround was applied.

**The primary check (pre-push, after commit exists):**

```bash
git log origin/main..HEAD -p | grep -E 'sk_live|ghp_|xox[abprs]-|AKIA|eyJ|AIza' || true
```

**The optional pre-commit add-on (staged changes only):**

```bash
git diff --cached | grep -E 'sk_live|ghp_|xox[abprs]-|AKIA|eyJ|AIza' || true
```

Forbidden patterns: Stripe (`sk_live_*`), GitHub (`ghp_*`), Slack (`xox[abprs]-*`),
AWS (`AKIA*`), JWT (`eyJ*`), Google API (`AIza*`).

**The fix:** Construct test fixtures via string concatenation rather than literal
patterns. For example:

```typescript
// Wrong — triggers push protection:
const stripeKey = 'sk_live_' + '1234567890abcdefghijklmn'

// Right — split the literal so it never appears verbatim in source:
const stripeKey = 'sk_' + 'live_' + '1234567890abcdefghijklmn'
```

> **Note:** This scan is a best-effort heuristic. It will not catch deliberately obfuscated patterns (e.g., base64 or hex encoding, runtime string assembly). For genuinely sensitive keys, use environment variables or a secret store — never commit credentials to source.

## Canonical remote resolution

When a repo has multiple remotes (e.g. `zaxbysauce/opencode-swarm` and
`ZaxbyHub/opencode-swarm`), pushing to the wrong remote causes `gh pr create` to
fail with "No commits between <canonical>:main and <mirror>:<branch>". This happened
on PR #1472.

**The check:** `git remote -v` before push. Identify the canonical-org remote.

**The rule:** Push to the canonical-org remote explicitly:

```bash
git push -u <canonical-remote> <branch>
```

Create the PR against the canonical repo:

```bash
gh pr create --repo <canonical-org>/<repo>
```

**Heuristic for identifying the canonical remote:** the canonical remote is the one whose URL points to the owning organization (e.g. `github.com/<org>/<repo>.git`), not a personal fork or mirror. When the owning org differs from the local fork's owner, the org-owned remote is canonical. Example: `github.com/ZaxbyHub/opencode-swarm.git` is canonical; `github.com/zaxbysauce/opencode-swarm.git` is a personal fork.

## GitHub auto-merge race condition

With a merge queue enabled, prefer queuing over manual freshness rebases, which
avoids this race entirely. It can still occur if you rebase manually: when `main`
advances while your PR is open, GitHub's PR sync machinery may **automatically push a
merge commit to your branch** in the window between when you fetch and when you push.
This is distinct from a conflict — it is GitHub creating a merge commit on your behalf
without rebuilding generated outputs (lockfiles, etc.).

Symptoms:
- `git push` is rejected with "fetch first" even though you just fetched
- `git log HEAD..origin/<branch>` shows a commit authored by GitHub/the repo owner with message `Merge branch 'main' into <branch>`
- generated outputs (e.g. lockfiles) on that auto-merge commit are stale because it was not rebuilt

Recovery:
```bash
git fetch origin <branch>
git log HEAD..origin/<branch>   # confirm it's only the GitHub auto-merge
# Your local commit is correct. Force-push it:
git push origin <branch> --force-with-lease
```

After force-pushing, verify the PR head SHA updated and cancel any CI run
targeting the superseded auto-merge SHA to unblock concurrency:

```powershell
gh run list --branch <branch> --limit 5 --json databaseId,headSha,status,workflowName
gh run cancel <stale-run-id>
```
