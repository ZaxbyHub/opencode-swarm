---
name: git-revert-safety
description: >
  Apply when reverting commits, undoing merges, or recovering from branch contamination.
  Covers collateral damage verification (manifest, package.json, CHANGELOG, lockfiles),
  cherry-pick vs revert decision matrix, partial-revert detection, merge-parent handling,
  and post-revert CI verification. Prevents the most common revert failure mode: version
  metadata regression from git reverse-apply.
effort: small
triggers:
  - git revert
  - revert commit
  - revert merge
  - undo merge
  - reverse-apply
  - branch contamination
  - cherry-pick recovery
  - release-please duplicate tag
generated_from_knowledge: []
---

# Git Revert Safety Protocol

Two internal workflows: **Safe Git Revert** (Steps 1-4) and **Branch Contamination Recovery** (Steps 5-6).
Use the first when reverting known commits. Use the second when the wrong code was merged and you need a clean slate.

---

## Workflow A — Safe Git Revert

### Step 1 — Collateral Damage Assessment

Before reverting, list ALL files touched by each commit being reverted. Use the correct command for the situation:

**Single commit:**
```bash
git show --name-only --format= <sha>
```

**Multiple commits (contiguous range):**
```bash
git diff --name-only <commit-before-first>..<last-commit-sha>
```

**Merge commit — inspect all parents (handles octopus merges with 3+ parents):**
```bash
git show --format="%H %P" <merge-sha>   # Shows ALL parent SHAs
git log --oneline <merge-sha>^1         # First parent (usually main)
git log --oneline <merge-sha>^2         # Second parent (feature branch)
# For octopus merges: also inspect ^3, ^4, etc.
```

Identify which files in the diff are NOT part of the feature being reverted:
- `.release-please-manifest.json` — version state
- `package.json` — version field + dependency additions/removals
- `CHANGELOG.md` — release history
- Lockfiles (`bun.lock`, `package-lock.json`) — dependency graph
- Any config files modified by release PRs between the feature and now

`dist/` is generated and NOT committed, so it never appears in a revert diff and
needs no rebuild+commit as part of a revert — reverting the source is enough.

**Gate:** If ANY version metadata or dependency file appears in the diff, you MUST verify post-revert state (Step 3).

### Step 2 — Choose Recovery Strategy

| Scenario | Strategy | Caveat |
|----------|----------|--------|
| Single commit that does NOT touch release/build artifacts | `git revert <sha>` | Still verify metadata diff after |
| Single commit that DOES touch release artifacts | Verify post-revert metadata manually | May need corrective commit |
| Multi-commit revert, no releases between | `git revert <sha1> <sha2>...` | Verify each commit's file scope |
| Multi-commit revert, releases between | Cherry-pick fix onto fresh branch | Avoids collateral damage from reverse-apply |
| Merge commit revert | `git revert -m <parent-number> <merge-sha>` | Must specify correct parent (usually `-m 1` for main) |
| Branch contamination (wrong code merged) | Fresh branch + cherry-pick | See Workflow B |
| Revert of revert (re-apply feature) | `git revert <revert-sha>` | ⚠️ Code may have drifted — check for conflicts |
| Squash merge revert | Fresh branch + cherry-pick preferred | Squash merges have no merge-parent metadata |
| Octopus merge (3+ parents) | Fresh branch + cherry-pick unless parent is unambiguous | `-m` parent selection is error-prone; prefer clean slate |

**Rule:** If commits to revert span across release-please merge commits, ALWAYS prefer cherry-pick over revert.

### Step 3 — Post-Revert Verification

After reverting, verify these files match expected state:

1. **`.release-please-manifest.json`** — version must match the latest non-draft, non-prerelease GitHub release
   ```bash
   # List releases excluding drafts and prereleases
   gh release list --limit 5 --json tagName,isDraft,isPrerelease --jq '.[] | select(.isDraft==false and .isPrerelease==false) | .tagName'
   node -e "console.log(require('./.release-please-manifest.json')['.'])"
   ```

2. **`package.json` version field** — must match the manifest
   ```bash
   node -e "console.log(require('./package.json').version)"
   ```

3. **`CHANGELOG.md`** — must still contain entries for all released versions
   ```bash
   # Cross-platform: count version headings
   node -e "const c=require('fs').readFileSync('CHANGELOG.md','utf8'); console.log((c.match(/^## \[/gm)||[]).length)"
   # Compare against GitHub releases
   gh release list --limit 10
   ```

4. **Dependencies** — if `package.json` dependencies changed, verify lockfile is consistent
   ```bash
   bun install --frozen-lockfile   # Must succeed
   ```

5. **Bundle size** — if dependencies were added/removed, verify smoke test thresholds still pass. `dist/` is generated and NOT committed; run `bun run build` locally only when you need the bundle to verify.
   ```bash
   bun run build
   bun test tests/smoke --timeout 120000
   ```

**If any check fails:** Do NOT hand-edit release-please versions. Restore metadata from the known-good state of the latest release commit or re-run release-please. Apply a corrective commit restoring from the last known-good state before pushing.

### Step 4 — CI Verification

After pushing the revert:
1. Wait for CI to start
2. Check last-green-CI timestamp against the merge being reverted:
   ```bash
   gh run list --branch main --limit 10 --json databaseId,conclusion,createdAt --jq '.[] | select(.conclusion=="success")'
   ```
3. Do NOT dismiss any CI failure as "pre-existing" without timestamp evidence comparing the failure to the last known-green run
4. If release-please fails with "Duplicate release tag", the manifest was regressed — return to Step 3

---

## Workflow B — Branch Contamination Recovery

Use when the wrong code was merged to main and you need a clean recovery.

### Step 5 — Assess Contamination Scope

1. Identify the exact commits that should NOT be on the branch
2. Identify the commits that SHOULD be there (fix commits, other features merged after)
3. Check if release-please ran between the bad merge and now — if so, manifest/CHANGELOG/package.json version were all modified

### Step 6 — Clean-Slate Recovery

1. **Create a fresh branch from origin/main:**
   ```bash
   git fetch origin main
   git checkout -b fix/<name> origin/main
   ```

2. **Cherry-pick ONLY the fix/feature commits** that should be on the branch:
   ```bash
   git cherry-pick <fix-sha>
   ```

3. **Verify the cherry-picked branch** has exactly the files you expect:
   ```bash
   git diff --name-only origin/main..HEAD
   ```

4. **Run full QA gates** before pushing (lint, build, tests, smoke tests). `dist/` is generated and NOT committed — do not stage it; run `bun run build` locally only when you need the bundle to verify.

**Do NOT attempt incremental cleanup** (removing bad files one by one from a contaminated branch) when release metadata, generated bundles, or dependency graphs are involved. Clean-slate cherry-pick guarantees no contamination leaks.

---

## Conflict Resolution Gate

After resolving any revert or cherry-pick conflicts:
1. Run `git diff` to review ALL resolved files — not just the conflicted ones
2. For CHANGELOG/manifest conflicts — restore from known-good state, do NOT merge both versions
3. Verify build succeeds before committing: `bun run build` (`dist/` is generated and NOT committed — do not stage it)

---

## Forbidden Shortcuts

- NEVER assume version metadata survived a multi-commit revert unchanged — always verify
- NEVER dismiss CI failures as pre-existing without comparing timestamps against last-green-CI
- NEVER attempt incremental cleanup of contaminated branches when release metadata or dependency graphs are involved
- NEVER hand-invent release-please version numbers — restore from known-good state or re-run release-please
- NEVER trust stale local SHAs after force-pushes — refetch and compare against remote before recovery

## Delegation Template

```
SKILLS: file:.opencode/skills/generated/git-revert-safety/SKILL.md
```
