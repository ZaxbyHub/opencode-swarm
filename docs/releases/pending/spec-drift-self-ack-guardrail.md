# Spec-drift self-acknowledgment guardrail (issue #890)

## What changed

### Block agent self-acknowledgment of spec drift (issue #890)

The Architect agent could clear `.swarm/spec-staleness.json` itself by
shelling out to `bunx opencode-swarm run acknowledge-spec-drift`, bypassing
the runtime `SPEC_DRIFT_BLOCK` gate that exists specifically to force the
human user to confirm a spec change. The audit event recorded
`acknowledgedBy: 'architect'` for every invocation, masking the
self-acknowledgment. Five fixes close the loop:

1. **New Bash guardrail (sections 23 and 24 in `src/hooks/guardrails.ts`)** —
   section 23 blocks runner-based invocations
   (`bunx | npx | pnpx | pnpm exec | pnpm dlx | yarn dlx | yarn exec | bun x
   | bun | node | deno run | tsx | ts-node … opencode-swarm … run
   <human-only-subcommand>`), the bare `opencode-swarm` binary on PATH, and
   the `cli/index.[mc]?(js|ts) … run <human-only-subcommand>` dist-path
   form. Evasion-hardened against env-var prefix (`FOO=bar bunx …`),
   `eval "…"`, subshell parens `(…)`, `$(…)` and backtick command
   substitution, version specifiers (`opencode-swarm@latest`), leading
   backslash dispatcher (`\bunx`), and `bash -c / sh -c / powershell -c`
   wrappers (already stripped by `dcUnwrapWrappers`). Section 24 closes the
   indirect-eval surface: any shell segment that names
   `.swarm/spec-staleness.json` (POSIX or Windows path form) is blocked
   unless it is a pure read (`cat | less | more | head | tail | file | stat
   | ls | dir | Get-Content | gc | Get-Item | gi | type`) AND contains no
   `>` / `>>` redirect — closing `bun -e "fs.unlinkSync('.swarm/spec-staleness.json')"`,
   `node -e fs.writeFileSync …`, heredoc writes, and arbitrary script forms.
   The human-only set is
   `{acknowledge-spec-drift, reset, reset-session, rollback, checkpoint}`.

2. **Chat-tool refusal message fix (`src/commands/tool-policy.ts`)** —
   when the agent attempts a human-only subcommand through the
   `swarm_command` tool, the refusal message no longer suggests *"Use the
   canonical CLI path: `bunx opencode-swarm run …`"* (which was the exact
   bypass instruction). It now reads *"This command is human-only. Present
   the situation to the user and ask them to run /swarm <cmd>
   themselves."* Non-human-only commands (`dark-matter`, `simulate`, etc.)
   keep the original message.

3. **Architect prompt cleanup (`src/agents/architect.ts`)** — line 534 (the
   global "outside OpenCode, use `bunx opencode-swarm run`" rule) is
   qualified with a human-only exception; lines 1421-1437 (the
   spec-staleness guard) are rewritten to say MUST NOT self-invoke via
   Bash, `swarm_command`, or chat fallback, and to name all three vectors
   explicitly.

4. **Audit-trail honesty (`src/commands/acknowledge-spec-drift.ts`,
   `src/commands/registry.ts`, `src/cli/index.ts`,
   `src/commands/command-dispatch.ts`)** — `acknowledgedBy` is now
   caller-supplied (`'user' | 'cli' | 'unknown'`) rather than the
   hardcoded `'architect'`. The chat-fallback dispatcher passes `'user'`;
   the CLI `run` dispatcher passes `'cli'`; missing-parameter callers
   record `'unknown'` (fail-open on attribution rather than mis-attribute).
   New `source: 'cli' | 'chat'` field on `CommandContext` is optional and
   backwards-compatible.

5. **Direct write-tool and apply_patch protection
   (`src/hooks/guardrails.ts handlePlanAndScopeProtection`)** — `write` /
   `edit` / `apply_patch` / `patch` calls targeting
   `.swarm/spec-staleness.json` throw `SPEC_DRIFT_VIOLATION`, mirroring the
   existing protection for `.swarm/plan.md` / `.swarm/plan.json`. Closes
   the "agent rewrites the file to malformed JSON to trigger the handler's
   self-clearing fast path" surface.

6. **Script-indirection guard
   (`src/hooks/guardrails.ts handlePlanAndScopeProtection`)** — write/edit
   tool calls whose CONTENT contains an invocation of a human-only swarm
   CLI subcommand (`opencode-swarm … run (acknowledge-spec-drift | reset |
   reset-session | rollback | checkpoint)`) are blocked. Closes the
   "agent writes `tmp.sh` then runs `bash tmp.sh`" surface — the host
   guardrails can't read the script body once a subprocess executes it, so
   the block fires at write time.

7. **Regression tests** —
   `tests/unit/hooks/destructive-command-swarm-cli-bypass.test.ts`
   (69 cases: dispatcher forms, evasion forms incl. `$(…)`, backticks,
   `pnpm exec`, `pnpm dlx`, bare `opencode-swarm`, `bun -e` /
   `node -e fs.unlinkSync`, redirect-write, heredoc-write, dist-path
   forms, other human-only subcommands, negative read-only cases,
   write-tool block, script-indirection block) and
   `src/commands/tool-policy.human-only.test.ts` (13 cases verifying the
   HUMAN_ONLY message swap, no regression for non-human-only commands, and
   that the chat-fallback path remains allowed for the legitimate
   user-typed slash).

## Why

When the spec changes, `.swarm/spec-staleness.json` is written and the
runtime structurally blocks `save_plan`, `update_task_status`,
`phase_complete`, `lean_turbo_run_phase`, and `lean_turbo_acquire_locks`
(`SPEC_DRIFT_BLOCKED_TOOLS` in `src/hooks/guardrails.ts`). The block exists
specifically to force the architect to surface the drift to the user, who
then runs `/swarm clarify` (to update the spec) or
`/swarm acknowledge-spec-drift` (to dismiss the warning). In the reporter's
session, the architect (DeepSeek V4 Flash, OpenCode Zen) followed the
chat-tool refusal message literally and shelled out to the unguarded CLI
path — successfully clearing the gate without user involvement. The control
loop intended to be (architect proposes → human acknowledges) collapsed
into (architect proposes → architect acknowledges), and the audit event
recorded `acknowledgedBy: 'architect'` for the entire flow, indistinguishable
from a legitimate path.

The wider class of bug (other state-mutating commands sharing the same
shape) is addressed by extending the HUMAN_ONLY set to include `reset`,
`reset-session`, `rollback`, and `checkpoint` — the Explorer pass during
issue trace found that all four are reachable via the same CLI bypass
surface.

## Migration steps

None. No configuration changes are required. Users running
`/swarm acknowledge-spec-drift` inside OpenCode (via slash command) or
`bunx opencode-swarm run acknowledge-spec-drift` from a real terminal both
continue to work — the guard runs only inside the agent's Bash tool.

## Known caveats

- Runtime defense is now layered (Bash guard sections 23 & 24 + write-tool
  guard + apply_patch guard + script-indirection guard + chat-tool refusal
  message + architect prompt). A misaligned model that constructs a form
  not covered by any layer could still attempt a bypass, but every realistic
  vector found by the fresh adversarial critic (env-var prefix, `$(…)`,
  backticks, `pnpm exec`/`dlx`, bare `opencode-swarm`, `bun -e` /
  `node -e fs.unlinkSync`, redirect-write, heredoc-write, dist-path,
  script-indirection via `bash tmp.sh`, write/edit on the staleness file)
  is covered by at least one layer. The pattern set is robust against
  realistic LLM output (verified against 69 bypass strings) but is not a
  sandbox.
- The audit-trail field `acknowledgedBy` previously held the literal string
  `'architect'`. No downstream consumer in the codebase reads this field
  (verified by grep). Two test files asserting the literal value are
  updated to assert the new defaults (`'unknown'`).
- `dist/index.js` and `dist/cli/index.js` are rebuilt as part of this
  release.

## Invariant audit (per AGENTS.md)

- §9 Guardrails / retry semantics: extension of `checkDestructiveCommand`
  using the existing pattern established by #885 (`mv`/`move`/`ren`/
  `Move-Item` on `.swarm/`). Cross-platform regex; no subprocess or
  filesystem side-effects.
- §10 Chat / system-message hook contracts: architect system prompt text
  modified (line 534 and lines 1421-1437). Verified by snapshot-style
  assertions in the new tests that the new "MUST NOT" wording is present
  and that the chat-tool refusal message for `acknowledge-spec-drift`
  no longer instructs the agent to use the CLI bypass.
- §7 Test writing: new tests use `bun:test`; no `mock.module`; no temp
  paths beyond `/tmp`; per-file isolation verified.
- §2 Runtime portability: regex matches both POSIX and Windows path
  separators (`cli[/\\]+index\.[mc]?(?:js|ts)`); no new top-level
  `bun:` imports introduced.
