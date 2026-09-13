# Align enforced CI checks with captured ruleset evidence (#2677)

The repository now keeps a bounded required-check contract and captured GitHub
ruleset/workflow evidence under version control. Drift detection reports missing,
renamed, event-skipped, stale, or unknown required-check coverage, while the
drift workflow runs for merge groups before the live ruleset promotion step.
CI also enforces the release-please ownership boundary for root-level package,
changelog, and manifest files without inventing tag-derived release notes.
