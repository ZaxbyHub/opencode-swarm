# Issue #862 follow-up: bypass fixes

Closes 7 verified bypass paths in the per-task evidence-file protection guard
(`src/hooks/guardrails.ts`), discovered by adversarial review of commit
`304e63cd`.

## Bypasses closed

1. **Quoted path** — `rm '.swarm/evidence/4.4.json'`, double-quoted, backtick
2. **Indirect-execution prefix** — `command rm …`, `\rm …`, `exec rm …`,
   `timeout 5 rm …` (plus `env`/`sudo`/`nohup`/`nice` via existing
   `dcUnwrapWrappers`)
3. **`ln` / `link`** — symlink/hardlink replacement
4. **`..` traversal** — `rm .swarm/x/../evidence/4.4.json`
5. **Directory-level mutation** — `mv .swarm/evidence /tmp/x`,
   `rm -rf .swarm/evidence` (negative: `.swarm/evidence/retro-3/…` children
   remain agent-writable)
6. **Generic interpreters** — `python -c "open(…,'w')"`, `node -e`,
   `perl -e`, `ruby`, `awk`, `tar -xf`
7. **Cross-repo absolute path** — `Write`/`Bash` against
   `/other/repo/.swarm/evidence/<id>.json`

## How to apply

```bash
# 1. Fetch and check out
git fetch origin claude/fix-evidence-corruption-JUaDr
git checkout claude/fix-evidence-corruption-JUaDr

# 2. Apply the guardrails patch
git apply .claude/issue-traces/862/guardrails-bypass-fix.patch

# 3. Replace the test file with the new content (adds bypass-coverage suite)
cp .claude/issue-traces/862/guardrails-evidence-protection.test.ts.new \
   tests/unit/hooks/guardrails-evidence-protection.test.ts

# 4. Verify
bun test tests/unit/hooks/guardrails-evidence-protection.test.ts

# 5. Commit and push
git add src/hooks/guardrails.ts \
        tests/unit/hooks/guardrails-evidence-protection.test.ts
git commit -m "fix(guardrails): close 7 evidence-protection bypasses (#862)"
git push origin claude/fix-evidence-corruption-JUaDr
```

## Why this is delivered as patch + full file (not direct push)

The original push attempt for `src/hooks/guardrails.ts` (4193 lines, 155KB)
exceeded the inline tool-call output budget (~32K tokens vs ~40K required).
The guardrails patch is 11KB (228 lines). The new test file is 21KB.
Both fit easily as artifacts in `.claude/issue-traces/862/`; the user
applies them locally and pushes the final commit.

## What this does NOT touch

- The base evidence-file protection logic (from commit `304e63cd`) — these
  bypasses are tightenings, not corrections.
- The original test cases — all kept, augmented with bypass-coverage suite.
- `update-task-status.ts` quarantine behavior — adversarial reviewer flagged
  it as "soft security regression" but the fall-through has its own gating
  cascade (session state, plan.json, delegation chain) that returns
  `blocked: true` if none confirm gates. No change needed.
