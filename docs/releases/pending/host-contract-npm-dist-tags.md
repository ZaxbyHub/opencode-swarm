# Fix: the weekly host-contract check resolves the npm `latest` tag again

## What

`scripts/check-host-contract.ts` looked up the `latest` tag of
`@opencode-ai/plugin` by downloading the package's full npm document and
reading at most 1 MB of it. That document has grown past 27 MB with snapshot
and dev tags, so the bounded read gave up, no tag resolved, and every
scheduled run failed with `result=SOURCE_NOT_FOUND`, although the host
contract itself had not changed.

The check now reads the npm dist-tags endpoint, which is a few KiB, with a
64 KiB cap.

The dependency-freshness check in `scripts/drift-check.ts` (opt-in with
`SWARM_DEP_FRESHNESS_CHECK=1`) had the same pattern: it downloaded each
package's abbreviated npm document (2.3-2.5 MB, growing) and read it without
a size limit. It now reads the same dist-tags endpoint with the same bounded
read and 64 KiB cap.
