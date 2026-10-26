# Fix: Full-Auto allows eleven audited read-only swarm tools without a critic

## What changed

Full-Auto's deterministic classifier now allows `skill_list`, `skill_inspect`, `external_skill_list`, `external_skill_inspect`, `knowledge_receipt_status`, `retrieve_lane_output`, `lean_turbo_plan_lanes`, `plan_conflict_check`, `scope_validate`, `context_status` and `suggest_patch` at the safe tier. Each was audited by reading the tool module and the functions it calls: none writes, spawns a process or uses the network. Previously each call escalated to the critic, a child session with a fixed prompt of roughly 43k tokens.

Every other swarm tool keeps escalating. Four read-shaped tools are deliberately excluded because they write: `lean_turbo_status` and `lean_turbo_runner_status` (the read path can archive state and seed a projection), `export_pr_review_partial_results` and `convene_general_council`.

## Why

Closes #3461. Follow-up to the "Classify the other 92 escalating tools" row left open in #3447.
