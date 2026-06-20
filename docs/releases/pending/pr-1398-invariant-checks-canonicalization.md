- Fixed `scripts/check-invariants.sh` path normalization to correctly handle
  middle `..` segments in `mock.module()` targets (no more double slashes).
- Added `scripts/generate-mock-allowlist.sh` with `--check` mode for
  allowlist drift detection; the producer and consumer now share a
  single normalization routine.
- Replaced the O(N·M) bash allowlist lookup with a preloaded associative
  array, bringing `bash scripts/check-invariants.sh` runtime under 5 s.
- Extended the mock.module scan to include `src/**/*.test.ts` alongside
  `tests/`.
- Tightened `bun-compat.ts` and `LEGACY_EXEMPTS` matching to basename /
  exact-path comparison.
