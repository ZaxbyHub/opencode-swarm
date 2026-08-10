# Secretscan hard-gate completion and evidence integrity

## Fixed

- Made standalone and file-scoped secretscan accounting distinguish files that were scanned, intentionally skipped, or left incomplete because of size, read failures, containment rejection, deadlines, or candidate limits.
- Failed `pre_check_batch` closed on incomplete coverage and persisted the same failed verdict for scanner errors, wrapper timeouts, findings, zero coverage, and incomplete scans.
- Scanned all content in accepted files up to the existing 512 KiB bound, including lines longer than 10,000 characters, instead of silently ignoring content after 50 KiB.
- Redacted every secret before emitting shared line context, bounded each context, and enforced the final serialized-output byte ceiling.
- Bounded recursive discovery with deadline checks, event-loop yields, a fixed-size candidate heap, deterministic selection, and incomplete-coverage reporting.
- Prevented explicit-file scans from following parent symlinks or Windows junctions outside the canonical project root.
- Added end-to-end Stripe detector coverage through `pre_check_batch`, complementing the shared-registry fix that previously shipped in PR #1697.

## Migration

No configuration migration is required. Successful scan results add an `incomplete_files` counter; consumers that ignore unknown JSON fields remain compatible.

## Known caveats

Files larger than 512 KiB remain intentionally outside the bounded scanner, but are now reported as incomplete and fail the hard gate instead of appearing clean.
