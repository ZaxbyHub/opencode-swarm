# CI Debug Systematic Checklist

Use this checklist when diagnosis is not immediately obvious.

## Layer 1: Read the Error (30 seconds)
- [ ] Read the FULL error message, not just the first line
- [ ] Identify the exit code
- [ ] Identify the failing step/command name
- [ ] Note the timestamp (is this a timeout?)

## Layer 2: Context (2 minutes)
- [ ] What branch is this on?
- [ ] What was the most recent commit? (`git log -1`)
- [ ] Did this workflow pass on the previous commit?
- [ ] Is this a PR or push to main?
- [ ] Are other workflows also failing?

## Layer 3: Reproduce (3 minutes)
- [ ] Can you run the exact failing command locally?
- [ ] Does the same test/build pass locally?
- [ ] If yes → environment difference (proceed to Layer 4)
- [ ] If no → you have a local repro (fix directly)

## Layer 4: Environment (3 minutes)
- [ ] Compare CI runner OS with local
- [ ] Compare language runtime version (node --version, python --version, etc.)
- [ ] Check environment variables and secrets
- [ ] Check file system differences (case sensitivity, path separators)
- [ ] Check timezone/locale differences
- [ ] Check network access (does CI need external services?)

## Layer 5: History (2 minutes)
- [ ] When was the last green run of this workflow?
- [ ] What changed between last green and first red? (`git diff <green-sha>..<red-sha>`)
- [ ] Has this same failure occurred before? (check .ci-debug/resolved-failures.md)
- [ ] Is this a known flaky test?

## Layer 6: Workflow Analysis (2 minutes)
- [ ] Are action versions pinned?
- [ ] Is caching working? (check cache hit/miss in logs)
- [ ] Is the runner image what you expect?
- [ ] Are matrix combinations correct?
- [ ] Any recent changes to the workflow file itself?
