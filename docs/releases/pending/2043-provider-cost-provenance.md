---
category: Fixed
---

- Preserve bounded provider cost evidence and conflicts instead of selecting the first numeric field, fold append-only cost corrections without double-counting, and make monetary budget gates inconclusive when spend evidence is unavailable rather than treating it as zero.
- Configure optional `pricing.models` token rates to enable estimates; existing telemetry remains readable with `cost_source: "unavailable"` when pricing is absent. No migration or breaking configuration change is required.
