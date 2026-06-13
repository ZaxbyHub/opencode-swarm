# Deep Research mode (`/swarm deep-research`) + `web_fetch` tool

## What

Adds a new read-only swarm mode for multi-source, fact-checked research that
produces a cited answer, plus the `web_fetch` tool it relies on.

- **`/swarm deep-research <question>`** (alias `/swarm deep research`) emits a
  `[MODE: DEEP_RESEARCH ...]` signal that the architect runs as an
  orchestrator-worker protocol: decompose the question into subtopics, gather
  evidence with `web_search` + `web_fetch` across up to N iterative rounds
  (re-planning gaps between rounds), dispatch parallel `sme` synthesis workers,
  verify every claim against its cited source with two reviewers, challenge
  high-stakes claims with the critic, and present a cited report in chat.
  Flags: `--depth standard|exhaustive`, `--max-researchers 1..6`,
  `--rounds 1..4`, `--brief`. The mode is read-only — it does not mutate source
  code, delegate to coder, or call `declare_scope` (same discipline as
  `/swarm deep-dive`).
- **`web_fetch`** (architect-only) retrieves the readable text of a single
  http(s) URL so claims can be grounded in primary sources rather than search
  snippets. Results are stored as `crawl` evidence documents alongside
  `web_search` results, with an `evidenceRef` for citation.

The protocol ships as a bundled skill (`.opencode/skills/deep-research/SKILL.md`,
mirrored to `.claude/skills/`) and is reached via the architect's
`### MODE: DEEP_RESEARCH` block.

## Why

The swarm already had the pieces for deep research — multi-model parallel
dispatch (`council`), read-only fan-out-and-verify discipline (`deep-dive`),
`web_search`, and the evidence cache — but no mode that composed them into an
iterative, source-grounded research workflow, and no way to read a full source
(only search snippets). `web_fetch` closes the source-reading gap and
`DEEP_RESEARCH` composes the existing primitives into the orchestrator-worker
pattern that current deep-research systems converge on (lead plans → parallel
workers → separate verification/citation pass).

## Configuration

Deep research uses external network access and is gated on the existing General
Council feature flag:

- `web_fetch` requires `council.general.enabled: true` (no search API key — it
  fetches arbitrary URLs directly).
- The DEEP_RESEARCH pre-flight additionally requires a search API key (Tavily or
  Brave) because it also runs `web_search`. If either is missing, the mode
  surfaces the gap and stops rather than producing ungrounded research.

## Security

`web_fetch` is the first arbitrary-URL fetcher in the repo, so it carries its own
SSRF and resource defenses:

- http/https schemes only (`file:`, `ftp:`, `data:`, … rejected).
- The host is DNS-resolved and every resolved address — plus literal-IP hosts —
  is checked against loopback / private / link-local / unique-local / CGNAT /
  metadata ranges, blocking the cloud metadata endpoint (`169.254.169.254`) and
  internal services.
- Redirects are followed manually and **re-validated on every hop**, so a public
  URL cannot 302 into an internal target.
- The response body is streamed and aborted once it exceeds `max_bytes` of
  decoded output (so a compressed bomb is bounded by decompressed size, not the
  advisory `Content-Length`), under an `AbortController` timeout.

## Migration

No breaking changes. The command, tool, and skill are all additive. `web_fetch`
is architect-only and inert unless `council.general.enabled` is set, so existing
projects see no behavior change until they opt into the feature and invoke
`/swarm deep-research`.
