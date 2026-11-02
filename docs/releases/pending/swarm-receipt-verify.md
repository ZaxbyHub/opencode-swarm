---
issue: 2970
---

# `/swarm receipt --verify`: machine-checkable gate proof on any machine (#2970, Workstream J slot J23)

`/swarm receipt --verify <bundle>` re-checks every hash in an exported
receipt bundle on any machine — including a fresh clone with no `.swarm/`
state — and exits nonzero on any mismatch with a typed failure:
`corrupt_json`, `unsupported_format_version`, `schema_mismatch`,
`receipt_hash_mismatch`, `missing_artifact`, `digest_mismatch`, or
`path_escape`. The verify path is a pure function of the bundle's two roots
(receipt.json + artifacts/): no `.swarm/` reads, no config, no locks, zero
writes, and no child processes — which is exactly what makes an attached
bundle reviewer-checkable proof instead of an agent's claim. The same
classifier serves the `receipt` tool, so the tool's `ok` field and the
CLI's exit code can never disagree.

Path normalization and canonical hashing are imported from the emission
side (single source), so a receipt emitted on Windows separators verifies
unchanged anywhere; `receipt_hash` covers the raw parsed object, so an
unknown added field flips verification instead of being silently dropped.
The `--verify` arm accepts a bundle directory or a `receipt.json` path.

Documented limitations (inherited from the substrate): verify proves the
bundle is internally consistent and untampered relative to its recorded
hashes — it does not prove the cited gates ran against your clone's source
tree; an attached bundle contains the cited evidence artifacts even though
receipt JSON and verify output are digest-only; a future verifier that
re-executes cited commands would carry the full bounded-subprocess
obligation (AGENTS.md invariant 3) and needs its own issue.
