---
title: Opt-in bounded OTLP/OpenInference observability export
---

- Add an opt-in remote observability exporter (`observability.export`, disabled by default): canonical events are projected onto the pinned OTLP GenAI (1.29.0) / OpenInference (0.1.14) attribute tables and shipped as OTLP/HTTP JSON to a user-configured collector.
- Local operation stays fully independent of the exporter: nothing is registered (no listener, no timers, no network, no `.swarm/otlp-export/` directory) unless the exporter is explicitly enabled, and an independent `SWARM_OTLP_EXPORT_DISABLE=1` kill switch forces it off.
- Privacy is enforced at the export boundary: span attributes come only from the pinned mapping tables plus a closed `swarm.*` set, `content`-class events never export, and records are filtered before the spool append — prompt/command/code/path/tool payload text never reaches the spool or the wire.
- Transport is bounded: batched POSTs with a per-request timeout, capped exponential backoff with jitter honoring 429 `Retry-After`, a cooldown circuit that stops flush attempts after consecutive failed cycles and admits one recovery probe, a persistent spool with byte and age budgets (drop-oldest with terminal drop reasons), and restart replay of spooled-but-unshipped records. Exporter health (state, mapping version, spooled records/bytes, accepted/exported/retried/dropped by reason, circuit state) is surfaced through `/swarm report`.
- Harden `sanitizeFailureEvidenceDisplay` (#2369 gaps, defense-in-depth only): glued/suffixed credential key names (`access_token=`, `private_key=`, `tokenX=`, …) and `Authorization: Basic <credential>` values are now redacted, and ANSI-SGR-adjacent keywords no longer bypass redaction (SGR parameter text is removed from output); combining marks remain a documented accepted residual.
- The retention registry's `planned-otlp-export` placeholder becomes the active `otlp-export-spool` row with real writer/reader citations and close-policy membership.

No migration is required. Default behavior is unchanged (exporter off); opt-in by setting `observability.export.enabled` with an `https:` endpoint (`http:` allowed for loopback test collectors only). No version or changelog hand edits.

Breaking changes: none. The `src/observability` no-I/O contract test now carves out `otlp-exporter.ts` as its single sanctioned I/O module (the runtime consumer the contract itself deferred to this change); every sibling module keeps the full no-I/O guarantee.
