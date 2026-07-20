# Issue 1899: Refresh @opencode-ai/sdk + @opencode-ai/plugin to 1.18.x and guard against silent dependency aging

## What changed

- **Dependency refresh.** `@opencode-ai/sdk` and `@opencode-ai/plugin` were bumped from a
  lockfile-frozen `1.1.53` to the current `1.18.3` (a ~17-minor-series jump). `package.json`
  ranges are now `^1.18.3`; `bun.lock` resolves both to `1.18.3`. New transitive dependencies
  arrive via the upgraded packages (`effect`, `@ai-sdk/provider` via the plugin; `cross-spawn`
  via the sdk), but none enter the plugin bundle — our `import { tool }` resolves to the
  plugin's `tool.js`, which imports only `zod`; `effect` is reachable only through the unused
  `@opencode-ai/plugin/v2/effect` export.

- **Runtime-shape re-audit.** The refresh's purpose was to close the dev-time/runtime skew that
  produced the `SCOPE_NOT_DECLARED` incident (#1896): the SDK types are intentionally loose
  (`metadata: { [key: string]: unknown }`), so `tsc` alone cannot catch structural drift. Every
  runtime-shape assumption the issue flagged was re-verified against the installed 1.18.3 type
  definitions and dispositioned as still-valid:
  - Plugin hook signatures (`event`, `config`, `tool.execute.before/after`, `chat.message`,
    `experimental.chat.messages.transform`) are structurally validated because the plugin entry
    is typed `Plugin` (→ `Promise<Hooks>`); `tsc --noEmit` passes clean.
  - The load-bearing per-call `session.prompt` model override `{ providerID, modelID }` and
    `session.create` `parentID` shapes are preserved in `SessionPromptData` / `SessionCreateData`.
  - The `src/index.ts` lifecycle handler, `src/background/completion-observer.ts`, and
    `src/hooks/model-limits.ts` source their fields from runtime-assigned `part.sessionID` /
    `AssistantMessage.modelID`/`providerID` / `TextPart.text`/`synthetic`, all of which the
    1.18.3 types still guarantee. The scope-activation handler continues to ignore
    tool-controllable `metadata.parentSessionId`.

- **New staleness guardrail (`dep-freshness` drift detector).** `scripts/drift-check.ts` gained a
  detector that compares the locked `@opencode-ai/*` resolution against npm-latest and warns when
  it falls more than a threshold of minor series behind, so the lockfile can't silently age again.
  It is **env-gated** (`SWARM_DEP_FRESHNESS_CHECK`, opted into by CI in `drift-check.yml`) so local
  `bun run drift:check` stays offline and deterministic, and it is **fail-open, advisory-only**:
  every finding is a non-blocking `notice` (dependency freshness is an external-world fact a
  blocked PR cannot fix), so it never fails a merge even under `DRIFT_CHECK_ENFORCE`. Findings flow
  into the existing drift report, annotations, and sticky PR comment. Threshold is configurable via
  `SWARM_DEP_FRESHNESS_THRESHOLD` (default 5).

## Why

The npm packages are published in lockstep with the OpenCode app, so building/type-checking
against `1.1.53` while users run `1.18.x` meant ~17 minor series of contract skew — invisible in CI
because everything compiled and tested against the old world. Refreshing the dependency shrinks the
window, and the `dep-freshness` advisory ensures a frozen caret range surfaces the next time it
drifts instead of waiting for a user-blocking incident.

## Migration steps

None. The bump is transparent to plugin consumers; no public API or plugin entry shape changed.

## Breaking changes

None.

## Known caveats

- The `dep-freshness` advisory requires network egress to `registry.npmjs.org`; it fails open (a
  `notice`) when the registry is unreachable, so it never blocks CI on a transient network hiccup.
- Enabling the check locally requires `SWARM_DEP_FRESHNESS_CHECK=1`; by default it is off so
  `bun run drift:check` performs no network I/O.
