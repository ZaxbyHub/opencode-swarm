Fixed `/swarm issue` and PR reference parsing to share a single URL-security helper module.
This keeps issue and PR command sanitization behavior in sync, hardens loopback/link-local
defense-in-depth checks, rejects control characters in owner/repo segments at parse time (for direct URL/shorthand inputs and for owner/repo parsed from git remotes), and sanitizes
parse-error echoes before they are shown back to the caller.

No migration required.
