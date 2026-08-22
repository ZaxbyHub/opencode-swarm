# Fix Semgrep auto-config scans and SAST gate degradation

`sast_scan` no longer passes Semgrep's pattern-only `--lang` option together with `--config=auto`, fixing fatal CLI exits on Semgrep 1.173.0 and later.

Semgrep failures now carry typed, sanitized diagnostics. A completed nonzero Semgrep process exit with no findings is reported by `pre_check_batch` as explicit `sast_degraded: true` coverage instead of blocking every coder task. Timeouts, cancellation, truncated or malformed output, partial scan errors, zero coverage, and any reported findings remain fail-closed.

`pre_check_batch` now also honors the effective QA profile's `sast_enabled` setting, including session-bound overrides, and does not schedule SAST when that gate is disabled.
