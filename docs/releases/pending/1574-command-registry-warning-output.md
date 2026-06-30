# Command registry warnings no longer leak into the OpenCode UI

## What changed

Command-registry validation warnings now go through the debug logger instead of
printing directly to `console.warn()` during module load.

## Why

OpenCode surfaces plugin console warnings in the interactive UI. Non-fatal
command-registry alias warnings were therefore able to float over the input box
even though they were only diagnostic.

## Migration

No migration required. To inspect these warnings manually, run with
`OPENCODE_SWARM_DEBUG=1`.

## Known caveats

These validation warnings are now debug-only in normal operation. Fatal command
registry validation errors still throw during module load.
