---
issue: 2970
---

# `/swarm receipt --verify`: machine-checkable internal-consistency check for gate receipts on any machine (#2970, Workstream J slot J23)

`/swarm receipt --verify <bundle>` re-checks every recorded hash (receipt
hash, artifact digests, and the bundled gate report's re-derived digest) in
an exported receipt bundle on any machine — including a fresh clone with no `.swarm/`
state — and exits nonzero on any mismatch with a typed failure:
`corrupt_json`, `unsupported_format_version`, `schema_mismatch`,
`receipt_hash_mismatch`, `missing_artifact`, `digest_mismatch`, or
`path_escape`. The verify path is a pure function of the bundle's two roots
(receipt.json + artifacts/): no `.swarm/` reads, no config, no locks, zero
writes, and no child processes — which lets a reviewer mechanically reject
any bundle whose contents disagree with their own recorded hashes. It is
internal-consistency proof, not external attestation: a forger who
recomputes every digest consistently is only stopped by an out-of-band
capture-time anchor (a documented follow-up), and lazy edits that leave a
stale digest are caught because gate-report digests are RE-DERIVED from
the bundled bytes at verify time (FB-004). The same
classifier serves the `receipt` tool, so the tool's `ok` field and the
CLI's exit code can never disagree.

Path normalization and canonical hashing are imported from the emission
side (single source via `toPortableRelativePath` and the shared
canonicalizer), so a receipt emitted on Windows separators verifies
unchanged anywhere; `receipt_hash` covers the raw parsed object minus
`receipt_hash` itself, so an unknown added field flips verification
instead of being silently dropped.
The `--verify` arm accepts a bundle directory or a `receipt.json` path.

Documented limitations (inherited from the substrate): verify proves the
bundle is internally consistent and untampered relative to its recorded
hashes — it does not prove the cited gates ran against your clone's source
tree; an attached bundle contains the cited evidence artifacts even though
receipt JSON and verify output are digest-only; a future verifier that
re-executes cited commands would carry the full bounded-subprocess
obligation (AGENTS.md invariant 3) and needs its own issue.
