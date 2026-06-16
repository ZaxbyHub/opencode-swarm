# Test-impact infrastructure failure classification

## What changed

- Added `infrastructure_failure` to the test-impact failure classifier.
- Added detection for common CI/environment failure signals including OOM, errno
  network failures, broken pipes, signal crashes, and exit code `137`.
- Added focused regression and adversarial coverage for empty-history infra
  failures, stack-prefix-only matches, and infrastructure-dominant clustering.

## Why

These failures were previously bucketed as `unknown`, which made triage less
useful for first-time CI breakages and process-level crashes.
