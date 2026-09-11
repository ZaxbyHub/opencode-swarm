// This fixture intentionally terminates the child with a signal. The authority
// test skips the signal assertion on Windows, where Bun does not expose POSIX
// signal termination semantics.
// `process.abort()` is intentionally synchronous. `process.kill(pid, 'SIGABRT')`
// can be deferred by the Bun test harness, causing the authority to classify a
// crashed child as a timeout on Linux CI.
process.abort();
