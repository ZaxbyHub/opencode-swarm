## Skill-assertion detector: close remaining PR #2110 review findings

Follow-up to #2069 / PR #2110. Test-and-documentation only — no detector behavior changes.

### What changed
- PRR-005: New `check-skill-assertions-recall.test.ts` pins the FR-004 exact-line attribution recall boundary. A single-line assertion and a split-across-lines assertion, both genuinely broken against the same skill, are asserted in one fixture: the single-line form is reported, the multi-line form is not. The known false negative is now documented by a live test with a positive control rather than left implicit.
- PRR-006: Closed three coverage gaps. The malformed-regex test asserted only `if (brokenAssertions.length > 0)`, so it passed vacuously when nothing was emitted — it now requires the finding. The `SKILL_ASSERTIONS_STRICT=1` hard-fail path had no test; it is now covered by `check-skill-assertions-strict-mode.test.ts`, which spawns the real CLI and asserts exit codes (0 advisory, 1 strict, 0 strict-but-clean). The attribution and self-exclusion fixtures asserted only that a phrase was NOT misreported; each now also asserts the genuinely broken assertion IS reported.
- PRR-007: The regex and attribution fixtures cleaned up temp repos with `spawnSync('rm', ['-rf', d])`, which does not exist on Windows and leaked the directory on the Windows CI shards. Both now use `fs.rmSync`, matching the other fixtures.
- Docs: The `checkAssertionsAgainstSkill` docblock still advertised a `// skill-assertion:` comment-attribution fallback that FR-004 removed. Corrected to describe exact-line chaining only, and to name the multi-line recall cost.

### Why
PR #2110's review left these open. The vacuous assertions were the load-bearing problem: a detector whose tests assert only negatives cannot distinguish "correctly filtered a false positive" from "stopped reporting anything," which is the failure mode #2069 was about.

### Migration
None. No production behavior changed.
