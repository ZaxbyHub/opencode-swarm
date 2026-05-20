# Operator Recovery Runbook

This guide covers common recovery scenarios for the opencode-swarm plan durability system.

---

## 1. Missing plan.json

**What happens:** `loadPlan()` detects missing `plan.json` and automatically rebuilds from the ledger.

**Manual recovery:** If the ledger is also missing:
```bash
# Option 1: Use importCheckpoint() programmatically
import { importCheckpoint } from './src/plan/checkpoint'
await importCheckpoint()

# Option 2: Restore from .swarm/SWARM_PLAN.json by copying it to `.swarm/plan.json`
```

---

## 2. Stale Session After Restart

**Symptom:** `[loadPlan] plan.json is stale (hash mismatch with ledger)` on startup.

**What happens:** `loadPlan()` detects hash mismatch between `plan.json` and the ledger, then rebuilds from ledger automatically.

**If it recurs:**
```bash
/swarm reset-session
```

---

## 3. Ledger Mismatch / Hash Mismatch

**Symptom:** `[loadPlan] plan.json is stale (hash mismatch with ledger)` in logs.

**Cause:** `plan.json` was written without going through the ledger (e.g., manual edit).

**Fix:** Automatic rebuild from ledger. If rebuild fails:
```bash
# Restore from .swarm/SWARM_PLAN.json by copying it to `.swarm/plan.json`
```

---

## 4. When to Use reset-session

**Use when:**
- Session state is stale after a crash
- Agent sessions are stuck
- Hash mismatch recurs after rebuild

**Do NOT use for:**
- Ledger corruption (use rebuild/import instead)
- Missing plan files (use `importCheckpoint()` programmatically or restore from .swarm/SWARM_PLAN.json instead)

---

## 5. When to Rely on Rebuild/Import

**Use rebuild when:**
- `plan.json` is missing or invalid
- Ledger is intact but plan projection is corrupted

**Use import when:**
- Starting fresh in a new repo with an existing `.swarm/SWARM_PLAN.json` checkpoint
- Ledger is also missing/corrupted and you have a checkpoint backup

---

## 6. Ledger Corruption

**Symptom:** `[ledger] Corrupted suffix quarantined` warning.

**What happens:** Bad suffix moved to `.swarm/plan-ledger.quarantine`, replay continues from last valid event.

**Action needed:** None required — replay is self-healing. Monitor quarantine file size; if it grows large, investigate the corruption source.

---

For architecture details, see `docs/plan-durability.md`.
