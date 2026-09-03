# Fix /swarm memory unlink and re-link on the OpenCode Desktop Node sidecar

## What changed

- The `node:sqlite` adapter (`src/db/sqlite-loader.ts`) now returns a
  `Changes`-shaped object (`{ changes, lastInsertRowid }`) from `db.run(sql)`
  when called with no bindings, matching `bun:sqlite`'s always-returns-Changes
  contract. Previously it returned `undefined`, so any `.changes` reader
  crashed under the Node sidecar with
  `Cannot read properties of undefined (reading 'changes')`.
- The memory-family ATTACH merge (`/swarm memory link` / `/swarm memory unlink`
  with a non-empty cohort or local store) and the `valid_from` provenance
  backfill are the two affected call sites; both work under Node without
  changes to their own code, and Bun behavior is unchanged.
- The no-bindings `run()` return shape is now pinned in the Bun↔Node driver
  parity contract (`src/db/driver-parity.ts`) and exercised against the real
  `node:sqlite` driver by the `repro:1873` smoke leg, which now also drives
  `/swarm memory link` → `unlink` → re-link through the registered command
  dispatch under Node.

## Why

OpenCode Desktop (Node) users could not unlink a memory family or link/re-link
a populated one: the migration merge read `.changes` off the adapter's
no-bindings `run()` return, which is a `Changes` object under Bun but was
`undefined` under the node adapter — a driver difference the plugin is supposed
to abstract. The failure surfaced as a raw TypeError naming an internal
property.

## Migration

No storage migration is required. Existing memory databases are unchanged; the
fix is entirely in the driver adapter and its parity contract.
