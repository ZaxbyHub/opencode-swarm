---
issue: 3732
---

## Host contract drift (v2): vendored types and corpus refreshed to @opencode/plugin@2.3.0

The vendored OpenCode 2 plugin types (`src/host/v2/types.ts`) and the committed
host-contract corpus (`tests/fixtures/host/expected-structure-v2.json`) were pinned to
`@opencode/plugin@2.0.26` while the published package advanced to 2.3.0; the weekly
`host-contract-check` reported structural drift and auto-filed #3732 (and #3552 at the
2.2.5 snapshot). Both now pin 2.3.0 and the weekly check reports `STRUCTURE_MATCH`.

The vendored surface now carries the 2.1–2.3 additions, compiler-verified against the
tagged tarballs (the surfaces the adapter and type-probe cover): `Context.credential` (activate), `Context.experimental` (terminal read,
stateless generate, artifact) and the deprecated top-level `Context.generate`;
`SessionRequestMessage` (readonly nullable-text content, wired into the context event);
`SessionCompactionResult.native` (replacing the providerState era); the
`SessionModelResolve` / `SessionIdle` / fork hook payload families with a payload-typed
session hook registration; the paginated `session.list` (`{data, cursor}`) and the
deprecated `session.instructions` entries; 2.3.0 `AgentEditor` readonly signatures; and
the 2.3.0 permission `assert` input (optional agent/save/metadata/source, readonly
arrays).

Behavior: types-only for the adapter except one contract-alignment change — the v2
guidance context hook now replaces message elements instead of mutating the host's
message objects in place when writing transformed text parts back (the published
content array is readonly at 2.3.0; the event array itself is still rewritten in place,
so guidance delivery is unchanged).

New surfaces are documented per-hook in `docs/host/v2-hook-inventory.md` with the
adoption owner (#3642); no new hook is adopted at runtime in this change.
