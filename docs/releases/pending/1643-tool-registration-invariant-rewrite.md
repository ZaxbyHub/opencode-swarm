# Tool-registration contract docs now match the compile-enforced manifest; barrel-export gap closed

## What changed

- **`AGENTS.md` invariant 11 rewritten** to describe the registration contract
  that has existed since issue #507: a tool is complete when it has (a) a
  `TOOL_METADATA` entry in `src/tools/tool-metadata.ts`, (b) a
  `TOOL_MANIFEST` handler thunk in `src/tools/manifest.ts` (both
  compile-checked), (c) an export in the `src/tools/index.ts` barrel,
  (d) help/docs surfaces, and (e) tests. The stale steps pointing at a manual
  plugin `tool: {}` block in `src/index.ts` and hand-maintained `TOOL_NAMES`
  are gone — the plugin object is built by `buildPluginToolObject(...)` and
  `TOOL_NAMES` / `TOOL_NAME_SET` / `AGENT_TOOL_MAP` invert automatically from
  `TOOL_METADATA.agents`. The adjacent "Opt-in tool maps" bullet was updated
  to the same vocabulary.
- **`docs/engineering-invariants.md`**: the v6.48.0 historical entry that
  restated the old checklist now carries a supersession note (the historical
  wording is preserved as history), and the drift-check detector table lists
  the new barrel-export leg.
- **`scripts/check-tool-registration.ts`** gained a seventh check
  (issue #1643): every `TOOL_NAMES` entry must resolve to a defined export of
  the `src/tools/index.ts` barrel, loaded synchronously via `createRequire`.
  Checks 1–6 never imported the barrel, so a tool missing its barrel export —
  a surface still required by `tests/unit/tools/wiring-adversarial.test.ts`,
  `tests/unit/tools/check-gate-status-export.test.ts`, and the
  `tests/integration/*-registration.test.ts` files — passed drift-check.
  The new check is additive; existing signatures keep their shape, with an
  optional injectable-barrel parameter for testing.
- **New regression test**
  `tests/unit/scripts/check-tool-registration-barrel.test.ts`: pure-helper
  cases plus a deliberately-missing-export case that fails the collector
  exactly as the issue's acceptance criteria require (verified end-to-end:
  removing one barrel line makes `bun run scripts/check-tool-registration.ts`
  exit 1; the restored tree passes).

## Why

LLM and human contributors following AGENTS.md invariant 11 were directed at
registration sites that no longer exist (a manual `tool: {}` block, a manual
`TOOL_NAMES` list). Separately, the one leg of the real contract that is not
compile-enforced — the barrel export — was unverified by
`scripts/check-tool-registration.ts`, so barrel drift was invisible to
`bun run drift:check` unless a tool-specific export test happened to exist.

## Migration steps

None. No runtime behavior changed; docs and a CI/dev script only. The new
check passes on the current tree (all 126 `TOOL_NAMES` entries have defined
barrel exports).

## Known caveats

- The barrel check treats a present-but-`undefined` export as missing
  (intentional: `export { x } from './x'` on an undefined binding must not
  count as an export).
- Extra barrel exports beyond `TOOL_NAMES` remain legal (camelCase aliases
  like `swarmApplyPatch` and helper exports such as `collect_lane_results`
  are intentional and are not flagged).
- Retiring the barrel requirement entirely (pointing barrel-consuming tests
  at `TOOL_MANIFEST` instead) was explicitly deferred as a larger follow-up
  and is not part of this change.
