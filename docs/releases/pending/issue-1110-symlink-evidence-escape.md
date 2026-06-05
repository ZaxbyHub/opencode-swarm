Evidence writes in `gate-evidence.ts` (`recordGateEvidence`, `recordAgentDispatch`) now resolve `.swarm/evidence` through symlinks via `realpathSync` before trusting the write path. A TOCTOU vulnerability was also fixed: the boundary check now runs inside the filesystem lock and uses the resolved canonical path for the actual write, preventing symlink-swap attacks between validation and write.

No migration required.
