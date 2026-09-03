### CI: integration and smoke no longer wait behind the unit matrix

In merge-group runs the `integration` and `smoke` jobs were sequenced after
the 18-cell `unit` matrix even though they check out, install and run from
source and consume nothing from it. On a measured 59-minute merge-group run
that serialisation was a ~25-minute tail after `unit` finished. Both jobs now
start after `quality`, alongside the unit shards, following the same CI-004
pattern the repository already applies to coverage. Every required check
still has to pass; only the ordering changed. A test pins the new `needs`
lists. No configuration or migration changes.
