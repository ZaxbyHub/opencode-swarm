# Recover tier-L PR review lanes from host transport failures

Tier-L `swarm-pr-review` collection now recovers complete, provenance-bound lane artifacts even when the inline preview is truncated or the host status endpoint times out. Recovery remains fail-closed: a timed-out status is unknown rather than complete, terminal transcript proof is required, and only base/micro discovery lanes may salvage independently validated positive candidates from an incomplete transcript. Incomplete `CLEAN`, council, reviewer, and critic outputs require retry and cannot prove coverage or absence of findings.

The same hardening pass makes context enforcement provider-aware and auditable, keeps untracked agents out of pruning, distinguishes swarm injection footprint from whole-session usage, warns about undersized default model overrides without changing them, bounds explorer output, and clears the older bare OpenCode package-cache layout during install/update.
