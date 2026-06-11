Fixed `/swarm issue` and PR reference parsing to share a single URL-security helper module.
This keeps issue and PR command sanitization behavior in sync, hardens loopback/link-local
defense-in-depth checks, rejects control characters in owner/repo segments, and sanitizes
parse-error echoes before they are shown back to the caller.

No migration required.
