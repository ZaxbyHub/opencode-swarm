# Non-blocking incremental collection for lane dispatch

## What changed

The architect can now poll lane results incrementally while continuing independent work, instead of blocking on `collect_lane_results wait: true`. This applies to all lane types — explorer, reviewer, critic, and council agents.

### Code changes

- **Tool descriptions** (`src/tools/tool-metadata.ts`): Updated `dispatch_lanes_async` and `collect_lane_results` descriptions to expose both polling and blocking modes explicitly.
- **Skill documentation** (6 files): Added incremental collection patterns to all skills that dispatch lanes: `deep-dive`, `swarm-pr-review` (canonical + adapters), `council`, and `codebase-review-swarm`. Each skill preserves the settlement boundary — all lanes must be settled before synthesis or phase transitions.
- **Candidate format enforcement**: Added `[CANDIDATE]` row auto-injection for explorer lanes (`applyExplorerFormatSuffix`) and format mismatch detection (`detectFormatMismatchHint`) to prevent empty results when explorers emit prose instead of structured candidates.

### Test coverage

Added 10 new unit tests:
- 4 tests for `applyExplorerFormatSuffix` (role filtering, idempotence, prompt-length guards)
- 6 tests for `detectFormatMismatchHint` (severity keyword detection, case sensitivity, false-positive avoidance)

## How to use

When dispatching lanes with `dispatch_lanes_async`:

1. **Non-blocking polling** (new recommended pattern): After launching lanes, poll with `collect_lane_results` omitting `wait` or passing `wait: false`. Process any settled lanes immediately — extract candidates via `parse_lane_candidates`, call `retrieve_lane_output` for full text when `output_ref` is present, update your ledgers — then continue independent architect work (scope refinement, local reads, micro-lane prep).

2. **Blocking join** (when independent work is exhausted): Use `wait: true` only when all independent work is done and lanes are still pending, to avoid idle waiting.

3. **Settlement boundary**: Before synthesis or phase transitions, all lanes in a batch must be settled. Missing, failed, stale, or cancelled lanes are explicit coverage gaps — mark them `BLOCKED` or `SKIPPED_WITH_REASON`, do not silently ignore them.

**Example polling loop:**

```typescript
const batch = await dispatch_lanes_async(specs);
while (true) {
  const result = await collect_lane_results(batch.batch_id); // no wait parameter = non-blocking poll
  for (const lane of result.lane_results.filter((lane) => lane.status === 'completed')) {
    const text = await retrieve_lane_output(lane.output_ref);
    const candidates = parse_lane_candidates(text);
    // ... process candidates, update ledger ...
  }
  if (result.all_settled) break;
  // Continue independent work here (refinement, local reads, etc.)
}
```

## Migration

No breaking changes. Existing code using `wait: true` continues to work. The new pattern is purely additive — you can adopt non-blocking polling at your own pace.

## Known limitations

- `applyExplorerFormatSuffix` only applies to explorer-role lanes (not reviewers or critics), since only explorers emit candidates. Reviewers and critics produce verdicts.
- Format mismatch hint uses case-sensitive severity matching (CRITICAL, HIGH, MEDIUM, LOW, INFO) to avoid false positives on prose containing lowercase words like "high performance."

## Why

The architect often has legitimate independent work to do while lanes are running (refining scope, reading evidence, preparing validation). The old pattern forced idle waiting on `wait: true`. This change enables pipeline parallelism — candidate collection and evidence reading can overlap with lane processing, reducing overall task latency and improving responsiveness.
