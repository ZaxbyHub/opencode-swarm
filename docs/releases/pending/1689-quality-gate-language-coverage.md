### Fixed

- Wired Go and Rust SAST into the native rule path so seeded Go/Rust vulnerabilities are detected without relying on optional Semgrep availability.
- Reused the full `secretscan` detector registry for file-scoped `pre_check_batch` runs, restoring hard-gate coverage for AWS, Stripe, Slack, SendGrid, Twilio, and entropy-based secrets.
- Added PHP test-runner and lint-tool support for PHPUnit/Pest/Laravel and common Composer linters.
- Corrected profile build-command priority ordering and prevented generic Gradle Checkstyle detection from masking ktlint in Kotlin projects.
