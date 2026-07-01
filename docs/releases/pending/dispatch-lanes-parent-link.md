# Link advisory lane sessions to their parent

## What

- `dispatch_lanes` and `dispatch_lanes_async` now pass the caller session as
  `parentID` when creating OpenCode child sessions.
- Lane sessions also receive readable titles derived from the lane id and agent.

## Why

Read-only advisory lanes were tracked correctly in swarm's pending-delegation
ledger, but OpenCode rendered them as top-level sessions because the native
session tree did not receive `parentID`.

## Impact

Advisory explorer/reviewer/critic lanes launched by swarm should now appear
nested under the architect session in OpenCode instead of as flat sessions.
