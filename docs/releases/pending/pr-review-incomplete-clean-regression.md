# Incomplete CLEAN attestation regression coverage

## What changed

- Added direct regression coverage proving that an incomplete lane transcript
  cannot produce a trusted CLEAN attestation, even when partial candidate
  parsing is explicitly enabled.

## Why

The runtime already enforced this stricter CLEAN contract, but the incomplete
transcript branch was not pinned independently from degraded-artifact coverage.

## Migration

No runtime behavior or configuration changed.
