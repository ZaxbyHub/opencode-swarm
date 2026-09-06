### test: issue #2526 residual verification closure — prefixed-role delivery, trace-turn controls, captured provider request

Verification-closure change only: **no runtime behavior changed**. The #2526
fix itself (user-role guidance carriers replacing `role:'system'` entries on
the `experimental.chat.messages.transform` surface) shipped earlier; this
change closes the rebaselined issue's three residual verification obligations
with durable pinned tests, so the delivery contract cannot silently regress:

- **Prefixed-role delivery** (`tests/unit/hooks/host-guidance-prefixed-roles-2526.test.ts`):
  guidance delivery is now pinned for the two role surfaces the original exit
  gate never exercised — a multi-swarm prefixed architect
  (`agent: 'mega_architect'`, canonicalized through `stripKnownSwarmPrefix`
  for the guardrail advisory drain and the orchestrator knowledge path) and a
  non-architect child role (`agent: 'coder'`, distinct sessionID, transient
  `DEGRADED:` advisory forwarding plus the delegate knowledge-directive path).
  Both assert delivery through the pinned host converter
  (`tests/helpers/host-contract-v1_18_3.ts`, @opencode-ai 1.18.3) with zero
  `role:'system'` entries and no conversion throw.
- **Trace-turn controls** (`tests/unit/hooks/host-guidance-trace-controls-2526.test.ts`):
  the `--trace` turn is now covered with its three controls — a mixed
  legacy-flat/parts input (the flat parts-less entry passes through untouched
  while the `[MODE: ...]` directive still reaches the rendered request and the
  plugin introduces no parts-less entries of its own), an injection-free
  control (nothing seeded → no guidance carriers at all, clean render), and a
  parts-only control (identical MODE delivery without the flat entry).
- **Captured provider request**
  (`tests/fixtures/host-rendered-request-2526.json` +
  `tests/unit/hooks/host-rendered-request-2526.test.ts`): a committed,
  byte-stable capture of the rendered request for a turn carrying all three
  injection classes (guardrail advisory + knowledge recall + memory recall),
  derived through the real transform chain under a frozen clock. The parity
  test re-derives the request from the same seeds and asserts deep-equality
  with the fixture, so any drift in the composed chain, carrier format, or
  rendered structure fails loudly. Two per-run random tokens (the knowledge
  retrieval `trace_id` and the temp-dir-derived memory record id) are
  normalized to placeholders on both sides; everything else compares
  byte-for-byte.

Carrier-construction census — all 18 producer sites are disposed as migrated
to user-role guidance carriers: guardrails ×10
(`src/hooks/guardrails/messages-transform.ts:524,586,605,702,752,772,805,867,906,944`),
delegation ×3 (`src/hooks/delegation-gate.ts:6063,6131,6274`), issue-trace ×2
(`src/hooks/issue-trace.ts:273,280`), knowledge ×2
(`src/hooks/knowledge-injector.ts:850,993`), memory ×1
(`src/memory/injector.ts:170`). The only remaining `role:'system'`
construction in the plugin is the role-filter system-string adapter
(`src/context/role-filter.ts:257`), which serves the separate host-rendered
`output.system` surface (`experimental.chat.system.transform`) and never
enters the messages transform array.
