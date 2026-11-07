# Neutralize control characters in swarm-residue inventory names (#3542)

## What changed

`formatResidueInventoryLines` in `src/services/swarm-residue.ts` now strips
C0/DEL (Unicode `Cc`) control bytes from entry names before the existing
backtick neutralization, matching the `safeName` shape that
`src/commands/doctor-store-integrity.ts` shipped in PR #3533. Both rendered
surfaces — the `/swarm config doctor` read-only residue section and the
close dry-run report — render through this one shared renderer. A new
pinning test, `tests/unit/services/swarm-residue-control-char-names.test.ts`,
covers `\n` row-injection, ESC terminal-pollution, DEL, NEL, and backtick
breakout names, and asserts ordinary names render byte-identical (no
over-stripping).

## Why

`relPath` values come from `readdir` of attacker-influenced trees. The old
renderer only replaced backticks, so a crafted entry name containing `\n`
could inject forged inventory rows into the report, and an ESC byte could
pollute terminal rendering. Quarantine actions were never affected (every
path is validated through `validateRelPath` before any move); the defect
class was bounded to report-line injection and terminal pollution. PR #3533
fixed the identical class in the doctor store-integrity report — this
closes the surviving copy in the residue inventory renderer.

## Migration steps

None. The change is internal to report formatting; no config, state, or
data migration is involved. Existing reports simply no longer carry raw
control bytes in entry names.

## Known caveats

- Control bytes are stripped, not escaped: a name `a\nb` renders as `ab`.
  This matches the shipped doctor-store-integrity behavior and is the
  intended minimal fix.
- The `Cc` strip also covers C1 control bytes (U+0080–U+009F), consistent
  with the PR #3533 precedent.
