## Tool auto-registration via a single manifest

Tool registration is now driven by one file, `src/tools/manifest.ts`. Each tool
has a single `TOOL_MANIFEST` entry with its `description`, default `agents`, and
`handler`; `TOOL_NAMES`, `TOOL_NAME_SET`, `TOOL_DESCRIPTIONS`, `AGENT_TOOL_MAP`,
and the plugin `tool: {}` object are all derived from it.

**Why:** the previous four-site registration (`tool-names.ts`, the tools barrel,
`constants.ts`, and the plugin wiring in `index.ts`) was the root cause of the
"registered but dead" tool bug class — miss one site and a tool silently failed.

**What this gives you:**
- Adding a tool requires editing exactly one file.
- Forgetting `description`, `agents`, or `handler` is now a compile error.
- A new CI check (`scripts/check-tool-registration.ts`) and the existing
  registration tests assert coherence against the real derived tool object.

**Migration:** none. All 82 existing tools behave identically (verified by a
parity test against the previous hand-authored registration).

**Notes / caveats:**
- Agent-name constants moved to a new dependency-free leaf module
  `src/config/agent-names.ts`; `src/config/constants.ts` re-exports them, so
  existing `import { ALL_AGENT_NAMES, AgentName } from '../config/constants'`
  call sites are unchanged.
- The manifest is intentionally not tree-shakeable (single record). Async-init
  and runtime-conditional tools are documented extension points in the manifest
  header but are not implemented (no current tool needs them, and async handler
  resolution would conflict with the synchronous bounded plugin-init contract).
