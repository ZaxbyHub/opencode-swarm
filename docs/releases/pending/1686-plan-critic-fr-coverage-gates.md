Fix issue #1686 by making plan-critic approval and FR traceability mechanical. Coder execution now requires a current critic-approved plan snapshot, and `save_plan` reports structured requirement coverage while blocking unmapped MUST/SHALL FRs unless explicitly overridden.

## Migration steps

Plans and ledgers created before this change carry no `plan_critic_gate`-tagged approval snapshot. On the first coder dispatch after upgrading, the mechanical gate will fail closed with `PLAN_CRITIC_GATE_VIOLATION` for these in-flight plans, even if the plan was previously approved under the old (unenforced) workflow. To recover, re-run `MODE: CRITIC-GATE` to obtain a fresh critic `APPROVED` verdict — this records the required snapshot — then resume `MODE: EXECUTE` and retry the coder dispatch.
