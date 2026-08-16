# Observability Event Contract

Companion to `docs/evidence-and-telemetry.md` (evidence bundles + the legacy
telemetry stream from a user's point of view) and `docs/engineering-invariants.md`
(the invariant this PR establishes). This document is the contract definition for
`src/observability/`: the canonical event envelope, the 41-entry event catalog,
the legacy adapter, sampling/cardinality rules, the OTel mapping pin, and the
exhaustive producer/consumer matrix across all seventeen known observability
stores in the repository.

Issue: #2029. This is PR 01 of 23 in the observability sequence (#2029–#2051).

---

## 1. Purpose and scope boundaries

**What this PR defines.** A single canonical `ObservabilityEvent` envelope
(`src/observability/envelope.ts`), a discriminated catalog of every event kind
the codebase emits today (`src/observability/catalog.ts`, 41 entries), a
relationship-validation function, a legacy-payload adapter, deterministic
sampling and bounded-cardinality helpers, and a versioned OTel/OpenInference
attribute-mapping table. It wires the envelope into the one live production
event stream that already exists (`src/telemetry.ts:emit()`) as a documented,
lossy, in-memory computation, and it fixes one concrete instance of the defect
class this contract closes: `agent_conflict_detected` was emitted via a
force-cast past the type system (`src/hooks/conflict-resolution.ts:73`) and
is now a typed, catalogued kind.

**What this PR explicitly does NOT do** (the issue's Explicit Boundaries):

- **No new segment sink.** There is no new store, no new file, no new
  destination for observability data. `.swarm/telemetry.jsonl` is written with
  byte-identical content to before this change (one documented exception: payloads carrying an own accessor property — see `docs/engineering-invariants.md` issue #2029 entry). The sink is owned by **#2047**.
- **No SQLite query index.** The SQLite-backed memory stores (`memory_events`,
  `memory_recall_usage`, `memory_reward_events`) are inventoried in the matrix
  below but their query/index design is owned by **#2048**.
- **No OTLP network path.** `otel-mapping.ts` is a pure, inert lookup table.
  There is no OpenTelemetry SDK dependency, no exporter, and no network call
  anywhere in `src/observability/`. The runtime OTel consumer is owned by
  **#2049**.
- **No content capture.** No event in the current catalog is classified
  `privacyClass: 'content'`. This contract does not capture prompts, responses,
  code, documents, tool payloads, or hidden reasoning — see §5 for the
  `PrivacyClass` enum and the per-entry classification.
- **Does not replace authoritative state.** The plan ledger, scope
  declarations, evidence bundles, knowledge receipts, background-delegation
  ownership records, and council round state remain the sole authority for
  their respective domains. Telemetry is never substituted for them, and this
  PR does not normalize those stores onto the new envelope — the eleven other
  stores in the matrix below are read-only inventory here, not migration
  targets. (Explicit Boundaries; also see §6.)

---

## 2. The honesty clause

> **The envelope's non-legacy fields — `eventId`, `trace`, `lineage`,
> `provenance`, `policy`, `writerSequence`, and `relationshipViolations` — are
> currently DISCARDED. Nothing in this PR consumes them; their consumer lands in
> #2047. Issue #2029 item 5 arm (a) permits this because the export is wired to
> a live production producer and the existing output is preserved.**

**Corollary.** `validateEventRelationships` does **NOT** bite at runtime. In
production an invalid parent/link combination produces no failure signal,
because the envelope is discarded after `toLegacyTelemetryLine` runs. It bites
in unit tests (`tests/unit/observability/relationships-invalid.test.ts`) and in
the CI contract check (`scripts/check-event-contract.ts`, `bun run
check:events`). A reader of `src/observability/relationships.ts` or
`src/observability/observe.ts` must not conclude that a relationship violation
in production stops anything or is visible anywhere today — it is not.

---

## 3. The envelope reference

Defined in `src/observability/envelope.ts` as a zod schema (`z.infer`d for the
`ObservabilityEvent` type). The schema is safe-parsed by the tests
(`tests/unit/observability/envelope-roundtrip.test.ts`, all 41 kinds). It is **not** parsed by the
CI contract check, and **not** parsed on the `emit()` hot path; `createObservation` builds a plain
object and never calls `.parse()`, because parsing would reallocate on every
emit and would clone or reject `legacy.raw` (see §4).

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `number` | `OBSERVABILITY_SCHEMA_VERSION` (currently `1`). Versions the envelope shape itself — deliberately independent of the OTel mapping versions (§9). |
| `eventId` | `string` | RFC 4122 UUID v4, from `newEventId()` (`node:crypto` `randomUUID`). |
| `kind` | `string` | The wire event kind, e.g. `delegation_end`. |
| `category` | `EventCategory` | One of `lifecycle \| delegation \| gate \| plan \| evidence \| guardrail \| knowledge \| cost \| prm \| conflict \| unrecognized`. `unrecognized` is the runtime fail-open classification for an uncatalogued kind — never a drop. |
| `severity` | `EventSeverity` | Syslog-shaped ladder: `debug \| info \| notice \| warning \| error \| critical`. |
| `occurredAt` | `string` (ISO 8601) | When the described thing happened. Currently **equal to** `observedAt` for every producer, because no current producer supplies a distinct occurred time — a recorded finding, not an invented distinction. |
| `observedAt` | `string` (ISO 8601) | When the writer recorded the event. Set via `new Date().toISOString()` inside `createObservation`; this is the field `toLegacyTelemetryLine` reads for the written `timestamp`. |
| `writerSequence` | `number` | Per-process monotonic counter, incremented synchronously on every `createObservation` call (including the fallback path). Disambiguates same-timestamp ordering **within one writer process only** — never across processes or sessions, and reset by `resetObservabilityForTesting()`. |
| `trace.traceId` | `string` (32 lowercase hex) | W3C-compatible trace id, never all-zero. |
| `trace.spanId` | `string` (16 lowercase hex) | W3C-compatible span id, never all-zero. |
| `trace.parentSpanId` | `string \| undefined` | Absent when this event has no parent. **No current producer supplies a parent span, so this is never synthesized** — every catalog entry declares `requiresParent: false` (§5), and that is a truthful statement about the system today, not a placeholder. |
| `trace.links` | `SpanLink[]` | Typed non-parent relationships (`kind: resume \| lane \| cross-process \| retry \| parent-batch`), each carrying its own `traceId`/`spanId`. Empty for every event today. |
| `workflow.*` | all optional `string` | The thirteen recognized correlation IDs — see the enumeration below. |
| `lineage.projectRef` / `cohortRef` / `worktreeRef` | `string \| undefined` | Salted, truncated SHA-256 digests (`pseudonymousRef`, `src/observability/ids.ts`). Computed **once** at `initObservability` and reused for every event in the process — never per-emit. Never a path: the digest neither contains nor encodes one. But these are **pseudonyms, not anonymous values** — with the public default salt a holder of an export can CONFIRM a guessed path by re-hashing candidates, so "never reversible" would overclaim; setting `SWARM_OBSERVABILITY_LINEAGE_SALT` to a private per-install value restores guess-resistance and cross-install unlinkability. `cohortRef` and `worktreeRef` are computed **only** when a caller supplies `cohortLabel` / `worktreeId`; the sole production caller (`src/index.ts:732-744`) supplies neither, so both are `undefined` in every real run today and AC3 is asserted at unit level against the API rather than against a production emission path. |
| `provenance.*` | all optional `string` | `pluginVersion`, `opencodeVersion`, `runtime`, `runtimeVersion`, `os`, `arch`, `model`, `provider`, `gitSha`, `configHash`. `gitSha` and `configHash` are **deliberately `undefined`** — see §3.1. |
| `outcome.status` | `'success' \| 'failure' \| 'partial' \| 'unknown' \| undefined` | Absent means the producer said nothing about success/failure. `'unknown'` means the producer *did* report a result the adapter could not map — a different fact, kept distinct on purpose. |
| `outcome.reason` / `errorName` / `errorMessage` / `retryIndex` / `durationMs` | optional | Extracted where a legacy payload supplies them (`extractOutcome`, `src/observability/legacy.ts`). `durationMs` is never populated today — no current producer reports one, and deriving one would fabricate a measurement. |
| `policy.sampled` | `boolean` | Result of `shouldSample(traceId, sampleRate)` — deterministic, see §8. |
| `policy.sampleRate` | `number` | The rate in effect when this event was built. Default `1` (sample everything). |
| `policy.dropReason` | `string \| undefined` | How a drop is made observable, when one occurs. This PR introduces no dropping. |
| `policy.privacyClass` | `PrivacyClass` | `operational \| pseudonymous \| sensitive \| content` — see §5 for the per-entry classification and definitions. |
| `legacy.*` | see §4 | The lossy legacy projection. |
| `relationshipViolations` | `string[]` | Stable machine-readable codes from `validateEventRelationships`. Empty means every catalogued relationship rule was satisfied. See §2 for why this does not bite in production. |

### 3.1 The workflow IDs

`envelope.workflow` (`WorkflowIdsSchema`) declares exactly the thirteen IDs
issue #2029 item 1 names, **all optional**:

`rootConversationId`, `hostSessionId`, `swarmSessionId`, `taskId`, `phaseId`,
`laneId`, `batchId`, `resultId`, `councilRoundId`, `backgroundInvocationId`,
`knowledgeTraceId`, `knowledgeEntryId`, `prRunId`.

> **The rule, stated prominently because it is the load-bearing invariant of
> this contract:** an ID the producer does not genuinely hold stays
> `undefined` — never `''`, never synthesized. `extractWorkflowIds`
> (`src/observability/legacy.ts:362-421`) implements only the mappings a real
> producer actually populates today (`sessionId → hostSessionId`, `taskId`,
> `phase → phaseId`, `laneId`, `batchId`); the other eight recognized IDs have
> no current legacy-telemetry producer, and inventing an extraction for them
> would manufacture exactly the join issue #2029 item 2 forbids.

Git SHA and config hash (`provenance.gitSha` / `provenance.configHash`) follow
the same rule for a documented reason: obtaining a HEAD SHA on the plugin init
path would require a **third** init-path git subprocess (`ensureSwarmGitExcluded`
already runs two — `git rev-parse --show-toplevel` and `git rev-parse
--git-path info/exclude`, `src/utils/gitignore-warning.ts:238,257` — neither of
which yields a SHA), and AGENTS.md invariant 1 forbids adding unbounded git
work before the plugin manifest returns ("bounded is not free"). Recording them
as explicitly missing rather than `''` or `'unknown'` is issue item 4's own
rule applied to this contract's own producer.

---

## 4. The lossy projection

`toLegacyTelemetryLine` (`src/observability/observe.ts:368-383`) turns a
canonical `ObservabilityEvent` into the line actually written to
`.swarm/telemetry.jsonl`:

```
{ timestamp: event.observedAt, event: event.kind, ...(event.legacy.raw) }
```

**`legacy.raw` is a declared envelope field holding a REFERENCE to the
caller's payload object — an alias, not a copy.** Aliasing is required, not
incidental:

1. **Caller key order** is preserved after `timestamp` and `event`, because the
   *original* object is spread, not a reconstruction of it.
2. **Caller key collisions win on value.** `src/hooks/conflict-resolution.ts:55-66`
   supplies its own `timestamp` and `type` fields; the caller's `timestamp`
   value must keep overwriting the envelope's `timestamp` key while that key
   keeps position 1 in the output — exactly what `...raw` spread last produces.
3. **`undefined`-key elision** is unchanged: `JSON.stringify` drops
   `undefined`-valued keys, and any clone or `zod.parse()` step applied to
   `raw` would change which keys survive or reorder them. No zod parse is ever
   applied to `legacy.raw`.

It is also a hard safety requirement: `src/telemetry.test.ts:137-162` emits
circular objects, functions, `Symbol`s, and `BigInt`s and asserts `emit()` does
not throw. Cloning or `JSON.stringify`-ing `raw` would throw on those payloads;
`createObservation` and `toLegacyTelemetryLine` never do either.

**State this plainly: the written `.swarm/telemetry.jsonl` line is a LOSSY,
LEGACY-PINNED projection of the canonical event, not the canonical event
itself.** The `timestamp` field *is* a real, load-bearing data dependency on
the canonical event (`event.observedAt`), which is why this composition is not
the identity function on the object literal the pre-change inline construction
in `src/telemetry.ts` `emit()` built —
but every field beyond `timestamp` and `event` on the written line comes
straight from the caller's own object, exactly as it did before this change,
and every canonical field not named above is discarded at this boundary (§2).

A non-object, `null`, or array payload yields just `{ timestamp, event }`,
matching what `JSON.stringify({ timestamp, event, ...data })` produced for
those inputs before this change.

---

## 5. The 41-entry catalog

Source: `src/observability/catalog.ts`. Exactly 41 entries = the 38 pre-existing members of
`TelemetryEvent` (`src/telemetry.ts:15-91`) plus `agent_conflict_detected`
(emitted in production via a force-cast past the type system before #2029)
plus `close_archive_result` (issue #2030 — the structured close/archive
result event) plus `knowledge_receipt_transition` (issue #2031, the bounded
diagnostic projection of authoritative receipt transitions).

Legend: **Owner** is `futureOwnerIssue` when `consumers` is empty (permitted
only together with an owner — an empty consumer list with no owner is a CI
hard failure), otherwise the live reader file:line. **Retention** is
`retentionOwnerIssue`. Privacy classes are defined in §3 (`policy.privacyClass`
row) and repeated inline only where the reason is non-obvious.

`ISSUE_SINK = #2047` (observability sink/consumer, and the default backstop
for a currently-unread kind). `ISSUE_LIFECYCLE_RETENTION = #2045`.
`ISSUE_COST_RETENTION = #2043`. `ISSUE_PLAN_EVIDENCE_RETENTION = #2036`.

### Lifecycle category

#### session_started
Category `lifecycle`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:399`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId`. OTel mapping: `openinference`.

#### session_ended
Category `lifecycle`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:403`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId`. OTel mapping: `openinference`.

#### agent_activated
Category `lifecycle`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:407`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId`. OTel mapping: `openinference`.

#### task_state_changed
Category `lifecycle`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:444`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId`, `taskId`. OTel mapping: `openinference`.

#### phase_changed
Category `lifecycle`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:492`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId` (the producer emits `oldPhase`/`newPhase`,
not `phase`, so no `phaseId` is extractable — requiring one would violate on
every event). OTel mapping: `openinference`.

#### heartbeat
Category `lifecycle`, severity `debug`, privacy `pseudonymous`. Producer
`src/telemetry.ts:642`. Consumer: `src/telemetry.ts:153` (in-process
`addTelemetryListener` heartbeat feeding `/swarm status`). Retention: **#2045**.
Required workflow IDs: `hostSessionId`. `allowsLinks: false` — a point-in-time
liveness ping has no work to link to.

#### turbo_mode_changed
Category `lifecycle`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:650`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId`.

#### environment_detected
Category `lifecycle`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:675`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId`. `allowsLinks: false` — a host-environment
fact, not a unit of work.

### Delegation category

#### delegation_begin
Category `delegation`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:411`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId`, `taskId`. OTel mapping: `genai`.

#### delegation_end
Category `delegation`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:421`. Consumer: `src/services/cost-accounting.ts:127`
(`readTelemetryEvents` → `summarizeTelemetryCosts` → `/swarm costs`). Retention:
**#2043**. Required workflow IDs: `hostSessionId`, `taskId`. OTel mapping:
`genai`.

#### model_fallback
Category `delegation`, severity `notice`, privacy `pseudonymous`. Producer
`src/telemetry.ts:506`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `hostSessionId`. OTel mapping: `genai`.

### Gate category

#### gate_passed
Category `gate`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:453`. Consumers: none — owner **#2047** (verified:
`src/evaluation/gate-stats.ts:99` filters for `reviewer_gate_decision` only;
nothing reads `gate_passed`). Retention: **#2045**. Required workflow IDs:
`hostSessionId`, `taskId`.

#### gate_failed
Category `gate`, severity `warning`, privacy `pseudonymous`. Producer
`src/telemetry.ts:470`. Consumers: none — owner **#2047** (same verification as
`gate_passed`). Retention: **#2045**. Required workflow IDs: `hostSessionId`,
`taskId`.

#### gate_parse_error
Category `gate`, severity `warning`, privacy **`sensitive`** (carries a
free-text error message that can embed a path). Producer
`src/telemetry.ts:457`. Consumers: none — owner **#2047**. Retention: **#2045**.
Required workflow IDs: `taskId` only — verified at `src/telemetry.ts:456-462`:
the producer takes only `(taskId, error)` and has **no** `sessionId`, unlike
every sibling helper. Forbidden workflow IDs: `hostSessionId` (a session id on
this kind would mean one was manufactured).

#### reviewer_gate_decision
Category `gate`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:480`. Consumer: `src/evaluation/gate-stats.ts:99`. Retention:
**#2045**. Required workflow IDs: `hostSessionId`, `taskId`.

### Cost category

#### budget_updated
Category `cost`, severity `info`, privacy `pseudonymous`. Producer
`src/telemetry.ts:496`. Consumers: none — owner **#2047**. Retention: **#2043**.
Required workflow IDs: `hostSessionId`.

### Guardrail category

#### hard_limit_hit
Category `guardrail`, severity `error`, privacy `pseudonymous`. Producer
`src/telemetry.ts:521`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`.

#### revision_limit_hit
Category `guardrail`, severity `warning`, privacy `pseudonymous`. Producer
`src/telemetry.ts:530`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`.

#### loop_detected
Category `guardrail`, severity `warning`, privacy **`sensitive`**. Producer
`src/telemetry.ts:534`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`.

`sensitive`, not `pseudonymous`, because the `loopType` argument carries
filesystem paths today: the guardrail producer at
`src/hooks/guardrails/messages-transform.ts:554` passes `pending.message`, built
at `src/hooks/guardrails/tool-before.ts:1513` as `Modified N file(s): <paths>` —
free text embedding a path, which is exactly the `sensitive` definition in §3.
The kind has a second producer
(`src/hooks/guardrails/nontransient-circuit.ts:282`) that passes a clean
closed-vocabulary `nontransient:<category>`, but a per-kind privacy class must
take the worst case across producers; one clean producer cannot downgrade it.

#### scope_violation
Category `guardrail`, severity `error`, privacy **`sensitive`** (carries `file`,
a repository-relative or absolute path). Producer `src/telemetry.ts:630`.
Consumers: none — owner **#2047**. Retention: **#2047**. Required workflow IDs:
`hostSessionId`.

#### qa_skip_violation
Category `guardrail`, severity `warning`, privacy `pseudonymous`. Producer
`src/telemetry.ts:638`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`.

#### auto_oversight_escalation
Category `guardrail`, severity `warning`, privacy `pseudonymous`. Producer
`src/telemetry.ts:660`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId` (`phase` is an *optional* parameter here,
`src/telemetry.ts:540`, so `phaseId` is deliberately not required).

### PRM category

#### no_op_strong_warning
Category `guardrail`, severity `warning`, privacy `pseudonymous`. Repeated no-op agent turns crossed the strong-warning threshold.
Producer `src/telemetry.ts:548`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`. Added to main by #2063 while this PR was open.

#### gate_denial_loop
Category `guardrail`, severity `warning`, privacy `pseudonymous`. The same (session, tool, denial-code) streak reached the hard rung (#2063 B1).
Producer `src/telemetry.ts:569`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`. Added to main by #2063 while this PR was open.

#### execution_stall_warning
Category `guardrail`, severity `warning`, privacy `pseudonymous`. An ARMED execution episode reached the advisory rung (#2063 B5).
Producer `src/telemetry.ts:583`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`. Added to main by #2063 while this PR was open.

#### execution_stall_denied
Category `guardrail`, severity `error`, privacy `pseudonymous`. A non-productive tool was hard-denied at the stop rung (#2063 B5).
Producer `src/telemetry.ts:600`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`. Added to main by #2063 while this PR was open.

#### swarm_internals_read_denied
Category `guardrail`, severity `error`, privacy `sensitive`. A read resolved inside the installed opencode-swarm package and was denied (#2063 B4).
Producer `src/telemetry.ts:617`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`. Added to main by #2063 while this PR was open.

#### prm_hard_stop_delivered
Category `prm`, severity `error`, privacy `pseudonymous`. DELIVERY of a PRM hard stop, distinct from the `prm_hard_stop` TRIGGER (#2063 C2).
Producer `src/telemetry.ts:752`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`. Added to main by #2063 while this PR was open.

#### prm_pattern_detected
Category `prm`, severity `notice`, privacy `pseudonymous`. Producer
`src/telemetry.ts:690`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`.

#### prm_course_correction_injected
Category `prm`, severity `notice`, privacy `pseudonymous`. Producer
`src/telemetry.ts:704`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`.

#### prm_escalation_triggered
Category `prm`, severity `warning`, privacy `pseudonymous`. Producer
`src/telemetry.ts:717`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`.

#### prm_hard_stop
Category `prm`, severity `critical`, privacy `pseudonymous`. Producer
`src/telemetry.ts:731`. Consumers: none — owner **#2047**. Retention: **#2047**.
Required workflow IDs: `hostSessionId`.

### Evidence category (dark — "emitted but no live parallel paths", `src/telemetry.ts:39`)

#### evidence_lock_acquired
Category `evidence`, severity `info`, privacy **`sensitive`** (carries
`directory` and `evidencePath`, both absolute paths). Producer
`src/evidence/lock.ts:94`. Consumers: none — owner **#2047**. Retention:
**#2036**. Required workflow IDs: `taskId`. Forbidden workflow IDs:
`hostSessionId` (this producer never receives a session id).

#### evidence_lock_contended
Category `evidence`, severity `notice`, privacy `sensitive`. Producer
`src/evidence/lock.ts:129`. Consumers: none — owner **#2047**. Retention:
**#2036**. Required workflow IDs: `taskId`. Forbidden workflow IDs:
`hostSessionId`.

#### evidence_lock_stale_recovered
Category `evidence`, severity `notice`, privacy `sensitive`. Producer
`src/evidence/lock.ts:86`. Consumers: none — owner **#2047**. Retention:
**#2036**. Required workflow IDs: `taskId`. Forbidden workflow IDs:
`hostSessionId`.

### Plan category (dark)

#### plan_ledger_cas_retry
Category `plan`, severity `notice`, privacy **`operational`** (only an attempt
counter, a hash prefix, and a delay — no identifiers). Producer
`src/plan/manager.ts:329`. Consumers: none — owner **#2047**. Retention:
**#2036**. Forbidden workflow IDs: `hostSessionId`.

#### plan_md_write_failed
Category `plan`, severity `warning`, privacy **`sensitive`** (carries
`directory` and a free-text filesystem error). Producer
`src/plan/manager.ts:1696`. Consumers: none — owner **#2047**. Retention:
**#2036**. Forbidden workflow IDs: `hostSessionId`.

#### snapshot_failed
Category `plan`, severity `error`, privacy `sensitive` (free-text filesystem
error message). Producer `src/plan/ledger.ts:681`. Consumers: none — owner
**#2047**. Retention: **#2036**. Forbidden workflow IDs: `hostSessionId`.

### Conflict category

#### agent_conflict_detected
Category `conflict`, severity `warning`, privacy `pseudonymous`. Producer
`src/hooks/conflict-resolution.ts:73`. Consumers: none — owner **#2047**.
Retention: **#2047**. Required workflow IDs: `hostSessionId`, `phaseId`
(`sessionId` and `phase` are required on the producer's own input,
`src/hooks/conflict-resolution.ts:12-21`; `taskId` is optional there, so it is
deliberately not required here). **This is the fixed defect instance**: before
this PR the event was emitted via `'agent_conflict_detected' as
Parameters<typeof emit>[0]`, a force-cast past `TelemetryEvent`
(`src/hooks/conflict-resolution.ts:73`, pre-fix); the cast is removed in
favor of a plain typed `emit(...)` call, and the kind is added to both
`TelemetryEvent` and `EVENT_CATALOG`.

#### close_archive_result
Category `lifecycle`, severity `notice`, privacy `operational`. Producer
`src/commands/close.ts:539` (`emitCloseArchiveResult`, called after the clean
stage so `source_disposition` can be finalized to `removed` for cleaned
artifacts). Consumers: none — owner **#2047**. Retention: **#2047**. The payload
is one structured result per archived artifact (`requiredness`/`attempt`/
`validation`/`source_disposition`/`method`/`reason_code`) plus aggregate
`archive_valid`/`archive_empty` health facts and `file_count`. Counts only — no
row content, no session/task identifiers — so `operational` is the truthful
privacy class. PR 16 will alarm on `archive_valid=false`; PR 20 will report the
health facts.

#### knowledge_receipt_transition
Category `knowledge`, severity `info`, privacy `pseudonymous`. Producer
`src/hooks/knowledge-receipt-observability.ts` after an authoritative V2 journal
transition commits. Consumers: none; owner **#2047**. Retention: **#2045**.
No workflow ID is always required: empty retrievals and uncertain legacy
transitions may truthfully hold no trace, entry, session, task, or phase ID.
When held, those IDs are copied without synthesis. The payload contains only a
closed transition kind (including distinct application-marker commits), closed
`reasonCode`, positive `schemaVersion`, positive `receiptSemantics` (issue
#2032: the outcome/source meaning-contract version, currently `2` — distinct
from the journal `schemaVersion` format gate, so health/reports consumers can
distinguish producer behavior and migration uncertainty). An ABSENT
`receiptSemantics` means the transition was emitted before this contract
existed (pre-#2032): consumers MUST treat such events' outcome/source
semantics as unknown, never default them to the current version. Optional
IDs, and bounded `receiptOutcome`/`receiptSource` domain codes drawn from the
canonical outcome/source taxonomy of `src/hooks/knowledge-receipt-ledger.ts`
(`receiptSource: 'delegate'` marks every new delegate terminal; legacy missing
source projects as `unknown`, never coerced). Those receipt
domain values deliberately do not populate the canonical generic `outcome`.
Arbitrary reason text and `nonTransientCircuit` are never accepted. This event
is diagnostic FIFO data only; the canonical-root V2 receipt journal remains the
sole authority. No live reader exists yet, so #2047 owns the future sink.

---

## 6. The exhaustive producer/consumer matrix (17 rows)

**Every row carries a `file:line` citation, but those citations are
UNGATED and go stale on any rebase that shifts a cited file.**
`scripts/check-event-contract.ts` mechanically validates the 41-entry
*catalog* in §5 (catalog ↔ `TelemetryEvent` union parity, per-entry
completeness) — it does not and cannot check this prose matrix. Treat a
citation here as "verified as of `origin/main` `0060f48d`", not as a standing
guarantee: that is the tree the line numbers were last re-verified in full
against. That sweep corrected, across all 16 rows: **8 wrong line numbers**
(including a **writer** citation 28 lines off target in row 7), **2 files that
were cited by **bare filename** and resolve outside the directory their
neighbours imply (`role-filter.ts` is `src/context/`, not `src/hooks/`;
`phase-complete.ts` is `src/tools/`), and **3 shifted `+1` by this PR's own
closeout rebase** (rows 13–15, from an import added upstream to
`src/memory/sqlite-provider.ts`). Making these citations gate-checked —
extending `checkCitationMentions` (`scripts/check-event-contract.ts:130`) over
the matrix, or demoting them to file-level references that cannot rot — **is
not yet owned by any issue.** It is deliberately not filed against #2047, whose
scope is the local segment sink, not this gate. Until an owner exists,
re-verify this section on every rebase; a green `check:events` says nothing
about it. The two are
deliberately different instruments: the catalog covers one store
(`.swarm/telemetry.jsonl`) at kind granularity; this matrix covers every known
observability store in the repository at store granularity, including the ten
this PR does not touch. Rows 1–12 come from a four-lane explorer sweep with a
fifth-lane re-verification pass (`.agents/issue-traces/2029-observability-event-contract/03-localization-log.md`);
rows 13–16 were added after a plan-critic round flagged them as missing, and
row 17 records the authoritative knowledge-receipt partition added by #2031.

| # | Store | Writer (file:line) | Reader(s) (file:line) | Discriminator | Clock | Schema ver. | Correlation carried | Correlation MISSING | Close/archive | State class | Owner |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `.swarm/telemetry.jsonl` (+`.1`) | `src/telemetry.ts:299` (the `stream.write(line, …)` call) | `src/services/cost-accounting.ts:133` (`readTelemetryEvents`) → `summarizeTelemetryCosts:124` → `/swarm costs`; `src/evaluation/gate-stats.ts:99`; in-process `addTelemetryListener` heartbeat (`src/telemetry.ts:146-163`) → `/swarm status` | `event` | ISO string | none | `sessionId`, `taskId`, `agentName`, `gate` | no trace/span id, no delegation id linking begin↔end; `gate_parse_error` has no `sessionId` (`gateParseError` emit payload, `src/telemetry.ts:457-461`) | yes — `close.ts:270-297` | operational | #2045 (lifecycle/terminals), #2043 (cost provenance) |
| 2 | `.swarm/context-telemetry.jsonl` | `src/context-map/telemetry.ts:154` | `src/context-map/telemetry.ts:181,225` → `src/commands/context-map-stats.ts:6,11` (sole non-test consumer, verified) | none (uniform shape) | ISO string | none | `task_id` only | `session_id`, agent identity beyond a free-text `agent_role` | **no** | operational | **#2037** |
| 3 | `.swarm/skill-usage.jsonl` | `src/hooks/skill-usage-log.ts:233` | `readSkillUsageEntries:321`, `readSkillUsageEntriesTail:389`, `applySkillUsageFeedback:760` → `bumpKnowledgeConfidenceBatch` | `type` (marker variant only) | ISO string | none (`skillVersion` versions the *skill*, not the record) | `sessionID`, `agentName`, `taskID`, `skillPath` | no trace/span | **no** | derived | **#2038** |
| 4 | `.swarm/events.jsonl` | ~30 call sites | `src/services/context-budget-service.ts:195` (line-count proxy for turn count — does NOT parse JSON); `src/hooks/curator.ts:1524` | **`event` OR `type`** (split across writers: `src/context/role-filter.ts:147`/`src/tools/phase-complete.ts:1571` use `event:`; `src/hooks/curator.ts:1759`/`src/hooks/full-auto-intercept.ts:269` use `type:`) | ISO string | none | inconsistent per writer | `sessionID` absent on `phase_complete`, `auto_oversight`, `context_filtered` | yes — `close.ts:275` | operational | **#2039** |
| 5 | `<knowledgeStore>/knowledge-events.jsonl` | `src/hooks/knowledge-events.ts` | `curator-postmortem.ts`, `knowledge-escalator.ts` (display-only escalation history), `knowledge-diagnostics.ts`, `learning-metrics.ts`; **no correctness reader** | `type` | ISO string | `schema_version` = 1 | `event_id`, `trace_id`, `session_id`, `task_id`, `phase`, `agent` | not authoritative; rows may be evicted and source values remain #2032-owned | follows the linked knowledge store; bounded FIFO | operational | #2032 (outcome/source normalization) |
| 6 | `<knowledgeStore>/knowledge-application.jsonl` (legacy v2) | `src/hooks/knowledge-application.ts` | compatibility/diagnostic consumers only; gates consume row 17 | none | ISO string | none | `sessionId?`, `taskId?`, `phase?`, `knowledgeId` | `event_id`, `trace_id`; lossy — `n_a` is stored as `acknowledged` | via knowledge store | derived | #2032 |
| 7 | `.swarm/evidence/{taskId}/trajectory.jsonl` | `src/hooks/trajectory-logger.ts:385` | `src/hooks/micro-reflector.ts:262`, `src/services/trajectory-cluster.ts:99` | none | ISO string | none | `agent`, `step` | `task_id`/`session_id`/`trace_id` **only in the path**, never the record body | yes — `evidence/` dir | derived | **#2036** (retention registry; #2041 owns *PRM session* trajectories, not this task-scoped store) |
| 8 | `.swarm/trajectories/{sessionId}.jsonl` | `src/prm/trajectory-store.ts:80` | `src/prm/index.ts:275,279`, `src/consensus/corpus.ts:641` | none | ISO string | none | `agent`, `step` | `session_id` **only in the filename** | **no** | derived | **#2041** |
| 9 | `.swarm/background-delegations.jsonl` | `src/background/pending-delegations.ts:716` | `pr-workflow-session-resolver.ts`, `pr-workflow-gate.ts`, `init-orphan-recovery.ts`, `delegation-gate/worktree-collision-ownership.ts` | `status` | **epoch-ms number** | `schemaVersion` 1\|2\|3 | `correlationId`, `parentSessionId`, `callID`, `jobId`, `planTaskId`, `evidenceTaskId`, `batchId`, `laneId`, `workflowLane`, `worktreeId` | no swarm-run id distinct from `parentSessionId` | **no — neither archived nor cleaned** | authoritative | **#2034** |
| 10 | `.swarm/session/shell-audit.jsonl` | `src/hooks/guardrails/audit-log.ts:332` | `src/services/guardrail-log-service.ts:63` (the only module that resolves the store path); `src/hooks/guardrails/index.ts:568` names the same path when wiring the writer. **Correction:** an earlier draft of this row cited `src/commands/archive.ts` as a reader with invented line numbers and behaviour — that file contains no reference to `shell-audit` at all, and the claim was removed (issue #2029 final-critic B-4). | `type` (**stripped for `shell`**, `:344-351`) | ISO string (caller-supplied) | none | `sessionID`, `agent`, `tool` | **no `callID`** → cannot join to row 9 (`background-delegations.jsonl`) | via `session/` dir — `close.ts:421-426` | operational | **#2040** |
| 11 | council evidence + `.swarm/council/{taskId}.rounds.jsonl` | `src/council/council-evidence-writer.ts:91` (evidence rewrite at `.swarm/evidence/{taskId}.json`; rounds append) | (council-consuming code paths; not itemized separately from evidence consumers) | none | `synthesis.timestamp` | none (implicit: `quorumSize` defaulted to 1 when absent, `:156-158`) | `sessionId` (= `swarmId`), `roundNumber` | `taskId` only in filename on the rounds log; no `callID` | evidence: yes; `council/`: **no** | authoritative | **#2046** |
| 12 | `.swarm/archive/swarm-{ts}-{suffix}/` | `src/commands/close.ts:1051-1054` | `src/commands/close.ts:1870-1875` (`fs.readdir(archiveDir)`, filters `startsWith('swarm-')` — retention pruning only; nothing re-reads bundle *contents*) | n/a | ISO in path | preserves bytes verbatim | n/a | n/a | is the archive | governed content | **#2030** |
| 13 | SQLite `memory_events` | `src/memory/sqlite-provider.ts:200-207` | memory-provider internal readers (not itemized here — index design is #2048's scope) | `operation` column | `timestamp` column, ISO string | table has no explicit version column (SQLite `_meta` table tracks migration version 4+, not per-row) | `target_id` | no `session_id`/`task_id` column | **no** | authoritative | **#2036** (retention), #2048 (index) |
| 14 | SQLite `memory_recall_usage` | `src/memory/sqlite-provider.ts:209-214` | memory-provider internal readers | `bundle_id` column | `timestamp` column, ISO string | none (migration-versioned schema, not row-versioned) | `bundle_id`, `run_id` (added migration v9) | no `session_id`/`task_id` column | **no** | derived | **#2036**, #2048 |
| 15 | SQLite `memory_reward_events` | `src/memory/sqlite-provider.ts:286` | memory-provider internal readers | `verdict` column | `timestamp` column, ISO string | none | `memory_id`, `run_id`, `unit_id` | no `session_id`/`task_id` column | **no** | derived | **#2036**, #2048 |
| 16 | `.swarm/pr-monitor/subscriptions.jsonl` | `src/background/pr-subscriptions.ts:26` (path constant `PR_SUBSCRIPTIONS_FILE`); writes serialized under `withEvidenceLock` | background PR-monitor poller (reads fold to latest snapshot per `correlationId`, lock-free) | full-record snapshot per line, folded by `correlationId` | ISO string (implementation-supplied) | none observed at the constant/module-doc level | `correlationId` | no explicit `sessionID`/`taskId` columns beyond `correlationId` | not itemized as archived by `/swarm close` in the localization sweep | operational | **#2042** |
| 17 | canonical project `.swarm/knowledge-receipts-v2.jsonl` + rebuildable snapshot + closed-summary archive | `src/hooks/knowledge-receipt-ledger.ts` (`commitDisplayedMembership`, `validateAndCommitTerminalBatch`, phase-close/cutover transitions) | receipt validator/tool, architect/delegate/reviewer acknowledgment paths, application and phase gates, promotion, escalation/quarantine, verdict feedback, and destructive-policy checks | versioned transition `kind` | ISO lifecycle clocks plus monotonic sequence | V2 schema + explicit cutover version | exact `trace_id` + `entry_id`, session/phase/task IDs, criticality, terminal event/source/reason, truthful promotion correlation | absent legacy membership is explicitly `legacy_unverifiable`; no synthesized join | `/swarm close` may copy for forensics but never deletes live or within-grace authority; eligible closed summaries compact separately | authoritative | **#2031** |

State classification legend: **authoritative** (the record IS the domain fact —
plan, evidence, background-delegation ownership, council verdict);
**operational** (telemetry/diagnostic signal, not a domain record);
**derived** (computed from, or a projection of, authoritative state);
**governed content** (knowledge/evidence artifacts subject to the repo's
existing knowledge-receipt and retention governance, not telemetry policy).

---

## 7. Legacy adapter rules

`src/observability/legacy.ts`, `LEGACY_ADAPTER_RULES` (exported as data, not
prose, so the CI check and the unit tests assert against the same statement of
intent the implementation follows):

1. **Preserve unknown fields.** An own key the contract does not recognize is
   kept under `legacy.extra` by reference and is never dropped.
2. **Record the source store and its schema version.** `sourceStore` names the
   file; `sourceSchemaVersion` is the version the store declares.
3. **Preserve originally reported values.** Values are aliased, never coerced,
   normalized, rounded, or re-serialized.
4. **Record timing confidence.** A time read by the writer at record time is
   `writer-clock`, never `exact`.
5. **Unknown is not zero.** The adapter lists in `legacy.unknown` every
   catalogued key the *producer* left `undefined`, and never itself defaults one
   to `0`, `""`, `false`, or `null`. The guarantee stops at the adapter
   boundary: a producer that pre-coerces its own defaults defeats it, because
   the adapter only ever sees the coerced value. The known instance is
   `delegation_end` (`src/telemetry.ts` `delegationEnd`, pre-existing and not
   introduced by this PR), which coerces `?? 0` / `?? null` /
   `?? 'unavailable'` before emitting — so its cost fields can never appear in
   `legacy.unknown`. There, `cost_source: 'unavailable'` is the field that keeps
   absence recoverable.
6. **Missing lineage stays missing.** An absent correlation ID stays
   `undefined` and is never synthesized to make a join succeed.
7. **Never drop unrecognized fields.** No allowlist filter is applied to the
   payload on the way through.

Two details worth stating explicitly because they are easy to get wrong by
analogy with other schema-versioning code in this repo:

- **`sourceSchemaVersion: null` means "this store does not version its
  records" — it does NOT mean version zero.** `.swarm/telemetry.jsonl` carries
  no version field at all; recording that absence as `0` would fabricate a
  fact the store never stated. `null` is a distinct value from `0` on the wire
  and in every consumer that checks it.
- **Missing lineage remains explicitly missing.** `legacy.unknown` lists the
  producer's known keys that were absent or `undefined` on the actual payload
  (`KNOWN_TELEMETRY_KEYS[kind]` in `legacy.ts:61-212`, derived from the emit
  call sites in source, not from captured output — a captured line
  under-reports a producer's key set because `JSON.stringify` elides
  `undefined` values). Nothing is ever backfilled to close a gap in
  `legacy.unknown`.

---

## 8. Sampling and bounded cardinality

`src/observability/sampling.ts`.

**Sampling** (`shouldSample(traceId, rate)`) is deterministic on the trace id:
the **last 8 hex characters** of `traceId` are read as an unsigned integer and
compared against `rate * 0xffffffff`. The same trace therefore samples
identically in every process, on every host, and across restarts — no shared
state, no RNG, no coordination. Fail-open by construction: every unusable input
(non-finite rate, malformed or short trace id) returns `true`, because dropping
an event for a malformed id would lose data silently, which is exactly the
failure mode this contract exists to prevent. `DEFAULT_SAMPLE_RATE = 1`
(sample everything) — this PR introduces no dropping.

> **Caveat — trace-coherent sampling is VACUOUS in this system today.**
> `createObservation` mints a **fresh** `traceId` per event, with `links: []`
> and no `parentSpanId`, so every event is its own single-span trace. At a rate
> below 1 the decision is therefore independent **per event**, not per logical
> trace — a trace never spans two events, so nothing can be kept whole or torn
> apart. Trace continuation (propagating one trace id across the events that
> belong together) is **#2047**'s work; only then does the determinism above
> buy a real property rather than a latent one. Nothing is dropped today
> regardless, because `DEFAULT_SAMPLE_RATE = 1`.

**Bounded cardinality** (`METRIC_LABEL_ALLOWLIST`, `assertBoundedCardinality`):
the only permitted metric labels today are `kind`, `category`, `severity`,
`outcome_status`, `cost_source`, `privacy_class`, `runtime`, `os`, `provider`,
`sampled` — a small, enumerable set that cannot grow with traffic.
`assertBoundedCardinality` additionally rejects any label matching an
identifier suffix (`/id$/i`) or a high-cardinality shape prefix
(`path|file|dir|repo|repository|user|session|task|trace|span`), or containing
`/`.

> **The rule: IDs, paths, users, tasks, and repositories belong in traces and
> logs, not metric labels.** A single unbounded label multiplies the
> time-series count by its cardinality and can take a metrics backend down;
> the trace already carries that detail, keyed to the same event.

---

## 9. OTel mapping pin

`src/observability/otel-mapping.ts` is an **inert lookup table** — no
OpenTelemetry SDK dependency, no exporter, no runtime consumer in this change.
It maps envelope paths onto two external vocabularies:

- `OTEL_GENAI_ATTRIBUTES` — OpenTelemetry GenAI semantic conventions, pinned at
  `OTEL_GENAI_MAPPING_VERSION = '1.29.0'`.
- `OPENINFERENCE_ATTRIBUTES` — OpenInference specification attributes, pinned
  at `OPENINFERENCE_MAPPING_VERSION = '0.1.14'`.

> **Both versions are pinned SEPARATELY from `OBSERVABILITY_SCHEMA_VERSION`
> (`src/observability/envelope.ts:21`).** This is the whole point of issue
> #2029 item 6: the GenAI and OpenInference conventions are external,
> still-unstable vocabularies. If they were versioned together with the
> internal envelope shape, an upstream rename would force a bump of the
> internal domain-state version and every consumer would be told the domain
> shape changed when nothing about the domain actually changed. **External
> convention churn must never change internal domain state.**

`mappingForEntry('none')` returns an empty, frozen table rather than
`undefined` — `'none'` is a real, recorded decision ("this kind has no
external equivalent"), not a missing value, so a consumer never has to
distinguish "no mapping" from "not asked." The runtime consumer of these
tables (an actual OTel/OpenInference exporter) is owned by **#2049**; here they
are consumed only as data, by the static contract check and by this document.

---

## 10. Known contract gaps found while building this

These are **findings recorded while building the catalog and the matrix**, not
bugs fixed in this PR. Each already has a named downstream owner in the
sequence #2030–#2051.

- **The `event:` vs `type:` discriminator split in `.swarm/events.jsonl`.**
  `src/context/role-filter.ts:147` and `src/tools/phase-complete.ts:1571` write `event:`; `src/hooks/curator.ts:1755` and `src/hooks/full-auto-intercept.ts:269`
  writes `type:` — the split exists *within a single file*. A generic
  consumer must check both keys or silently miss records. Owner: **#2039**.
- **Eight of ten named legacy stores have no schema version at all.** Only
  `knowledge-events.jsonl` (`schema_version`, default 1) and
  `background-delegations.jsonl` (`schemaVersion` 1\|2\|3) version their
  records; `.swarm/telemetry.jsonl`, `.swarm/context-telemetry.jsonl`,
  `.swarm/skill-usage.jsonl`, `.swarm/events.jsonl`,
  `knowledge-application.jsonl`, task-scoped trajectory, session-scoped
  trajectory, and `shell-audit.jsonl` cannot express "this record was written
  by an older writer." See §6 rows 1–4, 6–8, 10.
- **Epoch-ms vs ISO clock split.** `background-delegations.jsonl` stores
  `createdAt`/`updatedAt`/`completedAt` as epoch-ms **numbers**; every other
  inventoried JSONL store uses ISO-8601 **strings**. Joining across them
  requires a per-store conversion that no shared code owns today.
- **`phase_complete`, `auto_oversight`, and `context_filtered` carry no
  `sessionID`.** Verified at `src/tools/phase-complete.ts:1570-1578`,
  `src/hooks/full-auto-intercept.ts:269-278`, and
  `src/context/role-filter.ts:146-154`. Not backfilled here: issue #2029 item
  2 forbids manufacturing an ID to make a join succeed, and item 4 says
  missing lineage remains explicitly missing.
- **The guardrail audit log has no `callID`.** `src/hooks/guardrails/audit-log.ts:51-112`
  has no field matching the `callID` that `background-delegations.jsonl` uses
  as its join key (`pending-delegations.ts:84`), so a guardrail decision
  cannot be joined to the delegation it occurred inside. See §6 row 10.
- **`TrajectoryEntry` is declared twice, and the two declarations have
  drifted.** `src/hooks/trajectory-logger.ts:28-40` requires `tool`,
  `args_summary`, and `elapsed_ms`, and has a `verdict` field.
  `src/prm/types.ts:32-53` makes those three fields optional and has **no**
  `verdict` field. An earlier exploration lane's claim that the two
  declarations were identical was independently re-checked and refuted — see
  `.agents/issue-traces/2029-observability-event-contract/03-localization-log.md`
  §Verification of inferred claims.
- **`truncateTrajectoryIfNeeded` has no non-test caller.**
  `src/prm/trajectory-store.ts:164` is the definition; the only other hits are
  in `src/prm/__tests__/trajectory-store.test.ts`. Confirmed by a targeted
  grep sweep, not inferred.

---

## Related

- `docs/evidence-and-telemetry.md` — the user-facing description of the
  evidence and telemetry systems this contract formalizes the producer side of.
- `docs/engineering-invariants.md` — the invariant this PR establishes (search
  for issue #2029).
- `docs/releases/pending/2029-observability-event-contract.md` — the release
  note for this change.
- `.agents/issue-traces/2029-observability-event-contract/` — the full
  investigation trail (reproduction, root cause, localization, fix plan) that
  produced this contract.
