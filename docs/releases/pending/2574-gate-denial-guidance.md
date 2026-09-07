# Gate-denial guidance stays action-specific (#2574)

## What changed

- Gate-denial streaks now use a bounded stable action projection that preserves
  task role, routing, scope, and target identity while ignoring retry-varying
  prompts and payload content.
- Structured gate causes are preferred when supplied as own data properties;
  generic `BLOCKED`, `WRITE BLOCKED`, and legacy sandbox prefixes remain
  unclassified.
- Hard-rung guidance and advisories identify only the exact action digest and
  offer diagnose, repair/rescope, handoff, abort, and Full-Auto exit choices.

## Why

Previously, distinct actions and denial causes could pool into one streak, and a
successful unrelated action could clear it. The hard guidance also told the
agent to stop all tool calls, obscuring safe recovery paths.

## Migration

No migration is required. The public tracker and circuit bounds remain
unchanged.
