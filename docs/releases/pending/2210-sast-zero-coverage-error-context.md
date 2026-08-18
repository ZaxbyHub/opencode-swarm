# SAST zero-coverage failure carries an error reason; pre_check_batch logs the actual cause

## What changed

When `sast_scan` scans exactly zero files (clean worktree, empty or all-skipped `files`), it correctly fails the gate but used to return `verdict: "fail"` with **no `error` field** — leaving no diagnostic context and causing `pre_check_batch` to log the hardcoded, misleading `SAST scan found new findings above threshold - GATE FAILED` even with zero findings (issue #2210).

- `sast_scan` (`src/tools/sast-scan.ts`) now attaches `error: 'SAST requires at least one file to scan; zero files were scanned'` to the zero-coverage failure payload, mirroring the `capture_baseline` path's explicit error contract. The error field appears only on zero-coverage failures — findings-driven failures are unchanged.
- `pre_check_batch` needs no new logging branch: its existing result-level `if (sastResult.error)` gate branch already surfaces the scan's error verbatim, so the zero-coverage reason now reaches the operator through that path instead of falling through to the misleading findings message. Comments at both verdict-driven branches now record that a result carrying `error` is always consumed upstream.

## Why

Silent zero-coverage failures wasted triage time on a nonexistent findings investigation.

## Migration

No migration required. Consumers string-matching `SAST scan found new findings above threshold` for zero-coverage scans should match the new `SAST requires at least one file to scan; zero files were scanned` error string instead.
