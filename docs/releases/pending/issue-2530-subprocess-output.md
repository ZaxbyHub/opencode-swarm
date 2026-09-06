# Bounded cross-runtime subprocess output

`bunSpawn` now starts bounded background capture for unclaimed piped stdout and
stderr. Node-hosted plugins can safely await process exit before reading output,
without child-process pipe backpressure causing a timeout or truncated result.

Buffered output is capped at 5 MiB per pipe by default. Calls can set a positive
safe-integer `maxBuffer`; an overflow terminates the child and reports a typed
`BunCompatOutputLimitError` consistently for both buffered output streams.
