# OpenCode Swarm Documentation

OpenCode Swarm is an architect-centric agentic swarm plugin for OpenCode. It coordinates specialized, configurable agents for planning, code generation, review, testing, documentation, security checks, memory, and recovery. This documentation covers installation, configuration, usage, architecture, and contributor workflows.

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
| [Commands Reference](commands.md) | `/swarm` subcommands, flags, deprecated aliases, and examples |
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
| [Generated Skills](skills.md) | How knowledge becomes draft or active generated skills, and how to review them |
| [Swarm Memory](memory.md) | SQLite-default memory, legacy JSONL migration, scoped recall, proposal-only writes, redaction policy |
| [Evidence and Telemetry](evidence-and-telemetry.md) | Evidence bundle schema, JSONL event stream, how to analyze results |
| [Work Complete Council](council/README.md) | Optional consensus gate for verifying phase completion |
| [Troubleshooting](troubleshooting/recovery-guide.md) | Session recovery, common error scenarios |

### Architecture and Design

| Document | Covers |
|----------|--------|
| [Architecture Deep Dive](architecture.md) | Control model, agent roles, full execution pipeline, tools, evidence schema, modes, guardrails |
| [Adding a Language](adding-a-language.md) | Extending the language registry with a new profile and (optionally) a custom backend; backend invariants and tests |
| [Design Rationale](design-rationale.md) | Core design decisions: serial execution, phased planning, persistent memory, gated QA |
| [Plan Durability](plan-durability.md) | How `.swarm/plan-ledger.jsonl` provides crash-safe plan persistence |

---

## Release History

**Current package metadata:** see [`package.json`](../package.json) and [`CHANGELOG.md`](../CHANGELOG.md). In this checkout, `package.json` reports `7.46.1`, and the top changelog entry is `7.46.1` from 2026-05-29.

The full release history is documented in [CHANGELOG.md](../CHANGELOG.md). The per-version files under `docs/releases/` are supporting release-note artifacts and may not cover every changelog entry.

Recent highlights:

| Version | Highlights |
|---------|-----------|
| [v7.22.0](releases/v7.22.0.md) | Latest checked-in per-version release note |
| [v7.21.4](releases/v7.21.4.md) | Patch release notes |
| [v7.21.3](releases/v7.21.3.md) | Patch release notes |
| [v7.21.1](releases/v7.21.1.md) | Patch release notes |
| [v7.21.0](releases/v7.21.0.md) | Feature release notes |
| [v7.20.2](releases/v7.20.2.md) | Patch release notes |
| [v7.20.1](releases/v7.20.1.md) | Patch release notes |
| [v7.20.0](releases/v7.20.0.md) | Feature release notes |
| [v7.19.3](releases/v7.19.3.md) | Patch release notes |
| [v7.19.2](releases/v7.19.2.md) | Patch release notes |

Versioned release-note files are retained in `/docs/releases/`. Pending user-visible changes live in `/docs/releases/pending/` until release aggregation.

---

## Historical / Development Docs

These documents are archived from the v6.9.0 development phase and are retained for historical provenance.

See [Archive](archive/ARCHIVE.md) for:
- v6.9.0 phase planning documents (phase0-*, stages 1–8)
- Historical tech debt reviews and closure plans
- Archived issue-specific planning documents
- Point-in-time knowledge-system audits that are no longer maintained

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

*Last updated: 2026-06-14. Current package metadata was verified from `package.json` and `CHANGELOG.md`.*
