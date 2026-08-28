---
category: Added
---

Add `bun run check:registry-citations`, a CI gate that stops `file:line` citations in `scripts/retention-registry.data.ts` from silently drifting. The structural arm hard-fails on citations naming a missing file, an out-of-bounds line range, or a malformed no-colon shape; the anchor arm checks that the identifier written next to a citation actually occurs in the cited lines, ratcheted against `scripts/registry-citation-baseline.json` so pre-existing drift is frozen and may only shrink. Pre-existing anchor drift in 40 other registry rows (111 citations, including five naming symbols that no longer exist anywhere in the file they cite) is frozen in that baseline so it is visible and can only shrink. It is not fixed wholesale here, with one exception: where this change already had to edit a citation line, the inaccuracy on that line was corrected rather than left standing.
