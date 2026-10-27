# Fix: Full-Auto allows eleven audited read-only swarm tools without a critic

## What changed

Full-Auto's deterministic classifier now allows `skill_list`, `skill_inspect`, `external_skill_list`, `external_skill_inspect`, `knowledge_receipt_status`, `retrieve_lane_output`, `lean_turbo_plan_lanes`, `plan_conflict_check`, `scope_validate`, `context_status` and `suggest_patch` at the safe tier. Each was audited by reading the tool module and the functions it calls: none mutates project source or scope authority, spawns a process or uses the network on its default path. Previously each call escalated to the critic, a child session with a fixed prompt of roughly 43k tokens.

The classifier ignores arguments, so two narrow side effects ride along. `plan_conflict_check` completes the one-shot migration of legacy `.swarm/scopes/binding-*.json` files (for the session's project root the Full-Auto permission hook already performs the same migration) and spawns bounded read-only `git` only when called with `use_cochange: true`. `context_status` may record the model-limit telemetry in `.swarm/learning-health.json` that the context-budget hook already writes for the session's project root. Both accept a `working_directory` override, as older members of this tier do, so those effects can also land on another project root.

Every other swarm tool keeps escalating. Four read-shaped tools are deliberately excluded because they write on their default read path: `lean_turbo_status` and `lean_turbo_runner_status` (every read can archive state and seed a projection), `export_pr_review_partial_results` and `convene_general_council`.

`isReadOnlyTool` is shared, so these eleven names are also allowed in every state where read-only tools already are: while a Full-Auto run is paused or terminated, while its state file is unreadable, while a task awaits completion, and in strict mode. The same set also feeds read-only subagent delegation: with a `tool_filter.overrides` entry that limits a role to these names (for example `[read, grep, suggest_patch]`), delegating to that role is now allowed without a critic outside strict mode. Default capability maps are unchanged for all 26 roles.

`suggest_patch` is no longer listed as write-like (it never writes), so the read-only and write-like sets are disjoint. When `oldContent` does not match a protected path (per the central protected-path policy, plus `.env.*` variants), its `context-mismatch` error no longer echoes the file's actual lines. The check runs on the path as written and on its resolved real path, each also lower-cased, so directory links, Windows 8.3 short names and case variants are covered.

## Why

Closes #3461. Follow-up to the "Classify the other 92 escalating tools" row left open in #3447.
