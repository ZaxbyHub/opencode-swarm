### Fixed

- Added one bounded retry for transient `session.create` failures in blocking and asynchronous lane dispatch. Retry generations remain visible in immediate and collected results, timed-out late sessions are cleaned up, and duplicate correlation IDs cannot overwrite terminal ledger state. Prompt execution and native `Task` launches remain single-shot because the current OpenCode host API does not expose an idempotent replay primitive after execution may have started.
