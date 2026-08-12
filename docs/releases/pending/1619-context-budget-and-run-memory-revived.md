# Context-budget warnings now actually run, and every workspace-root validation is unified behind one guard

## What

A single misapplied validator made the whole context-budget feature throw on
every production call. It is fixed, and the denominator it measures against is
now derived from the model you are actually running rather than a constant.

The same validator was misapplied in `run-memory`, and PR #2119 fixed that half
independently while this change was in review — adding `validateWorkspaceRoot`
plus a real producer (`recordTaskAttempt`, wired from `src/plan/manager.ts:2194`
and `src/tools/update-task-status.ts`), which closes
[issue #2115](https://github.com/ZaxbyHub/opencode-swarm/issues/2115). Run-memory
recall is therefore genuinely live now, not merely unblocked.

The two fixes overlapped, so this change reconciles them into **one** validator
rather than shipping two with different strength. `validateWorkspaceRoot` is
kept as the name (it is the merged one contributors will grep for) and now
delegates to `validateProjectDirectory`, which additionally requires the root to
be absolute and rejects filesystem/drive roots and system locations. Both extra
checks are load-bearing rather than defensive:

- a **relative** root resolves `.swarm/` against the host process cwd — the same
  invariant-4 hazard as an empty root, which is why the two integration tests
  that previously used `tmp/`-relative roots now use absolute temp directories;
- an **absolute but wrong** root is still a real writable location, and
  `validateSwarmPath` faithfully pins the write *inside* it. Running the security
  suite against an absolute-only validator created `E:\.swarm\`, `E:\Windows\`
  and `E:\Users\Brett\AppData\Local\` on a developer machine.

`context-budget-service.ts` was outside #2119's scope and still called
`validateDirectory`, so the context-budget feature remained dead on `main`; this
change fixes those two call sites too.

`getContextBudgetReport`, `formatBudgetWarning` and the `run-memory` entry points
validated their **trusted, always-absolute project root** with
`validateDirectory` — the validator for *untrusted, relative* sub-path input,
which rejects every absolute path by design. Every *live* call site sits behind a
debug-gated `warn`, so nothing surfaced: no error, no warning, just a feature
that silently did nothing.

Which halves were revived by whom:

- `getContextBudgetReport` and `formatBudgetWarning` had live production callers
  and threw on **every** one. `context-budget-service.ts` was outside #2119's
  scope, so this change is what revives them.
- The `run-memory` entry points (`recordOutcome`, `getTaskHistory`,
  `getRunMemorySummary`) were revived by #2119, which also gave them their first
  producer. This change re-points them at the unified validator so both halves
  enforce one contract instead of two.

Changes:

- Added `validateProjectDirectory` (`src/utils/path-security.ts`) — the
  trust-model counterpart to `validateDirectory`. It still rejects empty,
  traversal-bearing and control-character roots, and additionally **requires**
  an absolute path (a relative root would resolve `.swarm/` against the host
  process cwd — AGENTS.md invariant 4). `validateDirectory` is unchanged.
  One portability asymmetry is worth knowing, and is now documented on the
  function: `path.isAbsolute` is bound to the host platform, so a
  **backslash** UNC root (`\\server\share\project`) validates on Windows and
  throws on Linux/macOS. The forward-slash spelling (`//server/share/project`)
  is absolute under both parsers and validates everywhere, as do POSIX roots
  and `C:`-drive roots.
- Applied it at the two call sites #2119 did not cover
  (`src/services/context-budget-service.ts:285,386`). The three `run-memory`
  sites (`:99`, `:118`, `:319`) call `validateWorkspaceRoot`, which delegates to
  the same function, so all five enforce one contract.
- **Corrected the context-budget denominator — it now comes from the model you
  are actually running.** It used to be a hardcoded 128 000 (and, for users with
  no `context_budget` block at all, a hardcoded 40 000). Both numbers are wrong
  for most current models: in the same catalog survey referenced below, 4 115 of
  6 245 entries (66 %) report a window of 200 000 or more, and 1 004 sit at 256k.
  The denominator is now derived, in this order, by the new single resolver
  `src/config/context-window.ts`:

  1. an explicit `context_budget.model_limits` entry —
     `"<provider>/<model>"`, then `"<model>"`, then `default`;
  2. the live `model.limit.context` the OpenCode host passes to
     `experimental.chat.system.transform`;
  3. the static table in `src/hooks/model-limits.ts`;
  4. `DEFAULT_MODEL_CONTEXT_TOKENS` (128 000), only when nothing above applies.

  `model.limit.context` is already provider-specific — the host's model catalog
  is keyed by provider and then by model, so a Copilot entry and a first-party
  entry for the same model carry different windows (observed:
  `github-copilot/claude-sonnet-4.5` reports 200 000 where
  `anthropic/claude-sonnet-4-5` reports 1 000 000). Every consumer now reads
  this one resolver, or is fed by something that does: both system-enhancer
  budget blocks (`src/hooks/system-enhancer.ts:1696`, `:2601`), the
  `context-budget` message hook (`src/hooks/context-budget.ts:106`, which
  HARD-PRUNES messages, so a too-small denominator was deleting context that
  did not need deleting), the knowledge-injector headroom gate
  (`src/hooks/knowledge-injector.ts:866`) and the `context_status` tool
  (`src/tools/context-status.ts:131`) go through `resolveModelLimit`, now a
  thin adapter over the resolver; `/swarm status` renders
  `swarmState.lastBudgetTokens`, which the system-enhancer writes from the
  resolver (`src/hooks/system-enhancer.ts:1731`, `:2634`).

  One honest limitation: the `messages.transform` consumers read the live
  window out of session state, which `system.transform` populates. On the very
  first `messages.transform` of a session no `system.transform` has run yet, so
  those consumers fall through to rung 3/4 for that one turn. That is the
  pre-existing behaviour, never worse — but it is not "the live window, always".
- `context_budget.model_limits` no longer carries a zod default of
  `{ default: 128000 }`; it defaults to `{}`. A schema-injected value is not
  user intent, and with it present a phantom 128 000 would have outranked the
  live window for **every** user who has a `context_budget` block. That
  population's denominator therefore does change: it was 128 000 and is now the
  live window. It is numerically identical only for users with **no**
  `context_budget` block at all, who never had the zod default injected.
- Malformed window values can no longer produce a `NaN` / `Infinity`
  percentage. This is not theoretical: a survey of the OpenCode host's on-disk
  model catalog (`~/.cache/opencode/models.json`, 6 245 entries, sampled
  2026-08-10) found 124 entries shipping `limit.context: 0`, which would have
  reported `Infinity %` and fired the compaction **EMERGENCY** tier on turn one.
  The user-config rung admits any finite value `>= 1` (deliberately weaker than
  the untrusted rungs, which require ≥ 1000 — silently discarding a number a
  user explicitly wrote would be worse than honouring it). `>= 1`, not `> 0`,
  because the resolver floors what it admits and a fractional value in `(0, 1)`
  would otherwise floor to a zero denominator.
- The budget warning's architect check now runs *before* `formatBudgetWarning`,
  because that function persists warning-suppression state
  (`src/services/context-budget-service.ts:427`). Calling it on a non-architect
  turn and discarding the result consumed the architect's single
  `warningMode: 'once'` firing.
- Added a source-scan guardrail
  (`tests/unit/build/trusted-root-validator-scan.test.ts`) that pins each of the
  six trusted-root entry points to a `validateProjectDirectory` call, and that
  fails if a project directory is passed to `validateDirectory` again **under
  one of the argument names the scan recognises**. That second rule matches on
  the argument's spelling, so a trusted root passed as `d` or `where` is
  invisible to it — the helper says so itself
  (`tests/helpers/trusted-root-validator-scan.ts:47-55`). It is a
  forward-looking ratchet; the entry-point pinning carries the live assertions.

The change is not purely "was dead, now works". The old validator *accepted*
relative roots — it throws only on absolute ones — so a caller passing a
relative root had `.swarm/` resolved against whatever the host process cwd
happened to be, an AGENTS.md invariant 4 hazard. No production caller ever did
this, so the hole was latent rather than live; the new validator closes it
regardless. `validateProjectDirectory` is a lexical check (empty /
traversal-in-the-string / control characters / absolute / not a filesystem or
system location); canonical containment of the resulting path is unchanged and
remains owned by `validateSwarmPath` and `validateSymlinkBoundary`, neither of
which this change touches.

### Absoluteness is not containment

An earlier revision of this change required only that the root be absolute. That
is insufficient, and not theoretically: because every caller writes under
`<root>/.swarm/`, a root of `E:\` or `\Windows` resolves to a real writable
location, and `validateSwarmPath` faithfully pins the write *inside a root that
is itself wrong*. Running `tests/security/adversarial/services-path-traversal.test.ts`
against the absolute-only validator created `E:\.swarm\session\budget-state.json`,
`E:\Windows\` and `E:\Users\Brett\AppData\Local\` on a developer machine.

Sixteen assertions in that file — which had demanded `/etc`, `/usr/bin`,
`\Windows`, `\`, `C:\Windows`, `C:/Windows`, `D:\Users` and `E:\` be rejected —
were the only thing that caught it. They were nearly realigned away as "an
assertion that encoded a dead feature". They are kept, and `assertNotSystemLocation`
is what makes them true again:

- a filesystem or drive root (`/`, `C:\`, `E:/`) is rejected outright;
- POSIX system hierarchies (`etc`, `usr`, `bin`, `sbin`, `lib`, `lib64`, `boot`,
  `dev`, `proc`, `sys`) are rejected as roots and as subtrees;
- Windows system hierarchies (`Windows`, `WinNT`, `Program Files`,
  `Program Files (x86)`, `ProgramData`, `System Volume Information`) are rejected
  on **any** drive — the observed damage was at `E:\Windows`, not `C:\Windows`,
  so denying only the system drive would have missed it;
- the user-container directories (`Users`, `home`, `root`) are rejected as an
  exact root child only, so `C:\Users\dev\app` and `/home/runner/work/x` — the
  normal cases — keep working;
- `var` is deliberately absent, because macOS `os.tmpdir()` is `/var/folders/...`
  and denying that subtree would reject every temp-rooted test workspace.

Both lists are evaluated on every platform, so a Linux CI runner and a Windows
host enforce an identical contract. The check stays purely lexical — no
`realpathSync`, no ancestor walk — because these callers sit on a per-turn hot
path behind a debug-gated catch, where I/O would be both a latency regression and
a silent-failure risk.

## Why

The context-budget warning, the `CONTEXT PRESSURE` advisory and the graduated
compaction tiers were all inert. `swarmState.lastBudgetPct` was written only by
the two throwing call sites (`origin/main:src/hooks/system-enhancer.ts:1696`
and `:2590`), so it stayed at 0 and every downstream consumer was dormant with
it. Run-memory recall was inert too, for a different reason (no producer); PR #2119
added one, so it is live as of this change.

The denominator fix is not cosmetic. Taking the architect system prompt at
roughly 34 500 estimated tokens — the approximate figure recorded alongside the
constant in `src/config/context-window.ts`, not re-measured for this note, and
an estimator output rather than a token-exact count — the unconfigured
40 000-token budget puts a fresh session at **86 %** (34 500 / 40 000 = 86.25 %)
on the first turn, which would have fired the budget
warning (≥ 70), the `CONTEXT PRESSURE` advisory (≥ 50) and the compaction
**EMERGENCY** tier (≥ 80) — the last of which instructs the model to discard
everything but the last few turns — immediately, in every session.

Unifying the two constants was necessary but not sufficient: a *constant* is the
wrong denominator regardless of its value. The same context measures ~27 %
against a 128 000-token window, ~17 % on a 200 000-token model and ~3.5 % on a
1 000 000-token one — and the destructive behaviour scales the same way. Because
`context-budget.ts` prunes messages once usage crosses
`critical_threshold × limit`, a session on a 1M-window model measured against
128 000 was not merely being nagged: it was having context deleted roughly eight
times earlier than it should have been. Deriving the value from
`model.limit.context` removes the guess wherever a live value is available; the
static rungs still guess when it is not.

## Migration

No configuration changes are required.

- **Most users** are now measured against their model's real context window
  rather than a constant. Not everyone: an explicit `model_limits` entry still
  wins (see the next bullet), and a session with no live window available falls
  through to the static table or the 128 000 constant.
- **Users who deliberately set a small `model_limits` value** keep exactly that
  value — an explicit entry outranks both the live window and the static table,
  because asking for a smaller *working* budget than the physical one is a
  legitimate choice. Two ordering changes landed here, and both are behaviour
  changes:
  1. `model_limits.default` moved from *below* the static tables to *above*
     them, so `resolveModelLimit('claude-sonnet-4-6', 'anthropic',
     { default: 50000 })` returned 200 000 (the table) and now returns 50 000,
     and `resolveModelLimit(m, 'copilot', { default: 200000 })` returned
     128 000 (the provider cap) and now returns 200 000. An explicitly authored
     value losing to a hardcoded table was a defect; the compound
     (`"<provider>/<model>"`) and model-only keys already outranked both
     tables, and `default` is now consistent with them.
  2. The live `model.limit.context` was inserted above both static tables,
     where previously no live value participated at all.
- **Everyone whose budget path was dead** (that is, everyone — the report threw
  on every call) now sees these signals for the first time: `[CONTEXT BUDGET: …]`
  advisories, the `CONTEXT PRESSURE` advisory above 50 %, and compaction
  directives at 40/60/80 %. The correct comparison is **none → some**, not
  "fewer": before this change the count of budget warnings, `CONTEXT PRESSURE`
  advisories and compaction directives produced in production was exactly
  **zero**. Set `context_budget.enabled: false` to opt out.
  The one signal that can genuinely get *less* frequent is message pruning in
  `src/hooks/context-budget.ts`: that hook never called `validateDirectory`, so
  it was live all along. Its denominator now tracks the real window, so it
  prunes less often on any model whose window exceeds what the old rungs
  reported (the common case — a 200k or 1M model previously measured against
  128 000) and *more* often on a model whose real window is smaller than that.
- `/swarm status` now renders the context estimate against the denominator the
  percentage was actually measured with, instead of back-computing it from a
  constant. Previously a user with `model_limits.default: 60000` saw warnings
  computed against 60 000 but a status line that said `/ 40,000 tokens` —
  40 000 being `DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens`, the constant that
  renderer used (`origin/main:src/services/status-service.ts:704`). (Both
  numbers were unreachable in practice, because the report that produces the
  percentage threw; the mismatch is what the fix removes.)
- The static tables in `src/hooks/model-limits.ts` (`NATIVE_MODEL_LIMITS`,
  `PROVIDER_CAPS`) are retained but demoted to a documented last-resort fallback,
  reachable only when no live window is available. They are deliberately NOT used
  to cap the live value: `PROVIDER_CAPS` claims Copilot caps everything at
  128 000, while the live catalog reports 200 000 for Copilot's
  `claude-sonnet-4.5` and 1 000 000 for `claude-fable-5`, so capping against them
  would reintroduce the very defect this change removes.
- Run-memory recall is live: PR #2119 added the missing producer
  (`recordTaskAttempt`), closing issue #2115.

## Caveats

- **The thresholds were calibrated against the old denominator and have not
  been re-tuned.** `getContextBudgetReport`'s numerator is the swarm's own
  footprint — system prompt + plan cursor + knowledge store + run-memory +
  handoff + `context.md` (`src/services/context-budget-service.ts:317-323`) —
  while the denominator is now the full model window. The four consumers are
  unchanged: `CONTEXT PRESSURE` at ≥ 50 % (`src/index.ts:2953`), compaction
  observation / reflection / emergency at 40 / 60 / 80 %
  (`src/services/compaction-service.ts:132`, defaults in
  `src/config/schema.ts:2315-2317`), and the budget warning's
  `warn_threshold` 0.7 / `critical_threshold` 0.9.

  Concretely, taking the same approximate ~34 500-token architect prompt as the
  baseline footprint, the swarm's own content must reach:

  | window | 40 % (observation) | 50 % (pressure) | 80 % (emergency) | 90 % (critical) |
  | --- | --- | --- | --- | --- |
  | 128 000 | 51 200 | 64 000 | 102 400 | 115 200 |
  | 200 000 | 80 000 | 100 000 | 160 000 | 180 000 |
  | 1 000 000 | 400 000 | 500 000 | 800 000 | 900 000 |

  The baseline injection alone crosses the lowest tier (40 %) only on a window
  of 86 250 tokens or smaller, and the 50 % tier only at 69 000 or smaller. On
  any model with a 200k or larger window, none of the four fires from normal
  swarm injection; reaching them requires the on-disk `.swarm/` content
  (knowledge store, `context.md`, `handoff.md`, plan cursor — all read
  uncapped) to add tens or hundreds of thousands of tokens. **These numbers were
  deliberately not changed.** Re-tuning them is a product decision with no data
  behind it yet, and inventing new constants here would repeat the mistake this
  change is fixing. An operator who wants the old behaviour sets an explicit
  `context_budget.model_limits` entry, which outranks the live window and
  restores a small denominator.

  `src/hooks/context-budget.ts` is **not** affected by this. Its numerator is
  the real message-token total, not the swarm footprint, so the live window is
  the correct denominator for it and its `warn_threshold`/`critical_threshold`
  remain meaningful exactly as written.
- Disabling `hooks.system_enhancer` silently disables the live-window relay.
  `createSystemEnhancerHook` returns `{}` when
  `config.hooks?.system_enhancer === false`
  (`src/hooks/system-enhancer.ts:662-666`), and that hook is the only place
  `setLiveContextWindow` is called (`:715`) — the host hands the `Model` object
  to `system.transform` alone. With the flag off, `getLiveContextWindow` returns
  `undefined` for every session and every `messages.transform` consumer,
  including the hard-pruning `context-budget.ts`, falls back to the static table
  for the whole session. Nothing else in the plugin reads or repairs this.
- `recordTaskAttempt` (PR #2119) is the producer for `.swarm/run-memory.jsonl`,
  wired from `src/plan/manager.ts:2194` and `src/tools/update-task-status.ts`.
  It validates transitively rather than directly — every filesystem touch goes
  through `getTaskHistory` or `recordOutcome`, both of which validate — which is
  why the trusted-root scan's `GUARDED_ENTRY_POINTS` deliberately has no row for
  it.
- After this change `validateDirectory` has **zero production callers** — it is
  retained, unweakened, and covered by tests, because it remains the correct
  primitive for untrusted relative input and the new guardrail depends on the
  distinction between the two.
- A critical-tier budget warning is deliberately not suppressible and re-emits
  every turn (`src/services/context-budget-service.ts:429-433`). That is
  pre-existing design. It is not reached by the swarm's own baseline injection
  at the corrected default — see the threshold table above — but it is not
  unreachable in principle: the numerator's five non-system-prompt inputs are
  uncapped on-disk reads (one of them, run-memory, is always empty today), so a
  very large knowledge store or `context.md` can still get there. It is worth
  revisiting if a user configures a small window.
- Any caller that was passing a RELATIVE project root now gets a thrown error
  instead of a silently cwd-anchored `.swarm/`. No production caller did this;
  one pre-existing test
  (`tests/unit/hooks/system-enhancer-budget-ledger-finally.test.ts:70-76`) does,
  via an in-repo `tmp/` directory. It is unaffected because its budget check is
  never reached, but the pattern violates AGENTS.md invariant 7 ("use
  `os.tmpdir()` + `path.join(...)` for temp paths") and is worth a separate fix.
  (`tmp/` *is* gitignored — `.gitignore:4` — so it leaves no untracked files; an
  earlier draft of this note claimed otherwise and was wrong.)
