# `feat(knowledge)`: learning data plane — dedup hygiene, provenance, and shared immutable reports

## Summary

- `knowledge_add` now merges inferred tags with caller-supplied tags. Caller tags are kept first, so when the
  20-tag cap truncates, inferred tags are dropped before anything you asked for.
- Knowledge array fields (tags and the five actionability arrays) are now **deduplicated** before the 20-item
  cap is applied, at every site that builds them. Previously the cap was purely positional, so a run of
  duplicates could push distinct values off the end and silently lose them.
- Deduplication is also enforced on the knowledge **store write path** (`appendKnowledge`,
  `rewriteKnowledge`, and the `transactKnowledge` commit), so a call site that forgets to dedupe is corrected
  by the store rather than silently persisting duplicates. That is not a whole-repo guarantee: **four writers
  bypass it**, and the exclusions are deliberate rather than accidental. `applyConfidenceDeltas` re-persists
  exactly what the (intentionally un-normalized) read path returned, rewriting the whole file with raw
  `JSON.stringify`; `knowledge-validator.ts`'s quarantine/restore/unarchive and `hive-transaction.ts` relocate
  existing records rather than authoring new field values; and `knowledge/family-migration.ts` authors a new
  `tags` value on the cohort merge path, but caps and de-duplicates it **before** the write, so it no longer
  emits an over-cap list for the boundary to trim. All are listed under Known limitations below rather than
  glossed by a "regardless of which code path" claim.
- New `learning` and `consensus` configuration blocks, and a new
  `knowledge.promotion_require_actionable` setting.

## User-facing changes

- **Tags you pass to `knowledge_add` are preserved in order and de-duplicated**, and relevant tags inferred
  from the lesson text are appended. A lesson that previously stored `["ci","ci","ci"]` now stores `["ci"]`,
  leaving room under the cap for genuinely distinct tags.
- **Duplicate entries in `applies_to_agents`, `applies_to_tools`, `required_actions`, `forbidden_actions`,
  and `verification_checks` are collapsed.** Deduplication is case-insensitive and keeps the first
  occurrence's original casing.
- **Existing stored entries are normalized the next time they are written.** A legacy record holding more
  than 20 tags returns from its next transaction capped at 20. This is intentional — it is the same cap that
  has always applied to new writes — but it means an over-cap legacy record will lose its tail on the next
  update rather than keeping it indefinitely.
- `evidence_refs` recorded by the curator are likewise de-duplicated. Note this is case-insensitive, so
  `plan.md:42` and `PLAN.MD:42` collapse to one reference.

### Promotion now enforces an actionability floor

`/swarm promote` and every hive-promotion path now require a lesson to carry at least one **predicate**
(`--required-actions`, `--forbidden-actions`, `--verification-checks`) and at least one **scope**
(`--applies-to-tools`, `--applies-to-agents`) before it can reach hive knowledge. Previously a lesson could be
promoted as un-actionable prose that no agent could act on.

Those five flags are new on `/swarm promote` — before this change the direct-text path had no way to supply
actionability fields at all, so the floor would have been impossible to satisfy there. A related bug is fixed
in the same path: the direct-text promotion wrote its hive entry without carrying actionability fields
through, so even correctly-supplied predicates were dropped on write.

A lesson that fails the floor is **blocked**, not silently promoted. `--force --reason "<why>"` still
overrides and records a durable audited override naming the failed gate. Set
`knowledge.promotion_require_actionable = false` to restore the previous behavior.

### Near-duplicate knowledge entries are merged automatically

A bounded curator sweep (`learning.dedup_sweep.enabled`, default **true**) now collapses active
near-duplicate knowledge entries into one. It runs at each phase boundary and under `curator_analyze`.

It also runs under `/swarm curate`, but **not unconditionally** — the sweep is the last step of
`runCuratorPhase`, and `/swarm curate` reaches that only when it has a session id, when the next uncovered
phase is still within the plan's phase count, and when that phase has not already been digested. On a plan
whose phases are all covered, `/swarm curate` reports `knowledge_applied: 0` and returns without sweeping.
Phase boundaries and `curator_analyze` are the reliable triggers.

What it does to your store:

- The surviving entry **unions** the losers' actionability fields and `source_knowledge_ids` and **sums**
  their usage counters, so that evidence is combined rather than discarded.
- **Tags are unioned under the store's 20-tag cap**: the winner's tags are kept first, the losers' tags fill
  whatever slots remain, and duplicates are collapsed case-insensitively. **A winner already holding 20 tags
  therefore absorbs none of the losers' tags.** This is the same cap that has always applied to every
  knowledge write — the merge now applies it up front rather than emitting an over-cap list for the write
  boundary to trim silently. Because the losing entry is archived in the same transaction, tags that do not
  fit are not recoverable from the active store.
- Losers are **archived, not deleted** — each keeps its history and receives a tombstone through the shared
  invalidator, which also retires any generated skill that referenced it.
- The winner is chosen by actionability first, then confidence, then evidence weight, then age.
- Clustering is transitive: if A matches B and B matches C, all three collapse in a single pass rather than
  leaving C to be merged on the next sweep.
- It is bounded (`max_comparisons`, `max_merges_per_sweep`) and idempotent — a second sweep over an unchanged
  store is a byte-for-byte no-op.

Set `learning.dedup_sweep.enabled = false` to opt out.

### Lessons are now admitted mid-session, not only at phase boundaries

Previously the only in-session learning signal was a prompt nudge asking the architect to call
`knowledge_add`. Nothing validated or admitted anything until the phase boundary. Now a session-keyed queue
validates and admits (or rejects) candidates while the session is still running, so a lesson captured early
can be retrieved by a later delegation in the same session.

- Every budget is explicit and configurable under `learning.realtime_admission`: queue size, LLM calls,
  tokens, concurrency, retries, per-candidate timeout, and total drain wall time.
- The durable `.swarm/insight-candidates.jsonl` queue is unchanged and remains the backstop. If the
  real-time loop is disabled or the process crashes, phase-boundary curation still picks everything up —
  nothing is lost.
- Repeated PRM patterns are persisted only after they recur across genuinely distinct occurrences, with a
  cooldown, and they store **evidence pointers rather than reasoning text**.
- When real-time admission is active it supersedes the prompt-only nudge (`supersede_nudge`, default true).
  This supersedes the behavior described in the pending `hermes-style-realtime-learning-nudge` fragment.

Double-counting is prevented by identity rather than timing: an admitted candidate is marked in the entry's
`source_knowledge_ids`, and the phase-boundary fold-in skips anything already admitted. This matters because
re-confirming an entry is not a no-op — it raises confidence and counts toward automatic hive promotion, so a
duplicate would have silently inflated both.

### New `consensus_mine` tool (proposals only)

A new `consensus_mine` tool mines the evidence you already have — evaluation runs, gate audits, trajectories,
skill-usage/compliance records, knowledge outcomes, retros, and curated failures — into evidence-backed
*consensus attributes* and deduplicated improvement proposals.

**Curated failures** are the ninth source and the only one where every observation is a failure: lessons your
curator refused (`.swarm/knowledge-rejected.jsonl`), generated skill edits that lost their eval comparison
and were never activated (`.swarm/skills/rejected-edits.jsonl`), and each retrospective's own
`error_taxonomy` and `top_rejection_reasons`. That last one closes a real blind spot: retro entries are
written with `verdict: "pass"`, so a phase that reported `gate_evasion` used to enter the corpus as a single
clean passing observation and the miner never saw what the phase said went wrong. Both views are now kept —
the retro is still the passing artifact it is, and what it says failed now counts as counterexample evidence
on the same run.

`.swarm/knowledge-unactionable.jsonl` is deliberately **not** read. Its entries are structurally incomplete
lessons awaiting LLM hardening, not lessons judged wrong, and most of them are later promoted into the active
store — counting them as failures would score the queue's throughput rather than your agents' behavior.

Curated failures are read **last**, so under the default `max_evidence_items` of 50 they are frequently
dropped whole. That is deliberate — a rejected lesson carries its own run id and almost never aggregates past
`min_support`, so reading them first would burn the budget on observations that produce no finding. Raise
`max_evidence_items` or narrow the request when you want this arm to contribute.

It **mutates none of the evidence it reads**. It activates no skills, edits no knowledge, admits no durable
memory record, promotes nothing, touches no project file, and runs no optimization rounds.

It is not otherwise write-minimal, and the description the model reads now says so rather than claiming "two
things". A single run: writes its versioned immutable report under `.swarm/evolution/consensus/`; **deletes**
its own older reports past `consensus.report_retention` (default 50 — pruning runs after every mine, so on a
long-lived project the steady state is one deletion per run); rewrites the shared recommendation dedup ledger
whole, with FIFO eviction that can drop another producer's oldest entries; leaves one never-removed lock
sentinel per report id under `.swarm/locks/`; and, with `llm_summarization_enabled` (default `true`) and a
wired client, issues up to **20** `session.create` plus `session.prompt` calls. Under a knowledge link the
ledger lands in the shared cohort root, outside this project. A proposal whose text the ledger already holds
is counted as `recommendation_ledger.duplicate_recommendation_count` rather than re-recorded — the ledger key
is producer-agnostic, so that count includes the miner's own earlier emissions, not only other producers'.

**Where proposals land.** Reports are immutable artifacts, not an inbox to poll, so two surfaces make them
reachable. `/swarm status` prints `Consensus reports: <n>` under **Learning Queues** whenever the store is
non-empty, with the directory to open. And when `memory.enabled` is `true`, each proposal is additionally
mirrored into a **pending** swarm-memory proposal through the same `MemoryGateway.propose` path
`swarm_memory_propose` uses — curator review is still required, and no durable memory record is created — so
it shows up wherever memory proposals already do. The mirror is fail-open; whether it ran, and what it
produced, is reported back in the tool's `memory_mirror` block.

**When the ledger write fails, the tool says so.** The shared-ledger append is deliberately fail-open, so a
broken ledger path never costs you a mining run. It used to cost you the *information*: the result printed a
duplicate count of `0` beside `success: true`, indistinguishable from a clean run. The response now carries
`recommendation_ledger.degraded`, which is `true` exactly when nothing was recorded and nothing was compared.

Guarantees worth knowing:

- **Deterministic first.** All filtering, co-occurrence, support counting, and diversity math run before any
  model call. Summarization is optional; when it is unavailable or its output is rejected, the deterministic
  statement simply stands.
- **One anecdote is never a proposal.** An attribute supported by a single task (`taskDiversity < 2`) *or* by
  a single run (`support < 2`) is emitted as an investigation note with `proposedTarget: 'none'`. That second
  gate is independent of the `min_support` you request — `min_support: 1` is accepted — so both gates are now
  printed in the tool's `thresholds` block, sourced from the miner rather than restated.
- **Negative evidence is never silently dropped.** An attribute that counts failing runs is *rejected by the
  schema* unless it also carries counterexample references, so a finding can never be published with its
  counterexamples stripped. And when `max_evidence_items` truncates a source, the cut now alternates between
  failing and succeeding observations instead of taking a lexicographic prefix, which used to delete failures
  preferentially. Note the limit of that: the balance is struck per source, and once the budget is spent later
  sources are dropped whole, so a truncated report is a partial view — which is exactly why it now says so.
- **Reports are reproducible under the default configuration.** At a fixed `consensus` config and fixed
  thresholds, the same corpus and the same set of already-proposed fingerprints produce an identical
  `integrityHash` and therefore an identical `reportId`. Wall-clock fields are excluded from the hash, and so
  is the optional LLM restatement — `llm_summarization_enabled` defaults to `true`, so hashing a model's
  wording would have made re-running fabricate a difference every time. Changing any `consensus` setting does
  change the report id, by design: a report declares the configuration it was produced under.
- **The deterministic statement is never overwritten.** A model restatement is stored beside it as
  `llmSummary`, never in place of it.
- **Model output reaches disk only through a bounded whitelist.** Corpus assembly never reads prompts or
  reasoning traces at all. A restatement is accepted only from the first `FINDING:` line of one dispatch —
  everything else in the response is discarded — and only if it carries no bracket markup (`<think>`,
  `[think]`, `{think}`, `【think】`), no forged `[REDACTED:…]` marker, no reasoning markers, and — once decimal
  points and at most one lower-case-continued `e.g.`/`i.e.`/`etc.` are masked — no sentence terminator except
  a single trailing run, and fits the 600-character bound without being trimmed to fit. The
  terminator test is a whitelist and is not ASCII-only: it counts every character in Unicode's
  `Sentence_Terminal` property plus a hand-added ellipsis and leader family, so the CJK, fullwidth, Arabic,
  Indic, Armenian, Ethiopic, Khmer, Myanmar and Mongolian stops all count. What can reach disk is therefore at
  most one length-bounded, markup-free, marker-free sentence-shaped fragment per attribute, in a field
  excluded from the integrity hash that never displaces the deterministic statement.

  **The honest limitation, stated plainly:** a single grammatical sentence chained with commas, semicolons,
  colons, dashes, tabs, or the one permitted abbreviation can still read as a multi-step narration, and this
  guard does not stop that. Clause-final marks — which Unicode files under `Terminal_Punctuation`, a set that
  includes the comma — are deliberately not counted, because rejecting every restatement containing a comma
  is not a trade worth making; that leaves the chaining channel open by construction. Earlier drafts of this
  fragment said a multi-step trace could not be assembled; that was false, and no amount of extra terminator
  rules can make it true. What is guaranteed is the bound — one envelope line, one unmasked terminator run,
  600 characters, per attribute — not a judgement about what the admitted text means.
- **Excerpts are bounded and secret-redacted**, with redaction applied before the length bound. Unicode
  control *and* format characters are now collapsed to a space, so a bidi override (U+202E) cannot make a
  stored excerpt render as something other than the bytes actually stored, and a zero-width character cannot
  hide inside a token to disguise it. (Collapsed to a space rather than deleted, deliberately: deleting would
  let `[REDACTED<zero-width>:x]` close up into a forged redaction marker.)
- **The cuts that change a conclusion are declared on the report.** A persisted `truncation` block records
  whether the corpus was capped, how many observations were tallied, whether the `inputIds` list was cut, and
  how many attributes the 1000-attribute cap dropped — so a truncated report is no longer mistakable for a
  complete one. (Fixed per-attribute reference caps and per-source enumeration bounds are not counted there;
  see `docs/consensus-mining.md`.)

`modelDiversity` is `0` when no contributing observation carries a model id — that means "not measurable from
this corpus", not "measured as none", and never blocks emission on its own.

Note on re-running: mining twice over an unchanged corpus does **not** produce one report. The second run
dedupes its proposals against the first, so it legitimately has different content — zero proposals — and is
stored as a second report recording that nothing new was found. Once proposals are exhausted, further runs
converge on a single stable report id.

See `docs/consensus-mining.md`.

## Migration notes

No configuration change is *required* — the new `learning` and `consensus` blocks have working defaults, and
existing knowledge records load unchanged. But four behaviors change by default, so read these before
upgrading:

1. **Hive promotion is stricter.** `knowledge.promotion_require_actionable` defaults to `true`, so a lesson
   without a predicate and a scope is now **blocked** rather than promoted — including entries that
   previously promoted automatically. `--force --reason "<why>"` still overrides and records an audited
   override; set the key to `false` to restore the old behavior.
2. **Near-duplicate knowledge entries are now merged and archived automatically.** The curator sweep
   (`learning.dedup_sweep.enabled`, default `true`) runs at every phase boundary and under `curator_analyze`;
   under `/swarm curate` it runs only when that command actually reaches `runCuratorPhase` (see the caveat
   above). Losing entries are **archived**, not deleted: each gets a tombstone through the shared invalidator,
   which also retires any generated skill referencing it. Set `learning.dedup_sweep.enabled = false` to opt
   out.
3. **Lessons are now validated and admitted mid-session, and that costs model calls.**
   `learning.realtime_admission.enabled` defaults to `true` and is wired into the `Task` tool's after-hook
   with a live LLM delegate, so upgrading turns on a per-session budget of up to **20 LLM calls** and
   **50,000 tokens** (`max_llm_calls_per_session`, `max_tokens_per_session`) plus mid-session writes to
   `knowledge.jsonl`. The budget is a ceiling, not a floor — the drain only does work when the in-session
   candidate queue is non-empty — but on a busy session it is real spend that did not exist before. Set
   `learning.realtime_admission.enabled = false` to keep the previous phase-boundary-only behaviour; the
   durable `.swarm/insight-candidates.jsonl` queue remains the backstop either way.
4. **`/swarm link` and `/swarm unlink` merge entries differently.** The shared merge helper now unions
   actionability fields and `source_knowledge_ids`, recomputes `content_hash`, and bumps `revision` when a
   merge swaps in a longer lesson. The `revision` bump is deliberate — the old behavior left `content_hash`
   describing text the entry no longer held, which silently broke the compare-and-swap on every later
   curation of a merged entry. A CAS plan built against a pre-link snapshot will now correctly skip rather
   than apply against changed content.

## Known limitations

- Normalization runs on write, not on read, so an over-cap legacy record keeps its full tail until something
  next writes it.
- `src/knowledge/family-migration.ts` authors merged tag values and writes them through a path that bypasses
  the store-level normalizer. It now caps and de-duplicates them itself before writing, so a cohort merge no
  longer persists an over-cap tag list — but the corollary is that tags past the cap are dropped at merge
  time on the `/swarm link` path rather than surviving until a later transaction trims them.
- Three further writers bypass the store-level normalizer, deliberately. `applyConfidenceDeltas` — reached on
  every `phase_complete` via the skill-usage and knowledge-verdict feedback paths — rewrites the whole
  knowledge file with raw `JSON.stringify`, re-persisting exactly what the intentionally un-normalized read
  path returned; normalizing there would silently rewrite untouched historical records on a path whose only
  job is to bump a number. `knowledge-validator.ts`'s quarantine/restore/unarchive and `hive-transaction.ts`
  relocate existing records without authoring new field values.
- Each consensus mining run leaves an empty lock sentinel under `.swarm/locks/`, one per distinct report id,
  and nothing removes it. `proper-lockfile` cleans up its own lock directory; the sentinel file it needs in
  order to lock is created by `tryAcquireLock` and never deleted. It is a few bytes per report, but on a
  long-lived project the count grows without bound and is not covered by `consensus.report_retention`.
- One further instance of the same positional-cap pattern remains at `src/hooks/curator.ts` on
  `source_knowledge_ids` (cap 50). It is deliberately excluded: that field is used to carry
  deduplication markers, and capping or reordering it would break that mechanism.
- The curated-failure arm reads `.swarm/skills/rejected-edits.jsonl` at a fixed
  `<project>/.swarm/skills/` path. Unlike the knowledge stores it is not knowledge-link aware, so under a
  configured knowledge link this one source still reads the local project's file rather than the shared
  cohort root.
