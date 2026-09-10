// This fixture intentionally terminates the child with a signal. The authority
// test skips the signal assertion on Windows, where Bun does not expose POSIX
// signal termination semantics.
process.kill(process.pid, 'SIGABRT');
