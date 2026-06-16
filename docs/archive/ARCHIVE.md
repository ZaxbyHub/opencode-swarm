# Archive

Historical documents preserved for provenance. Nothing here is authoritative for current behavior — consult the live documentation in `/docs/` instead.

## What lives here

### `/docs/archive/dev/` — v6.9.0 development artifacts (18 files)

Planning documents from the v6.9.0 initiative (early 2026). Kept for traceability of design decisions that shaped the current quality-gate and anti-slop tooling.

- `phase0-execution-plan.md`, `phase0-tool-architecture.md` — Stage 0 baseline recon and tool architecture
- `stage1-plan.md` through `stage8-plan.md` — per-stage execution plans
- `v6-9-roadmap.md`, `v6.9.0-release-checklist.md` — release-level tracking
- `pr1-foundation.md` — dark-infrastructure foundation design note (still referenced from `/docs/architecture.md`)
- `sme-engagement-plan.md` — SME consultation schedule
- `tech-debt-review-v6.41.md`, `tech-debt-fix-plan-v6.41.md` — v6.41 cleanup pass (still referenced from `/docs/releases/v6.41.0.md`)
- `issue-495-closure-plan.md`, `issues-145-146-fix-plan.md` — issue-specific closure plans

### `/docs/archive/reports/` — point-in-time reports (2 files)

Analysis reports that captured the state of the codebase at a specific moment. Each file carries an archive header showing when it was snapshotted.

- `tech-debt-report.md` — CI/test-suite tech debt snapshot (2026-04-01)
- `knowledge-system-verification-report.md` — knowledge-system verification (2026-03-31)

### `/docs/archive/knowledge-system-audit.md` - root audit snapshot

Former root-level knowledge audit from 2026-04-26. It is retained for
provenance only; the maintained knowledge-system behavior is documented in
`/docs/knowledge.md` and `/docs/skills.md`.

## Why archive instead of delete?

Git preserves history, but references across docs sometimes outlive their sources. Archiving in place keeps the files reachable at stable paths while signalling that they are no longer maintained. Two live docs still link into this archive:

- `/docs/architecture.md` → `archive/dev/pr1-foundation.md`
- `/docs/releases/v6.41.0.md` → `archive/dev/tech-debt-review-v6.41.md`

## Finding older history

For file history that predates the archive:

```bash
git log --follow docs/archive/dev/<filename>
git log --follow docs/archive/reports/<filename>
```

For content that was deleted entirely, see `git log --diff-filter=D`.
