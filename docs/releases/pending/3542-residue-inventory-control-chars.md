# Neutralize control characters in swarm-residue inventory names (#3542)

## What changed

`formatResidueInventoryLines` in `src/services/swarm-residue.ts` now strips
C0/C1 (Unicode `Cc`) control bytes from entry names before the existing
backtick neutralization, matching the `safeName` shape that
`src/commands/doctor-store-integrity.ts` shipped in PR #3533. The residue
inventory sections of the `/swarm config doctor` read-only report and the
close dry-run report render through this one shared renderer. A new pinning
test, `tests/unit/services/swarm-residue-control-char-names.test.ts`, covers
`\n` row-injection, ESC terminal-pollution, DEL, NEL, a control byte inside a
directory component of a multi-segment path, VT (U+000B), and CSI (U+009F)
names, pins the exact rendered output for a crafted name (and the verbatim
name span for an ordinary name), and asserts the directory component survives
rendering (no over-stripping).

## Why

`relPath` values come from `readdir` of attacker-influenced trees. The old
renderer only replaced backticks, so a crafted entry name containing `\n`
could inject forged inventory rows into the report, and an ESC byte could
pollute terminal rendering. Quarantine actions were never affected by this
renderer defect (the quarantine move path is untouched by this change); the
defect class was bounded to report-line injection and terminal pollution. PR
#3533 fixed the identical class in the doctor store-integrity report — this
closes the surviving copy in the residue inventory renderer.

## Migration steps

None. The change is internal to report formatting; no config, state, or data
migration is involved. The residue-inventory sections of the doctor report
and the close dry-run report no longer carry raw control bytes in entry
names.

## Known caveats

- Control bytes are stripped, not escaped: a name `a\nb` renders as `ab`.
  This matches the shipped doctor-store-integrity behavior and is the
  intended minimal fix.
- The `Cc` strip also covers C1 control bytes (U+0080–U+009F), consistent
  with the PR #3533 precedent.
- Coverage bound: this fix covers the shared residue-inventory renderer only.
  Three sibling render surfaces still emit the same `relPath` values raw
  (no control-byte strip, and two of them no backtick neutralization either):
  the `--quarantine-residue` preserved list (`src/commands/doctor.ts`),
  the close clean-stage preserved-candidates warning (persisted verbatim
  into `.swarm/close-summary.md`), and the close dry-run archive/post-mortem
  name lists. Those sites predate this PR and are tracked for a follow-up.
