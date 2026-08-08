# Context Budget: prune real tool outputs (ToolPart.state.output)

## What

Fixes the context-budget engine so it recognizes, counts, masks, and prunes
real OpenCode tool-result payloads, allowing context enforcement to reduce the
previously invisible tool-output tokens that caused provider over-limit errors
(`32769 tokens requested > 32768 maximum`) on small-context models. Resolves
#2068.

Note: this makes enforcement able to actually free tool-output tokens. It does
not add a hard guarantee that a post-transform request always fits the model
limit — when there are no removable messages, the handler still warns and lets
the request proceed.

## Why

The context-budget and message-priority code was written against an invented
message shape (`info.toolName` + `role: 'assistant'`) that never matched the
OpenCode SDK contract. In the SDK, `Message = UserMessage | AssistantMessage`
(role `"user" | "assistant"` only — there is no `role: 'tool'` and no
`info.toolName`), and tool results are `ToolPart` objects
(`part.type === 'tool'`, `part.tool`, `part.state.output`) inside an assistant
message's `parts[]`. Because of this mismatch:

- `isToolResult()` always returned `false` on production payloads.
- The token counter only counted `part.type === 'text'`, so it never counted
  `ToolPart.state.output` (the heavy payload) — systematically undercounting
  real prompt size.
- Masking/pruning only rewrote text parts, so even when enforcement fired it
  freed ~0 tokens from tool outputs.

The net effect was the reporter's symptom: enforcement logged
`no removable messages found but still N tokens` and passed an unpruned prompt
to the provider. The reporter's proposed fix targeted a `role: 'tool'` /
`info.toolName` shape that does not exist in the `messages.transform` hook
(`role: 'tool'` is the AI-SDK provider-serialized form, not the hook's
`{info, parts}` form) and would not have fixed the token-counter defect.

## Changes

- `src/hooks/message-priority.ts`: detect tool results via `ToolPart` presence
  (`getToolParts`, `getCompletedToolOutputs`, `getToolNames`). Rewrote
  `isToolResult` to match the real SDK shape and deleted the fictional
  `info.toolName`/`info.toolArgs` interface fields. `isDuplicateToolRead` now
  compares `part.tool` and the first `state.input` value.
- `src/hooks/context-budget.ts`: the token counter now counts completed
  `ToolPart.state.output`; `extractMessageText` includes it for size/freed
  estimates; masking and pruning replace a completed `ToolPart` with a
  synthetic `{ type: 'text', text: placeholder }` part (rather than mutating
  the `ToolState` discriminated union, which would corrupt the SDK shape and
  break downstream lifecycle/summarizer consumers). Error-state outputs are
  never masked (preserve diagnostic signal); pending/running tools have no
  output and are skipped. Removed the dead `extractToolName` regex fallback.
- `src/hooks/index.ts`: export the new helpers.
- Tests: migrated all fixtures in `message-priority.test.ts` and
  `context-budget.test.ts` to the real `ToolPart` shape and added 15
  regression tests (T1–T15, split across `context-budget-2068-toolpart.test.ts`
  and `context-budget-2068-edge-cases.test.ts` for the FR-006 500-line cap)
  covering the issue scenario (32k-model overflow), exempt tools,
  error/pending/running states, multiple tool parts per message, mixed
  exempt+non-exempt messages, `preserve_last_n_turns` protection, idempotency,
  and pending-only messages.

## Invariant audit

- 1 (plugin init): not touched.
- 2 (runtime portability): not touched.
- 3 (subprocesses): not touched.
- 4 (.swarm containment): not touched.
- 5 (plan durability): not touched.
- 6 (test_runner safety): not touched.
- 7 (test writing): touched — new tests are pure-handler over synthetic
  `{info, parts}` arrays; no `mock.module`; no `_internals` seam;
  `scripts/mock-allowlist.txt` unchanged.
- 8 (session state): not touched.
- 9 (guardrails/retry): not touched.
- 10 (chat/system msg): touched — modifies message-transform behavior; verified
  in-repo that mutating `output.messages[].parts[]` reaches the provider
  (v6.85.1, v7.4.0).
- 11 (tool registration): touched — exports new helper functions from
  `src/hooks/index.ts`; no plugin `tool:{}` registration change; no
  `TOOL_NAMES` / agent-map change.
- 12 (release/cache): touched — this fragment; release-please owns the version.
