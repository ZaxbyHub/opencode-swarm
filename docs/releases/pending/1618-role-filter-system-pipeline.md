# Wire role-scoped context filtering into system injection

## What changed

- The production system-context pipeline now routes leading `[FOR: ...]`
  fragments through the shared role filter after all injectors run and before
  system messages are collapsed.
- Prefixed multi-swarm agent names continue to match their canonical roles.
- Untagged, malformed, and `[FOR: ALL]` system context remains available, and
  missing session identity fails open.

## Why

The role filter previously had unit coverage but no production caller. Its
historical system-prompt exemption also meant that simply invoking it on the
real `output.system` shape would not filter anything. As a result, targeted
system fragments could reach agents outside their intended roles.

## Compatibility

Existing direct callers retain their historical system-entry and metrics
behavior. The new chat hook intentionally omits metrics persistence so it does
not add synchronous filesystem I/O to the prompt-construction hot path.

Closes: #1618
