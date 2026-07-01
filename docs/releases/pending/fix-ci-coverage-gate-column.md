# fix(ci): extract line coverage from correct awk column

## What changed

The coverage gate in `.github/workflows/ci.yml` was extracting the wrong column from
bun's coverage table. Bun's text-coverage output has the format:

```
File | % Funcs | % Lines | Uncovered Line #s
```

The awk expression used `$2` (% Funcs) instead of `$3` (% Lines), so the gate was
comparing function coverage against a threshold documented and calibrated as line
coverage.

Also pins the previously-unpinned `actions/upload-artifact@v4` to the full SHA for
`v4.6.2` as required by the workflow pinning policy.

## Why

The gate's intent was always line coverage. The originating commit (1362feb0) states
"Add CI coverage instrumentation (--coverage + 41.48% line gate)" and
`docs/releases/pending/1231-testing-infrastructure-audit.md` says
"coverage gate enforced at 41.48% **line coverage** (baseline + 1%)". The comment
in the step also says "Extract line coverage". All three pointed to the same intent;
the implementation used the wrong awk field.

CI evidence from a recent merge_group run (artifact `coverage-report`, run 28412887907):

```
All files | 66.42 | 63.74 |
           $2=Funcs  $3=Lines
```

The CI log printed `Coverage: 66.42%` (the funcs value), confirming the bug was live.

## Effect on the gate

- **Before:** gate measured % Funcs = 66.42% vs threshold 41.48% → passed
- **After:** gate measures % Lines = 63.74% vs threshold 41.48% → still passes

The gate becomes marginally stricter (lines < funcs on this codebase) but clears the
existing threshold with ≥22 points of margin. No currently-passing merge-queue runs
will flip red.

## Migration steps

None. The threshold (41.48%) is unchanged. Users do not need to take any action.

## Known caveats

The 41.48% floor is now a loose lower bound (~22 pts below current line coverage).
Consider ratcheting the threshold up (e.g. to ~58–60%) in a follow-up PR to give the
gate more regression-catching power.
