# OpenCode Swarm Documentation

OpenCode Swarm (v6.81.0) is an architect-centric agentic swarm plugin for OpenCode that orchestrates 11 specialized agents for planning, code generation, review, testing, and documentation. This documentation covers installation, configuration, usage, and architecture.

---

## Getting Started — Choose Your Path

**I am a new user** — I want to get Swarm running on my first project  
→ Start with [Getting Started](getting-started.md) — a 15-minute first-run walkthrough

**I am an operator** — I want to install Swarm in CI/container or a specific environment  
→ Choose your platform:
- [Installation Guide](installation.md) — comprehensive reference for all platforms
- [Installation: Linux + Docker](installation-linux-docker.md) — native Linux, Windows, Docker Desktop specifics
- [Installation: LLM Operator](installation-llm-operator.md) — machine-executable runbook for LLM-driven setup

**I am a contributor** — I want to understand the architecture or contribute to the project  
→ Read [Architecture Deep Dive](architecture.md) and [Design Rationale](design-rationale.md), then [CONTRIBUTING.md](../contributing.md)

---

## User Documentation

### For Day-to-Day Use

| Document | Covers |
|----------|--------|
| [Configuration Reference](configuration.md) | Config file locations, minimal example, all configuration keys |
| [Commands Reference](commands.md) | All 43 `/swarm` subcommands, flags, and examples |
| [Modes: Swarm vs Turbo vs Full-Auto](modes.md) | Execution modes, safety gates, when to use each |
| [Pre-Swarm Planning Guide](planning.md) | How to plan tasks before running, task field reference, multi-model planning, spec pipeline |
| [Swarm Briefing for LLMs](swarm-briefing.md) | Pipeline steps, task format, state machine — written for LLM plan authors |
| [PHP and Laravel Practical Guide](php-laravel.md) | Framework detection, Laravel command override, Pest/PHPUnit coexistence, SAST coverage |

### Examples

| Document | Covers |
|----------|--------|
| [Building a Web App](examples/web-app.md) | End-to-end walkthrough: React + auth with brainstorm, autonomous execution, and monitoring |

### Advanced Topics

| Document | Covers |
|----------|--------|
| [Knowledge System](knowledge.md) | Hive vs swarm knowledge, TTL decay, migration, quarantine workflows |
| [Swarm Memory](memory.md) | Local JSONL memory, scoped recall, proposal-only writes, redaction policy |
| [Evidence and Telemetry](evidence-and-telemetry.md) | Evidence bundle schema, JSONL event stream, how to analyze results |
| [Work Complete Council](council/README.md) | Optional consensus gate for verifying phase completion |
| [Troubleshooting](troubleshooting/recovery-guide.md) | Session recovery, common error scenarios |

### Architecture and Design

| Document | Covers |
|----------|--------|
| [Architecture Deep Dive](architecture.md) | Control model, 11 agent roles, full execution pipeline, tools, evidence schema, modes, guardrails |
| [Adding a Language](adding-a-language.md) | Extending the language registry with a new profile and (optionally) a custom backend; backend invariants and tests |
| [Design Rationale](design-rationale.md) | Core design decisions: serial execution, phased planning, persistent memory, gated QA |
| [Plan Durability](plan-durability.md) | How `.swarm/plan-ledger.jsonl` provides crash-safe plan persistence |

---

## Release History

**Latest version: v6.81.0** (released 2026-04-22)

The full release history is documented in [CHANGELOG.md](../CHANGELOG.md) (v6.15.0 through v6.81.0).

Recent highlights:

| Version | Highlights |
|---------|-----------|
| [v6.81.0](releases/v6.81.0.md) | Current version — documentation refresh |
| [v6.80.2](releases/v6.80.2.md) | Latest stable release with notes |
| [v6.80.1](releases/v6.80.1.md) | Patch release |
| [v6.78.0](releases/v6.78.0.md) | Stability improvements |
| [v6.77.0](releases/v6.77.0.md) | Feature releases and hardening |
| [v6.76.0](releases/v6.76.0.md) | Major feature additions |
| [v6.74.0](releases/v6.74.0.md) | Quality gate enhancements |
| [v6.73.0](releases/v6.73.0.md) | Critic hallucination verifier, phase_complete gate enforcement |
| [v6.72.0](releases/v6.72.0.md) | Knowledge N-phase TTL decay, stale-entry sweep |
| [v6.71.0](releases/v6.71.0.md) | Scope persistence, interpreter gating, audit logging |
| [v6.70.0](releases/v6.70.0.md) | Transparent write authority, symlink guards, universal deny prefixes |
| [v6.68.0](releases/v6.68.0.md) | SQLite constraint store, QA gate profiles, BRAINSTORM mode |
| [v6.67.0](releases/v6.67.0.md) | Council tools, round-history auditing |
| [v6.66.0](releases/v6.66.0.md) | Work Complete Council verification gate |
| [v6.65.0](releases/v6.65.0.md) | Workspace dependency graph |
| [v6.64.0](releases/v6.64.0.md) | Repo map and code graph |
| [v6.63.0](releases/v6.63.0.md) | Crash-safe ledger, typed concurrency errors |
| [v6.59.0](releases/v6.59.0.md) | State-of-the-art PR review agent, explorer hardening |
| [v6.58.0](releases/v6.58.0.md) | Structured spec format with RFC 2119 keywords |
| [v6.45.0](releases/v6.45.0.md) | Structured workspace search, patch suggestions, symbol extraction |

All versions from v6.15.0 onward have release notes in `/docs/releases/`.

---

## Historical / Development Docs

These documents are archived from the v6.9.0 development phase and are retained for historical provenance.

See [Archive](archive/ARCHIVE.md) for:
- v6.9.0 phase planning documents (phase0-*, stages 1–8)
- Historical tech debt reviews and closure plans
- Archived issue-specific planning documents

---

## Quick Links

- **[CHANGELOG.md](../CHANGELOG.md)** — full version-by-version history
- **[README.md](../README.md)** — project overview, feature summary, configuration quick ref
- **[CONTRIBUTING.md](../contributing.md)** — how to contribute, commit format, PR workflow
- **[TESTING.md](../TESTING.md)** — test framework (bun:test), mock isolation, CI pipeline

---

## Staying Current

- **New to Swarm?** Start with [Getting Started](getting-started.md)
- **Upgrading?** Check [CHANGELOG.md](../CHANGELOG.md) for breaking changes (rare)
- **Reporting issues?** See [CONTRIBUTING.md](../contributing.md) for how to file bugs
- **Have questions?** Check this index or search [CHANGELOG.md](../CHANGELOG.md) and [architecture.md](architecture.md) for your keyword

---

*Last updated: 2026-04-22. Covers opencode-swarm v6.81.0.*
