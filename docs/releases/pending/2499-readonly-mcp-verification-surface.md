### Read-only MCP verification surface: `swarm mcp serve` exposes verification state to any MCP client

**What changed**

- New `opencode-swarm mcp serve --dir <project-root> [--allow-write]` CLI
  entry (#2499, source #1227 phase 1): a stdio MCP server built on the
  official `@modelcontextprotocol/sdk` (new runtime dependency, `^1.30.0`).
  One server process binds to exactly one configured project root and is
  read-only by default — serving never writes anything under the project
  tree (pinned by a byte-identical-tree acceptance check).
- Ten read-only tools with names/descriptions sourced from the registered
  `TOOL_METADATA` (exact parity): `knowledge_recall`, `swarm_memory_recall`,
  `evidence_check`, `syntax_check`, `placeholder_scan`, `sast_scan`,
  `quality_budget`, `plan_conflict_check`, `diff`, `symbols`. Every tool maps
  to an existing registered production implementation — the four
  evidence-persisting cores (`syntaxCheck`, `placeholderScan`, `sastScan`,
  `qualityBudget`) gained persistence-free compute exports
  (`computeSyntaxCheck` etc.) so the registered tools keep their exact
  behavior (byte-identical wrapper path) while the MCP adapters run the same
  analysis without writing `.swarm/` state.
- Security envelope: per-call path containment against the canonical root
  (traversal, absolute-outside-root, and symlink/junction escapes rejected,
  reusing `path-security` helpers), responses redacted (`redactSecrets`)
  before being bounded to 65,536 serialized chars (redact-then-bound order),
  and SAST forced offline-only so no subprocess is reachable from the server.
- `docs/mcp.md` documents the server, its tools, the security model, and
  client setup for Claude Code, Cursor, and VS Code.
- MCP conformance and two-client evidence: the official SDK client AND a
  hand-rolled raw JSON-RPC stdio client both complete
  initialize → tools/list → tools/call round trips against a real served
  child process (frozen acceptance checks C4/C5).

**Why**

Swarm's verification layer (knowledge recall, evidence queries, syntax/SAST/
quality/scope checks) was reachable only through the OpenCode plugin host or
the CLI. Any MCP-capable client (Claude Code, Cursor, VS Code, JetBrains)
can now query it read-only for one project root — the largest audience
expansion without rewriting the orchestration core (#1227).
